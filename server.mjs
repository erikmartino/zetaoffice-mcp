import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = parseInt(process.env.LIBREOFFICE_PORT || process.env.PORT || '8765', 10);

// Build identity for /health, so benchmark runs can detect a stale bridge.
const BUILD_COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch (e) { return null; }
})();
const STARTED_AT = new Date().toISOString();

const IS_HEADLESS = process.argv.includes('--headless') ||
  process.env.HEADLESS === 'true' ||
  process.env.HEADLESS === '1' ||
  process.env.LIBREOFFICE_HEADLESS === 'true' ||
  process.env.LIBREOFFICE_HEADLESS === '1';

// Run the Wasm runtime directly under Node.js (worker_threads) instead of
// launching a headless Chrome runner.
const IS_NODE_RUNTIME = process.argv.includes('--node') ||
  process.env.LOWA_NODE === '1' ||
  process.env.LOWA_NODE === 'true';

// Reported by /health and the CLI banner. Node mode is not "browser" mode:
// it runs the Wasm engine in worker_threads and needs no Chrome at all.
const MODE = IS_NODE_RUNTIME ? 'node' : IS_HEADLESS ? 'headless' : 'browser';

const AUTO_OPEN_BROWSER = process.argv.includes('--browser') ||
  process.argv.includes('--open') ||
  process.env.AUTO_OPEN_BROWSER === 'true' ||
  process.env.AUTO_OPEN_BROWSER === '1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

// Track active browser Wasm sessions
let headlessProcess = null;
let headlessTmpDir = null;
const pendingRequests = new Map();
const connectedClients = new Set();
// External UNO-over-WebSocket RPC clients (kept separate from browser clients).
const pendingUno = new Map();
const UNO_TIMEOUT_MS = parseInt(process.env.UNO_TIMEOUT_MS || '120000', 10);
let unoReqCounter = 0;

// ── Standard UNO URP socket relay ────────────────────────────────────────────
// The real "UNO socket" lives on the HOST (here). Each accepted TCP connection
// carries raw URP bytes; we frame them (4-byte big-endian connection id + bytes)
// inside binary WebSocket frames to the browser, which relays them to the Wasm
// worker's C++ urpPush()/urpPull() conduit. Node never parses URP.
const urpSockets = new Map();        // id -> net.Socket
const urpBacklog = new Map();        // id -> Buffer[] queued until a browser is up
let urpConnSeq = 1;
const URP_TCP_PORT = process.env.UNO_TCP_PORT ? parseInt(process.env.UNO_TCP_PORT, 10) : null;

