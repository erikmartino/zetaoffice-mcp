#!/usr/bin/env node
/*
 * Node.js host for the LibreOffice Wasm (LOWA) runtime.
 *
 * Replaces the headless-Chrome runner: the same `public/office_thread.js` MCP
 * worker runs inside a worker_threads pthread, and this process speaks the
 * bridge's WebSocket protocol (see public/index.html) to server.mjs.
 *
 * Requirements: run `node lowa/prepare-cdn.mjs` once to fetch and patch the
 * ZetaOffice CDN bundle.
 *
 * Usage: node lowa/node-runtime.mjs [--headless]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker, MessagePort, isMainThread, workerData } from 'node:worker_threads';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const CDN = path.join(here, 'cdn');
const PUBLIC_DIR = path.join(here, '..', 'public');
const require = createRequire(import.meta.url);
const isPthread = !isMainThread && workerData === 'em-pthread';

const WS_URL = process.env.LOWA_WS_URL || 'ws://127.0.0.1:8765/ws';
const log = (...a) => console.error('[node-runtime]', ...a);

if (!fs.existsSync(path.join(CDN, 'soffice.js'))) {
  log(`missing ${CDN}/soffice.js — run: node lowa/prepare-cdn.mjs`);
  process.exit(1);
}

// ── Browser API shims ────────────────────────────────────────────────────────
// Emscripten's data loader uses XHR even in Node.
class NodeXHR {
  constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; }
  open(_method, url) { this._url = url; this.readyState = 1; }
  overrideMimeType() {}
  send() {
    let text = '';
    let status = 404;
    try {
      const p = this._url.startsWith('file:') ? fileURLToPath(this._url) : this._url;
      text = fs.readFileSync(p, 'utf8');
      status = 200;
    } catch (e) { /* keep 404 */ }
    this.responseText = text;
    this.status = status;
    this.readyState = 4;
    // Asynchronous, like the browser, so run-dependency bookkeeping works.
    setImmediate(() => {
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
    });
  }
}
globalThis.XMLHttpRequest = NodeXHR;

// worker_threads only delivers transferred MessagePorts when they are part of
// the message value. The LOWA C++ side passes them in the transfer list only.
const origPostMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (value, transferList) {
  if (transferList && transferList.length) {
    const ports = transferList.filter((x) => x instanceof MessagePort);
    if (ports.length) value = Object.assign({}, value, { __emscripten_ports: ports });
  }
  return origPostMessage.call(this, value, transferList);
};

// The GUI build looks up #qtcanvas; without a canvas we run it headless.
const fakeCanvas = {
  id: 'qtcanvas', width: 1024, height: 768, style: {},
  getContext: () => null,
  addEventListener() {}, removeEventListener() {},
};
globalThis.document = {
  baseURI: 'file://' + process.cwd() + '/',
  currentScript: null,
  body: { appendChild() {}, style: {} },
  documentElement: { style: {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  addEventListener() {}, removeEventListener() {},
};
Object.defineProperty(fakeCanvas, 'ownerDocument', { value: globalThis.document });
if (globalThis.navigator && !('clipboard' in globalThis.navigator)) {
  try {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText() {} },
      configurable: true,
    });
  } catch { /* ignore */ }
}

// ── Boot LOWA ────────────────────────────────────────────────────────────────
const Module = {
  print: (s) => console.error('[lowa]', s),
  printErr: (s) => console.error('[lowa:err]', s),
  locateFile: (p) => path.join(CDN, p),
  mainScriptUrlOrBlob: fileURLToPath(import.meta.url),
  uno_scripts: [
    path.join(PUBLIC_DIR, 'zetajs', 'zeta.js'),
    path.join(here, 'node-wrap.js'),
  ],
};
globalThis.Module = Module;
globalThis.__zetaHelperUrl = 'file://' + path.join(PUBLIC_DIR, 'zetajs', 'zetaHelper.js');

const M = require(path.join(CDN, 'soffice.js'));
globalThis.Module = M;

if (isPthread) {
  // Emscripten's pthread bootstrap takes over from here.
} else {
  startMain();
}

