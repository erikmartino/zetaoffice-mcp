#!/usr/bin/env node
/*
 * Fetch the ZetaOffice CDN wasm bundle and patch the Emscripten glue so it
 * works under Node.js:
 *
 *  1. honour a pre-set global `Module` (CJS module scope otherwise shadows it)
 *  2. provide a real `importScripts` for the office pthread (Emscripten's Node
 *     stub is an assert(false))
 *  3. don't fail pthread creation when there is no #qtcanvas / OffscreenCanvas
 *  4. carry transferred MessagePorts through worker_threads messages
 *  5. expose the MEMFS object as Module.__FS (so exports can be read in-thread)
 *
 * Usage: node lowa/prepare-cdn.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const CDN = path.join(here, 'cdn');
const BASE = process.env.ZETA_CDN || 'https://cdn.zetaoffice.net/zetaoffice_latest';
const FILES = ['soffice.js', 'soffice.wasm', 'soffice.data', 'soffice.data.js.metadata'];
const force = process.argv.includes('--force');

fs.mkdirSync(CDN, { recursive: true });

for (const f of FILES) {
  const dest = path.join(CDN, f);
  if (!force && fs.existsSync(dest)) continue;
  console.log(`[cdn] downloading ${f}`);
  execFileSync('curl', ['-sS', '--compressed', '-o', dest, `${BASE}/${f}`], { stdio: 'inherit' });
}

// soffice.js contains Emscripten glue written as CommonJS.
const pkg = path.join(CDN, 'package.json');
if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{"type":"commonjs"}\n');

const jsPath = path.join(CDN, 'soffice.js');
let src = fs.readFileSync(jsPath, 'utf8');

function patch(label, from, to, { firstOnly = false } = {}) {
  const count = src.split(from).length - 1;
  if (count === 0 || (!firstOnly && count !== 1)) {
    throw new Error(`[patch] ${label}: expected ${firstOnly ? '>=1' : '1'} match, found ${count}`);
  }
  src = firstOnly ? src.replace(from, to) : src.replace(from, to);
  console.log(`[patch] ${label}`);
}

patch(
  'global Module',
  'var Module=typeof Module!="undefined"?Module:{};',
  'var Module=globalThis.Module||{};',
  { firstOnly: true }
);

patch(
  'importScripts',
  'importScripts:()=>{assert(false,"dummy importScripts called")}',
  'importScripts:(u)=>{const _fs=require("fs");let _code;' +
    'if(u.startsWith("data:")){_code=Buffer.from(u.slice(u.indexOf(",")+1),"base64").toString("utf8")}' +
    'else{const _p=u.startsWith("file:")?new URL(u):u;_code=_fs.readFileSync(_p,"utf8")}' +
    '(0,eval)(_code)}'
);

patch(
  'pthread canvas (missing)',
  'if(!canvas){err(`pthread_create: could not find canvas with ID "${name}" to transfer to thread!`);error=28;break}',
  'if(!canvas){err(`pthread_create: no canvas for "${name}", continuing without transfer`);continue}'
);

patch(
  'pthread canvas (transfer)',
  '}catch(e){err(`pthread_create: failed to transfer control of canvas "${name}" to OffscreenCanvas! Error: ${e}`);return 28}',
  '}catch(e){err(`pthread_create: canvas transfer skipped for ${name}: ${e}`);offscreenCanvasInfo=null}'
);

patch(
  'worker ports',
  'parentPort.on("message",data=>onmessage({data:data}))',
  'parentPort.on("message",data=>{const _ports=data&&data.__emscripten_ports;' +
    'if(_ports){delete data.__emscripten_ports;onmessage({data:data,ports:_ports})}' +
    'else{onmessage({data:data})}})'
);

if (!src.includes('Module.__FS=FS')) {
  src += '\n;Module.__FS=FS;\n';
  console.log('[patch] expose FS');
}

fs.writeFileSync(jsPath, src);
console.log(`[cdn] ready in ${CDN}`);