function frameUrp(id, payload) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(id >>> 0, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function urpToBrowser(id, payload) {
  const client = getActiveClient();
  if (!client) {
    const q = urpBacklog.get(id) || [];
    q.push(Buffer.from(payload));
    urpBacklog.set(id, q);
    return;
  }
  client.send(frameUrp(id, payload), { binary: true });
}

function flushUrpBacklog() {
  const client = getActiveClient();
  if (!client) return;
  for (const [id, chunks] of urpBacklog) {
    for (const chunk of chunks) client.send(frameUrp(id, chunk), { binary: true });
  }
  urpBacklog.clear();
}

function startUrpTcpServer(port) {
  const server = net.createServer((socket) => {
    const id = urpConnSeq++;
    urpSockets.set(id, socket);
    console.log(`[URP] UNO client connected (id=${id}) from ${socket.remoteAddress}`);
    const client = getActiveClient();
    if (client) client.send(JSON.stringify({ type: 'urp_open', id }));
    socket.on('data', (data) => urpToBrowser(id, data));
    socket.on('error', () => {});
    socket.on('close', () => {
      urpSockets.delete(id);
      urpBacklog.delete(id);
      const c = getActiveClient();
      if (c) c.send(JSON.stringify({ type: 'urp_close', id }));
      console.log(`[URP] UNO client disconnected (id=${id})`);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[URP] Standard UNO socket listening on 127.0.0.1:${port} (urp)`);
  });
}

function getActiveClient() {
  const arr = Array.from(connectedClients).filter((c) => c.readyState === 1);
  // Prefer a visible, booted browser tab: the point of open_browser is that the
  // user watches MCP edits render on the canvas. The headless Node runtime is
  // only a fallback for autonomous runs with no browser attached.
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].__isBrowser && arr[i].__officeReady) return arr[i];
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].__isNodeRuntime) return arr[i];
  }
  return arr.length ? arr[arr.length - 1] : null;
}

function getReadyBrowserClient() {
  const arr = Array.from(connectedClients).filter((c) => c.readyState === 1);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].__isBrowser && arr[i].__officeReady) return arr[i];
  }
  return null;
}

function getNodeRuntimeClient() {
  const arr = Array.from(connectedClients).filter((c) => c.readyState === 1);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].__isNodeRuntime) return arr[i];
  }
  return null;
}

// One Wasm instance per session. Switching instances mid-document makes handles
// and documents diverge (a model created on one worker means nothing on the
// other), so pick once and stick to it until it disconnects.
let sessionClient = null;

async function pickSessionClient() {
  if (sessionClient && sessionClient.readyState === 1) return sessionClient;
  const browser = getReadyBrowserClient();
  if (browser) {
    try {
      // current workers understand uno_live; older cached pages do not
      const probe = await requestOnClient(browser, 'uno_live', { op: 'root' }, 4000);
      if (probe && probe.success) {
        sessionClient = browser;
        return browser;
      }
      console.log('[MCP] Browser tab runs older worker code; using the node runtime for this session');
    } catch (e) {
      console.log('[MCP] Browser tab probe failed; using the node runtime');
    }
  }
  sessionClient = getNodeRuntimeClient() || getActiveClient();
  return sessionClient;
}

// Send one MCP tool call to one specific Wasm host and await its reply.
function requestOnClient(target, tool, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!target || target.readyState !== 1) {
      reject(new Error('Target Wasm session is not connected'));
      return;
    }
    const reqId = 'sync_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const timeout = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(reqId, { resolve, reject, timeout, responded: false });
    target.send(JSON.stringify({ type: 'mcp_request', id: reqId, tool, params }));
  });
}

// Mirror the canonical document from the headless Node runtime into a browser
// tab that just became ready. Without this, "create a document, then open the
// browser" would show an empty welcome page because the Wasm instances are
// independent.
async function syncDocumentToBrowser(browserWs) {
  if (!browserWs || browserWs.__isNodeRuntime) return;
  // Mirror from the worker that owns the session document, not blindly from the
  // Node runtime: document create/embed may have happened on a browser tab.
  const source = (sessionClient && sessionClient !== browserWs && sessionClient.readyState === 1)
    ? sessionClient
    : getNodeRuntimeClient();
  if (!source) return;
  try {
    const info = await requestOnClient(source, 'get_document_info_live', {}, 15000).catch(() => null);
    const type = (info && info.type) || 'writer';
    // Only a Writer document can be judged empty by character count; Calc and
    // Impress documents report 0 characters even when they hold data.
    if (type === 'writer' && info && info.character_count === 0) return;
    const format = { writer: 'odt', calc: 'ods', impress: 'odp', draw: 'odg' }[type] || 'odt';
    const exported = await requestOnClient(source, 'export_document_live', { format }, 25000);
    if (!exported || !exported.data) {
      console.log('[Sync] No document data from the Node runtime; skipping mirror');
      return;
    }
    const loaded = await requestOnClient(browserWs, 'load_document_live', { data: exported.data, format }, 30000);
    if (loaded && loaded.success) {
      console.log(`[Sync] Mirrored ${exported.bytes || 0} bytes into the browser tab (${type})`);
    } else {
      console.log('[Sync] Browser could not display the mirrored document:', loaded && loaded.error);
    }
  } catch (e) {
    console.log('[Sync] Mirror skipped:', e.message);
  }
}

// Find Chrome/Chromium executable on the current OS
function findChromeBinary() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const candidates = [];
  if (process.platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else if (process.platform === 'win32') {
    const prefixes = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']];
    for (const p of prefixes) {
      if (p) {
        candidates.push(path.join(p, 'Google/Chrome/Application/chrome.exe'));
        candidates.push(path.join(p, 'Chromium/Application/chrome.exe'));
      }
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const cmd = process.platform === 'win32'
      ? 'where chrome'
      : 'which google-chrome-stable || which google-chrome || which chromium';
    const found = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim().split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch {}

  return null;
}

// Spawn headless Chrome runner for automated background Wasm execution
function spawnHeadlessRunner(url) {
  if (headlessProcess) return headlessProcess;

  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    console.warn(`[Headless] Warning: No Chrome/Chromium binary found. Please open ${url} in your browser.`);
    return null;
  }

  try {
    headlessTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lowa-headless-'));
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--no-first-run',
      `--user-data-dir=${headlessTmpDir}`,
      url
    ];

    console.log(`[Headless] Launching background Wasm runner: ${chromeBin}`);
    headlessProcess = spawn(chromeBin, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    headlessProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Fatal') || msg.includes('Crash')) {
        console.error(`[Headless Error] ${msg.trim()}`);
      }
    });

    headlessProcess.on('exit', (code, signal) => {
      console.log(`[Headless] Runner exited (code: ${code}, signal: ${signal})`);
      headlessProcess = null;
      cleanupHeadlessTmpDir();
    });

    return headlessProcess;
  } catch (err) {
    console.error(`[Headless] Failed to spawn runner: ${err.message}`);
    return null;
  }
}

function cleanupHeadlessTmpDir() {
  if (headlessTmpDir && fs.existsSync(headlessTmpDir)) {
    try {
      fs.rmSync(headlessTmpDir, { recursive: true, force: true });
    } catch {}
    headlessTmpDir = null;
  }
}

function stopHeadless() {
  if (headlessProcess) {
    try {
      headlessProcess.kill('SIGTERM');
    } catch {}
    headlessProcess = null;
  }
  cleanupHeadlessTmpDir();
}

// Fetch the ZetaOffice WASM bundle on first run (no manual prepare step).
function ensureNodeBundle() {
  const soffice = path.join(__dirname, 'lowa', 'cdn', 'soffice.js');
  if (fs.existsSync(soffice)) return true;
  console.log('[Node] WASM bundle missing; downloading it (first run, ~250 MB)...');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'lowa', 'prepare-cdn.mjs')], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (r.status !== 0) {
    console.error('[Node] Could not prepare the WASM bundle. Check your network connection and retry.');
    return false;
  }
  return true;
}

// Spawn the Wasm runtime directly under Node.js (no browser at all).
function spawnNodeRuntime(url) {
  if (headlessProcess) return headlessProcess;
  if (!ensureNodeBundle()) return null;

  const runtime = path.join(__dirname, 'lowa', 'node-runtime.mjs');
  if (!fs.existsSync(runtime)) {
    console.error(`[Node] Runtime not found: ${runtime}`);
    return null;
  }

  const wsUrl = url.replace(/^http/, 'ws') + '/ws';
  console.log(`[Node] Launching Wasm runtime under Node.js: ${runtime}`);

  headlessProcess = spawn(process.execPath, [runtime, '--headless'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOWA_WS_URL: wsUrl },
  });

  headlessProcess.stdout.on('data', (d) => process.stdout.write(`[Node] ${d}`));
  headlessProcess.stderr.on('data', (d) => process.stderr.write(`[Node] ${d}`));

  headlessProcess.on('exit', (code, signal) => {
    console.log(`[Node] Runtime exited (code: ${code}, signal: ${signal})`);
    headlessProcess = null;
  });

  return headlessProcess;
}

// Open URL in interactive desktop browser
function openDesktopBrowser(url) {
  let cmd;
  let args = [url];

  if (process.platform === 'darwin') {
    cmd = 'open';
  } else if (process.platform === 'win32') {
    cmd = 'cmd.exe';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
  }

  try {
    const cp = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    cp.unref();
    cp.on('error', () => {
      const fallback = findChromeBinary() || 'firefox';
      try {
        const fbCp = spawn(fallback, [url], { detached: true, stdio: 'ignore' });
        fbCp.unref();
      } catch {}
    });
    return true;
  } catch (e) {
    console.error(`[Browser] Failed to launch ${cmd}:`, e.message);
    return false;
  }
}

process.on('exit', () => { stopHeadless(); });
process.on('SIGINT', () => { stopHeadless(); process.exit(0); });
process.on('SIGTERM', () => { stopHeadless(); process.exit(0); });

let shuttingDown = false;
// Graceful shutdown, optionally re-exec'ing the bridge after it exits. Used by
// the /quit and /restart endpoints so development does not need kill -9.
function shutdown(restart = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(restart ? '[Bridge] Restarting...' : '[Bridge] Shutting down...');
  stopHeadless();
  for (const client of connectedClients) {
    try { client.terminate(); } catch (e) { /* ignore */ }
  }
  try { wss.close(); } catch (e) { /* ignore */ }
  try { unoWss.close(); } catch (e) { /* ignore */ }
  const finish = () => {
    if (restart) {
      try {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'ignore',
          cwd: process.cwd(),
          env: { ...process.env, ZETA_START_DELAY_MS: '800' },
        });
        child.unref();
      } catch (e) {
        console.error('[Bridge] Restart failed:', e.message);
      }
    }
    process.exit(0);
  };
  server.close(finish);
  setTimeout(finish, 800);
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Cross-Origin Isolation headers required for SharedArrayBuffer / Wasm pthreads
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- MCP API Endpoints ---
  if (pathname === '/health') {
    const client = getActiveClient();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      server: 'ZetaJS Wasm MCP Bridge',
      version: '1.0.0',
      // True only for an office-ready browser tab, not for the Node runtime.
      browser_connected: !!getReadyBrowserClient(),
      // True when any office-ready Wasm host is attached (browser or Node).
      runtime_connected: !!client,
      node_runtime: !!getNodeRuntimeClient(),
      connected_clients: connectedClients.size,
      mode: MODE,
      headless_running: !!headlessProcess,
      commit: BUILD_COMMIT,
      started_at: STARTED_AT,
      pid: process.pid,
      url: `http://localhost:${PORT}`
    }));
    return;
  }

  // Clean shutdown / restart for development (no kill -9, no orphan runtimes).
  if (pathname === '/quit' || pathname === '/restart') {
    const restart = pathname === '/restart';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: restart ? 'Restarting the bridge' : 'Shutting down the bridge',
      restart,
      url: `http://localhost:${PORT}`
    }));
    setTimeout(() => shutdown(restart), 150);
    return;
  }

  // Trigger desktop browser window
  if ((pathname === '/tools/open_browser_live' || pathname === '/open_browser') && (req.method === 'POST' || req.method === 'GET')) {
    const baseUrl = `http://localhost:${PORT}`;
    const forceNewTab = parsedUrl.searchParams.get('force') === '1';
    // Wait briefly for an already-open tab to finish booting; otherwise open a
    // fresh one. The cache-busting query makes desktop browsers create a new tab
    // even when the plain URL is already open in a stale one.
    let waited = 0;
    while (!forceNewTab && waited < 6000 && !getReadyBrowserClient()) {
      await new Promise((r) => setTimeout(r, 250));
      waited += 250;
    }
    const alreadyConnected = !forceNewTab && !!getReadyBrowserClient();
    let opened = true;
    const url = alreadyConnected ? baseUrl : `${baseUrl}/?t=${Date.now()}`;
    if (!alreadyConnected) opened = openDesktopBrowser(url);
    while (waited < 26000 && !getReadyBrowserClient()) {
      await new Promise((r) => setTimeout(r, 250));
      waited += 250;
    }
    const browserConnected = !!getReadyBrowserClient();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: opened,
      message: opened
        ? (browserConnected
            ? `Opened ${baseUrl} in your desktop browser`
            : `Launched ${baseUrl}; waiting for the browser tab to finish booting`)
        : `Failed to launch desktop browser for ${baseUrl}`,
      url: baseUrl,
      mode: MODE,
      browser_connected: browserConnected,
      browser_already_open: alreadyConnected,
      waited_ms: waited
    }));
    return;
  }

  if (pathname === '/' && req.headers.accept?.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: 'ZetaJS Wasm MCP Bridge',
      version: '1.0.0',
      status: 'running',
      mode: MODE,
      endpoints: ['/health', '/tools', '/tools/:tool_name', '/open_browser']
    }));
    return;
  }

  if (pathname === '/tools' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tools: [
        { name: 'create_document_live', description: 'Create a new Writer or Impress document via ZetaJS UNO' },
        { name: 'insert_text_live', description: 'Insert text into the active document via ZetaJS UNO' },
        { name: 'format_text_live', description: 'Format text properties via ZetaJS UNO' },
        { name: 'get_text_content_live', description: 'Retrieve document text content via ZetaJS UNO' },
        { name: 'get_document_info_live', description: 'Get document statistics and title via ZetaJS UNO' },
        { name: 'insert_formula_live', description: 'Insert a native LibreOffice Math object (embedded OLE formula)' },
        { name: 'list_formulas_live', description: 'List embedded Math formulas and their StarMath source' },
        { name: 'update_formula_live', description: 'Rewrite the StarMath source of an embedded formula' },
        { name: 'delete_formula_live', description: 'Remove an embedded Math formula' },
        { name: 'insert_picture_live', description: 'Insert an inline picture (graphic object) from base64 bytes' },
        { name: 'open_browser_live', description: 'Open live document in desktop browser' }
      ]
    }));
    return;
  }

  if (pathname.startsWith('/tools/') && req.method === 'POST') {
    const toolName = pathname.replace('/tools/', '');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let params = {};
      try {
        if (body.trim()) params = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      // Optional ?target=node|browser pins the request to one Wasm host. The
      // visible tab is otherwise preferred; node is useful to build documents
      // headlessly and mirror them later.
      const target = (parsedUrl.searchParams.get('target') || '').toLowerCase();
      const client = target === 'node' ? getNodeRuntimeClient()
        : target === 'browser' ? getReadyBrowserClient()
        : await pickSessionClient();
      if (!client) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'No active ZetaOffice Wasm session connected.',
          status: 'no_session',
          suggestion: IS_NODE_RUNTIME
            ? 'The Node runtime is still booting (the first boot loads ~150 MB of Wasm). Retry in a few seconds; check the [Node] log lines for errors.'
            : `Open http://localhost:${PORT} in a browser, or restart the bridge with --node to run the Wasm runtime inside Node.`
        }));
        return;
      }

      const reqId = 'req_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(reqId);
          reject(new Error('Timed out waiting for a ZetaJS UNO response (30s)'));
        }, 30000);

        pendingRequests.set(reqId, { resolve, reject, timeout, responded: false });
      });

      // Dispatch to the active (most recent) Wasm session
      console.log(`[MCP] ${toolName} -> ${client.__isNodeRuntime ? 'node runtime' : client.__isBrowser ? 'browser tab' : 'client'}`);
      client.send(JSON.stringify({
        type: 'mcp_request',
        id: reqId,
        tool: toolName,
        params
      }));

      try {
        let result = await promise;
        // A stale browser tab can answer "not implemented" for tools the
        // current worker has. Retry that call on the headless Node runtime
        // instead of failing the operation.
        if (result && result.success === false && /not implemented/i.test(result.error || '')) {
          const node = getNodeRuntimeClient();
          if (node && node !== client) {
            console.log(`[MCP] ${toolName}: active client lacks the tool; retrying on the node runtime`);
            try {
              result = await requestOnClient(node, toolName, params, 30000);
              if (result && result.success !== false) sessionClient = node;
            } catch (e) {
              console.log(`[MCP] ${toolName}: node retry failed: ${e.message}`);
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: err.message,
          suggestion: 'The UNO call may still be running in the Wasm runtime. Retry, or check the runtime log if it keeps timing out.'
        }));
      }
    });
    return;
  }

  // --- Static Files Delivery ---
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Normalize and prevent directory traversal
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found: ' + pathname);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Setup WebSocket servers: /ws = browser Wasm host, /uno = external UNO RPC clients.
// Both use noServer so a single upgrade listener can route by path (two WSS attached
// to the same HTTP server would abort each other's handshakes).
const wss = new WebSocketServer({ noServer: true });
const unoWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  } catch {}
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/uno') {
    unoWss.handleUpgrade(req, socket, head, (ws) => unoWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  console.log(`[WebSocket] New browser tab connected from ${req.socket.remoteAddress}`);
  connectedClients.add(ws);
  // Re-open any URP connections that arrived before the wasm host was ready.
  for (const id of urpSockets.keys()) {
    ws.send(JSON.stringify({ type: 'urp_open', id }));
  }
  flushUrpBacklog();

  ws.on('message', (message, isBinary) => {
    // Binary frames carry raw URP bytes going back out to a host UNO client.
    if (isBinary) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
      if (buf.length >= 4) {
        const id = buf.readUInt32BE(0);
        const sock = urpSockets.get(id);
        if (sock && !sock.destroyed) sock.write(buf.subarray(4));
      }
      return;
    }
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'ready') {
        if (data.runtime === 'node') {
          ws.__isNodeRuntime = true;
        } else {
          ws.__isBrowser = true;
          // A tab running an older cached page never reports office_ready.
          // Nudge it to reload once so it picks up the current bridge code.
          setTimeout(() => {
            if (ws.readyState === 1 && !ws.__officeReady) {
              try { ws.send(JSON.stringify({ type: 'reload' })); } catch (e) { /* ignore */ }
            }
          }, 15000);
        }
        console.log(`[ZetaJS] ZetaOffice UNO Engine ready in browser: ${data.info || 'OK'}`);
      } else if (data.type === 'office_ready') {
        ws.__isBrowser = true;
        if (data.reconnect) {
          // A reconnecting page keeps whatever worker code it loaded. Probe it:
          // if it predates uno_live (or the current bridge), reload it once so
          // the session cannot route to a stale worker.
          ws.__officeReady = false;
          requestOnClient(ws, 'uno_live', { op: 'root' }, 4000)
            .then((result) => {
              if (result && result.success) {
                ws.__officeReady = true;
                console.log('[ZetaJS] Reconnected tab has current worker code');
              } else {
                try { ws.send(JSON.stringify({ type: 'reload' })); } catch (e) { /* ignore */ }
              }
            })
            .catch(() => {
              try { ws.send(JSON.stringify({ type: 'reload' })); } catch (e) { /* ignore */ }
            });
        } else {
          ws.__officeReady = true;
          console.log(`[ZetaJS] Browser Wasm worker ready: ${data.info || 'OK'}`);
          // Only push the canonical document into freshly booted tabs.
          syncDocumentToBrowser(ws);
        }
      } else if (data.type === 'mcp_response') {
        const pending = pendingRequests.get(data.id);
        if (pending && !pending.responded) {
          pending.responded = true;
          clearTimeout(pending.timeout);
          pendingRequests.delete(data.id);
          pending.resolve(data.result);
        }
      } else if (data.type === 'uno_response') {
        const pending = pendingUno.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingUno.delete(data.id);
          if (pending.ws.readyState === 1) {
            pending.ws.send(JSON.stringify({
              id: pending.clientId,
              ok: data.ok,
              v: data.v,
              e: data.e
            }));
          }
        }
      } else if (data.type === 'log') {
        console.log(`[Browser Console] ${data.message}`);
      }
    } catch (e) {
      console.error('[WebSocket] Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Browser tab disconnected');
    connectedClients.delete(ws);
    if (sessionClient === ws) sessionClient = null;
  });
});