// ── Host side: WebSocket bridge ──────────────────────────────────────────────
function startMain() {
  let ws = null;
  let thrPort = null;
  let readySent = false;
  let pendingReady = false;

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      log('websocket connected to', WS_URL);
      if (readySent) send({ type: 'ready', info: 'LOWA node runtime', runtime: 'node' });
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw instanceof ArrayBuffer) {
        const buf = Buffer.from(raw);
        const id = buf.readUInt32BE(0);
        const data = new Uint8Array(buf.subarray(4));
        if (thrPort) thrPort.postMessage({ cmd: 'urp_bytes', id, data });
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'mcp_request') {
        if (thrPort) {
          thrPort.postMessage({ cmd: 'mcp_exec', id: msg.id, tool: msg.tool, params: msg.params });
        } else {
          send({ type: 'mcp_response', id: msg.id, result: { success: false, error: 'ZetaJS Worker thread not ready' } });
        }
      } else if (msg.type === 'urp_open') {
        if (thrPort) thrPort.postMessage({ cmd: 'urp_open', id: msg.id });
      } else if (msg.type === 'urp_close') {
        if (thrPort) thrPort.postMessage({ cmd: 'urp_close', id: msg.id });
      } else if (msg.type === 'uno_request') {
        handleUnoRequest(msg);
      }
    });

    ws.on('close', () => {
      log('websocket closed; reconnecting in 3s');
      setTimeout(connect, 3000);
    });
    ws.on('error', (e) => log('websocket error:', e.message));
  }

  function handleUnoRequest(msg) {
    const uno = msg.payload || {};
    if (uno.op === 'readFile' || uno.op === 'writeFile') {
      try {
        const FS = M.__FS;
        if (!FS || typeof FS.readFile !== 'function') throw new Error('Wasm filesystem is not available');
        let value;
        if (uno.op === 'writeFile') {
          const bytes = Buffer.from(uno.data || '', 'base64');
          FS.writeFile(uno.path, new Uint8Array(bytes));
          value = { path: uno.path, bytes: bytes.length };
        } else {
          const bytes = FS.readFile(uno.path);
          value = { data: Buffer.from(bytes).toString('base64'), bytes: bytes.length };
        }
        send({ type: 'uno_response', id: msg.id, ok: true, v: value });
      } catch (e) {
        send({ type: 'uno_response', id: msg.id, ok: false, e: { msg: e.message || String(e) } });
      }
      return;
    }
    if (thrPort) {
      thrPort.postMessage(Object.assign({}, uno, { cmd: 'uno_exec', id: msg.id }));
    } else {
      send({ type: 'uno_response', id: msg.id, ok: false, e: { msg: 'ZetaJS Worker thread not ready' } });
    }
  }

  M.uno_main
    .then((port) => {
      log('office channel established');
      thrPort = port;
      port.onmessage = (event) => {
        const data = event && event.data;
        if (!data) return;
        if (data.cmd === 'mcp_reply') {
          let result = data.result;
          if (result && result.__save_file && !result.encoding) {
            // The document is serialized into the main runtime's Wasm FS.
            const info = result.__save_file;
            try {
              const bytes = M.__FS.readFile(info.fs_path);
              try { M.__FS.unlink(info.fs_path); } catch { /* best effort */ }
              result.encoding = 'base64';
              result.data = Buffer.from(bytes).toString('base64');
              result.bytes = bytes.length;
            } catch (e) {
              log('could not read exported document:', e.message);
            }
          }
          if (result && result.__save_file) delete result.__save_file;
          send({ type: 'mcp_response', id: data.id, result });
        } else if (data.cmd === 'uno_reply') {
          send({ type: 'uno_response', id: data.id, ok: data.ok, v: data.v, e: data.e });
        } else if (data.cmd === 'mcp_ready') {
          pendingReady = true;
          markReady(data.info);
        } else if (data.cmd === 'mcp_error') {
          log('office error:', data.error);
        } else if (data.cmd === 'urp_out') {
          if (ws && ws.readyState === WebSocket.OPEN && data.data && data.data.length) {
            const frame = Buffer.allocUnsafe(4 + data.data.length);
            frame.writeUInt32BE(data.id >>> 0, 0);
            frame.set(data.data, 4);
            ws.send(frame);
          }
        } else if (data.cmd === 'urp_log') {
          log('[URP]', data.message);
        }
      };

      port.postMessage({
        cmd: 'ZetaHelper::run_thr_script',
        threadJs: 'file://' + path.join(PUBLIC_DIR, 'office_thread.js'),
        threadJsType: 'module',
      });
    })
    .catch((e) => {
      log('fatal: office channel failed:', e);
      process.exit(1);
    });

  function markReady(info) {
    if (readySent) return;
    readySent = true;
    // runtime:"node" lets server.mjs prefer this client over browser tabs,
    // whose cached worker code can lag behind a bridge restart.
    send({ type: 'ready', info: info || 'LOWA node runtime ready', runtime: 'node' });
    log('ready:', info || 'LOWA node runtime');
  }

  // If the worker handshake is slow, still announce readiness once connected.
  setTimeout(() => { if (pendingReady) markReady(); }, 500);

  connect();
}
