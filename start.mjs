#!/usr/bin/env node
/**
 * Zero-setup entry point for the ZetaOffice MCP server.
 *
 * On first run it installs the Node dependencies and downloads the ZetaOffice
 * WASM bundle, then starts the MCP stdio server. Configuration only needs:
 *
 *   node /path/to/zetaoffice-mcp/start.mjs
 *
 * Logs go to stderr so stdout stays clean JSON-RPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (message) => console.error(`[zetaoffice] ${message}`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: here,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function ensureDependencies() {
  if (fs.existsSync(path.join(here, 'node_modules', '@modelcontextprotocol', 'sdk'))) return;
  log('first run: installing Node dependencies...');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ]);
}

function ensureWasmBundle() {
  if (fs.existsSync(path.join(here, 'lowa', 'cdn', 'soffice.js'))) return;
  log('first run: downloading the ZetaOffice WASM bundle (~250 MB)...');
  run(process.execPath, [path.join(here, 'lowa', 'prepare-cdn.mjs')]);
}

try {
  ensureDependencies();
  ensureWasmBundle();
} catch (err) {
  console.error(`[zetaoffice] setup failed: ${err.message}`);
  console.error('[zetaoffice] Check your network connection and run this command again.');
  process.exit(1);
}

if (process.env.ZETAOFFICE_PREPARE_ONLY === '1') {
  log('setup complete');
  process.exit(0);
}

await import('./mcp_stdio_server.mjs');