// External UNO RPC clients: forward each request to the active browser host and
// relay the reply back. Node only brokers (no UNO semantics here).
unoWss.on('connection', (ws, req) => {
  console.log(`[UNO] Client connected from ${req.socket.remoteAddress}`);

  ws.on('message', (message) => {
    let req;
    try {
      req = JSON.parse(message.toString());
    } catch (e) {
      return;
    }
    const client = getActiveClient();
    if (!client) {
      ws.send(JSON.stringify({ id: req.id, ok: false, e: { msg: 'No active ZetaOffice Wasm session connected' } }));
      return;
    }
    const reqId = 'u_' + (++unoReqCounter);
    const timeout = setTimeout(() => {
      pendingUno.delete(reqId);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ id: req.id, ok: false, e: { msg: `UNO RPC timed out after ${UNO_TIMEOUT_MS}ms` } }));
      }
    }, UNO_TIMEOUT_MS);
    pendingUno.set(reqId, { ws, clientId: req.id, timeout });
    client.send(JSON.stringify({ type: 'uno_request', id: reqId, payload: req }));
  });

  ws.on('close', () => {
    console.log('[UNO] Client disconnected');
  });
});

// Delay startup when re-exec'ing from /restart so the old process releases the port.
if (process.env.ZETA_START_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.ZETA_START_DELAY_MS) || 0));
}

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`
============================================================
🚀 ZetaJS Wasm MCP Bridge running!
------------------------------------------------------------
📍 Mode:                    ${IS_NODE_RUNTIME ? 'Node.js runtime (worker_threads)' : IS_HEADLESS ? 'Headless (Background Chrome Runner)' : 'Interactive Browser'}
📍 Browser UI & Wasm Host:  ${url}
📍 MCP API Endpoint:        ${url}/tools
📍 Health Check:            ${url}/health

${IS_NODE_RUNTIME ? '🟢 Node.js mode active: starting the Wasm runtime in-process...' : IS_HEADLESS ? '🤖 Headless mode active: starting silent background Wasm runner...' : '👉 Open ' + url + ' in your browser to view the live canvas.'}
============================================================
`);

  if (URP_TCP_PORT) {
    startUrpTcpServer(URP_TCP_PORT);
  }

  if (IS_NODE_RUNTIME) {
    spawnNodeRuntime(url);
  } else if (IS_HEADLESS) {
    spawnHeadlessRunner(url);
  } else if (AUTO_OPEN_BROWSER) {
    console.log(`[Browser] Automatically launching desktop browser: ${url}`);
    openDesktopBrowser(url);
  }
});
