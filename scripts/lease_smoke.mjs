#!/usr/bin/env node
/*
 * Smoke test for MCP leases and bridge idle exit.
 *
 *   node scripts/lease_smoke.mjs
 *
 * Runs a bare bridge (browser mode, no Wasm runtime) on a private port, so it
 * exercises the HTTP lease protocol and the actual MCP heartbeat without
 * loading the ~250 MB Wasm bundle.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function request(port, pathname, body) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

async function health(port) {
  return (await request(port, '/health'))?.json || null;
}

async function waitFor(fn, timeoutMs, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function startBridge(port, idleMs, ttlMs = 600) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LIBREOFFICE_PORT: String(port),
      ZETA_BRIDGE_IDLE_MS: String(idleMs),
      ZETA_BRIDGE_LEASE_TTL_MS: String(ttlMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.bridgeLog = () => log;

  const ready = await waitFor(async () => (await health(port))?.status === 'healthy', 5000);
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`bridge did not start on ${port}:\n${log}`);
  }
  return child;
}

async function withBridge(idleMs, fn, ttlMs = 600) {
  const port = await freePort();
  const child = await startBridge(port, idleMs, ttlMs);
  try {
    await fn(port, child);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child, 3000);
    }
  }
}

async function main() {
  console.log('lease smoke');

  // 1. Disabled by default: nothing exits just because no MCP is connected.
  await withBridge(0, async (port) => {
    const before = await health(port);
    check('idle exit is opt-in', before?.idle_exit_ms === 0, before);
    await sleep(1500);
    const after = await health(port);
    check('bridge stays up when ZETA_BRIDGE_IDLE_MS=0', after?.status === 'healthy', after);
  });

  // 2. A live lease wins over the grace period. The TTL is deliberately longer
  //    than the wait; the MCP heartbeat covers this in production.
  await withBridge(1200, async (port, child) => {
    const lease = await request(port, '/lease', { id: 'live', pid: process.pid, label: 'smoke' });
    check('lease registers', lease?.json?.success === true && lease.json.leases === 1, lease?.json);

    await sleep(2000);
    const alive = await health(port);
    check('live lease prevents idle exit', alive?.status === 'healthy' && alive.leases === 1, alive);

    await request(port, '/unlease', { id: 'live' });
    const code = await waitForExit(child, 6000);
    check('bridge exits after the last lease is released', code === 0, { code, log: child.bridgeLog() });
  }, 10000);

  // 3. A lease whose MCP process died is pruned.
  await withBridge(1200, async (port, child) => {
    await request(port, '/lease', { id: 'dead', pid: 999999, label: 'dead' });
    const code = await waitForExit(child, 6000);
    check('dead MCP lease is pruned', code === 0, { code, log: child.bridgeLog() });
  });

  // 4. An interactive browser host keeps the bridge alive even without an MCP.
  await withBridge(800, async (port, child) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'ready', runtime: 'browser' }));

    await sleep(1600);
    const alive = await health(port);
    check('browser host prevents idle exit', alive?.status === 'healthy', alive);

    ws.close();
    const code = await waitForExit(child, 6000);
    check('bridge exits after the browser disconnects', code === 0, { code, log: child.bridgeLog() });
  });

  // 5. The real MCP process leases the bridge and releases it on exit.
  await withBridge(2000, async (port, child) => {
    const base = `http://127.0.0.1:${port}`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'start.mjs')],
      env: {
        ...process.env,
        LIBREOFFICE_URL: base,
        LIBREOFFICE_TARGET: 'node',
        ZETA_BRIDGE_IDLE_MS: '2000',
        ZETA_BRIDGE_LEASE_TTL_MS: '600',
        ZETA_BRIDGE_LEASE_HEARTBEAT_MS: '500',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'lease-smoke', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'bridge', arguments: { action: 'status' } });
      const text = result.content?.find((part) => part.type === 'text')?.text || '';
      const status = JSON.parse(text);
      check('MCP tool call leases the bridge', status.status === 'healthy' && status.leases === 1, status);

      await sleep(3000);
      const alive = await health(port);
      check('MCP lease keeps the bridge alive past the grace period', alive?.status === 'healthy' && alive.leases === 1, alive);
    } finally {
      await client.close();
    }

    const code = await waitForExit(child, 10000);
    check('bridge exits after the MCP process disconnects', code === 0, { code, log: child.bridgeLog() });
  });

  // 6. Restart detaches the bridge; the MCP must re-lease the replacement and
  //    that detached bridge must still expire after the MCP goes away.
  {
    const port = await freePort();
    const first = await startBridge(port, 2000);
    const base = `http://127.0.0.1:${port}`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'start.mjs')],
      env: {
        ...process.env,
        LIBREOFFICE_URL: base,
        LIBREOFFICE_TARGET: 'node',
        ZETA_BRIDGE_IDLE_MS: '2000',
        ZETA_BRIDGE_LEASE_TTL_MS: '600',
        ZETA_BRIDGE_LEASE_HEARTBEAT_MS: '500',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'lease-restart-smoke', version: '1.0.0' });
    let newPid = null;

    try {
      await client.connect(transport);
      await client.callTool({ name: 'bridge', arguments: { action: 'status' } });

      const restarted = await client.callTool({ name: 'bridge', arguments: { action: 'restart' } });
      const restartedJson = JSON.parse(
        restarted.content?.find((part) => part.type === 'text')?.text || '{}'
      );
      check('bridge restart succeeds with a lease', restartedJson.success === true, restartedJson);

      await waitFor(async () => {
        const current = await health(port);
        return current?.pid && current.pid !== first.pid;
      }, 5000);
      const afterRestart = await health(port);
      newPid = afterRestart?.pid;
      check('restarted bridge has a new PID', !!newPid && newPid !== first.pid, {
        first: first.pid,
        restarted: newPid,
      });
      check('MCP re-leases after restart', afterRestart?.leases === 1, afterRestart);

      await sleep(3000);
      const alive = await health(port);
      check('renewed lease prevents idle exit', alive?.status === 'healthy', alive);
    } finally {
      await client.close();
      if (first.exitCode === null) {
        first.kill('SIGTERM');
        await waitForExit(first, 3000);
      }
    }

    const exited = await waitFor(() => !isAlive(newPid), 10000, 200);
    check('detached restarted bridge exits after the MCP disconnects', exited, { pid: newPid });
    if (isAlive(newPid)) {
      try { process.kill(newPid, 'SIGTERM'); } catch {}
    }
  }

  console.log(failures ? `\n${failures} lease check(s) failed` : '\nall lease checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
