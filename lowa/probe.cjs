#!/usr/bin/env node
/*
 * Probe: can the ZetaOffice LOWA wasm runtime boot directly under Node.js
 * (worker_threads pthreads) instead of a headless browser?
 *
 * Run:  node lowa/probe.cjs
 */
const path = require('path');
const fs = require('fs');
const { workerData, isMainThread } = require('worker_threads');

// Emscripten's data-package loader fetches soffice.data.js.metadata over XHR
// even in Node. A tiny file-backed shim is enough.
class NodeXHR {
  constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; }
  open(_method, url) { this._url = url; this.readyState = 1; }
  overrideMimeType() {}
  send() {
    try {
      const p = this._url.startsWith('file:') ? require('url').fileURLToPath(this._url) : this._url;
      this.responseText = fs.readFileSync(p, 'utf8');
      this.status = 200;
      console.log('[xhr] loaded', p, this.responseText.length);
    } catch (e) {
      console.log('[xhr] failed', this._url, e.message);
      this.status = 404;
    }
    this.readyState = 4;
    // Asynchronous, like the browser, so Emscripten's run-dependency logic works.
    setImmediate(() => {
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
    });
  }
}
globalThis.XMLHttpRequest = NodeXHR;

const wt = require('worker_threads');
// worker_threads delivers transferred MessagePorts only when they are part of
// the message value; Emscripten passes them in the transfer list only. Shuttle
// them through the payload so the LOWA channel survives.
const origPostMessage = wt.Worker.prototype.postMessage;
wt.Worker.prototype.postMessage = function (value, transferList) {
  if (transferList && transferList.length) {
    const ports = transferList.filter((x) => x instanceof wt.MessagePort);
    if (ports.length) value = Object.assign({}, value, { __emscripten_ports: ports });
  }
  return origPostMessage.call(this, value, transferList);
};
const CDN = path.join(__dirname, 'cdn');
const PUBLIC = path.join(__dirname, '..', 'public');
const isPthread = !isMainThread && workerData === 'em-pthread';

// Scripts evaluated inside the office (pthread) thread by LOWA's runUnoScriptUrl.
const Module = {
  print: (s) => console.log('[lowa]', s),
  printErr: (s) => console.error('[lowa:err]', s),
  locateFile: (p, prefix) => { const r = path.join(CDN, p); console.log('[locateFile]', p, '->', r); return r; },
  mainScriptUrlOrBlob: __filename,
  uno_scripts: [
    path.join(PUBLIC, 'zetajs', 'zeta.js'),
    path.join(__dirname, 'node-wrap.js'),
  ],
};
// Minimal DOM canvas stub: the GUI build expects a #qtcanvas even when we
// never render. Keeps document/canvas lookups from throwing in Node.
function makeFakeCanvas(id) {
  const ctx = new Proxy({}, {
    get: (_t, name) => {
      if (name === 'canvas') return null;
      if (name === 'getParameter') return () => 0;
      if (name === 'getExtension') return () => null;
      if (name === 'getShaderPrecisionFormat') return () => ({ precision: 23, rangeMin: 127, rangeMax: 127 });
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
      return () => ({});
    },
  });
  const canvas = {
    id, width: 1024, height: 768, style: {},
    clientWidth: 1024, clientHeight: 768,
    ownerDocument: null,
    getContext: () => ctx,
    addEventListener() {}, removeEventListener() {}, focus() {},
    setAttribute() {}, getAttribute: () => null,
    appendChild() {}, remove() {},
    transferControlToOffscreen() { return canvas; },
  };
  return canvas;
}
const fakeCanvas = makeFakeCanvas('qtcanvas');
const fakeDoc = {
  baseURI: 'file://' + process.cwd() + '/',
  currentScript: null,
  body: { appendChild() {}, style: {}, classList: { add() {}, remove() {} } },
  documentElement: { style: {}, classList: { add() {}, remove() {} } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeFakeCanvas(''),
  addEventListener() {}, removeEventListener() {},
};
fakeCanvas.ownerDocument = fakeDoc;
globalThis.document = fakeDoc;
globalThis.navigator = globalThis.navigator || { userAgent: 'node', clipboard: { writeText() {} } };
globalThis.__zetaHelperUrl = 'file://' + path.join(PUBLIC, 'zetajs', 'zetaHelper.js');
globalThis.Module = Module;

const M = require(path.join(CDN, 'soffice.js'));
globalThis.Module = M;

if (isPthread) {
  console.log('[probe] pthread worker started');
} else {
  console.log('[probe] main: soffice.js loaded');
  M.uno_init.then(() => console.log('[probe] uno_init resolved')).catch((e) => console.error('[probe] uno_init', e));
  M.uno_main
    .then((port) => {
      console.log('[probe] uno_main resolved');
      port.onmessage = (e) => {
        const d = e.data || {};
        if (d.cmd) console.log('[probe] office msg:', d.cmd, d.info || '', d.result ? JSON.stringify(d.result).slice(0,300) : '');
      };
      port.postMessage({
        cmd: 'ZetaHelper::run_thr_script',
        threadJs: 'file://' + path.join(PUBLIC, 'office_thread.js'),
        threadJsType: 'module',
      });
      setTimeout(() => {
        console.log('[probe] sending a test request after boot');
        port.postMessage({
          cmd: 'mcp_exec',
          id: 1,
          tool: 'get_document_info_live',
          params: {},
        });
      }, 15000);
      setTimeout(() => {
        console.log('[probe] done (exiting)');
        process.exit(0);
      }, 30000);
    })
    .catch((e) => console.error('[probe] uno_main error', e));
}
