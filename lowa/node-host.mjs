#!/usr/bin/env node
/*
 * EXPERIMENTAL Node.js host for a headless LOWA build with proxied POSIX
 * sockets. It is a skeleton: it shows the exact wiring points, but running it
 * requires the wasm build to be Emscripten "node"-environment capable
 * (worker_threads pthreads) and to emit a loadable module. Validate against
 * your actual build output and adjust.
 *
 * Env:
 *   LOWA_OUT          dir containing soffice.js/.wasm/.data
 *   UNO_WS_PROXY      ws URL of websocket_to_posix_proxy (default ws://127.0.0.1:6932)
 *   UNO_ACCEPT_PORT   host URP TCP port to accept on (default 2002)
 *   START_PROXY       "1" to spawn the host proxy automatically
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || ".";
const BUILD = process.env.LOWA_OUT || path.join(HOME, "lowa-build/core/workdir/installation/LibreOffice/emscripten");
const PROXY_URL = process.env.UNO_WS_PROXY || "ws://127.0.0.1:6932";
const ACCEPT_PORT = process.env.UNO_ACCEPT_PORT || "2002";

if (!fs.existsSync(path.join(BUILD, "soffice.js"))) {
  console.error(`[node-host] soffice.js not found in ${BUILD}. Build LOWA first (lowa/build.sh).`);
  process.exit(1);
}

if (process.env.START_PROXY === "1") {
  const proxyBin = path.join(HOME, "lowa-build/websocket_to_posix_proxy");
  console.log(`[node-host] starting ${proxyBin} 6932`);
  const proxy = spawn(proxyBin, ["6932"], { stdio: "inherit" });
  process.on("exit", () => { try { proxy.kill(); } catch {} });
}

// The Emscripten glue expects a global `Module`. For Node it must also be told
// to use worker_threads for pthreads (only if the build has ENVIRONMENT=node).
globalThis.Module = {
  // Proxied POSIX sockets: every socket()/connect()/bind()/listen()/accept()
  // is tunnelled to websocket_to_posix_proxy over this URL.
  uno_websocket_to_posix_socket_url: PROXY_URL,

  // Scripts evaluated inside the LOWA/UNO thread. zeta.js first, then a small
  // boot script that hosts the URP acceptor (see thread-boot.js).
  uno_scripts: [
    path.join(BUILD, "zeta.js"),
    path.join(here, "thread-boot.js"),
  ],

  locateFile: (p) => path.join(BUILD, p),
  print: (s) => console.log("[lowa]", s),
  printErr: (s) => console.error("[lowa]", s),

  // Node pthreads: Emscripten uses worker_threads when built for node.
  // If your build is web-only, this will not work and you need a Node-enabled
  // rebuild (add `node` to Emscripten's ENVIRONMENT for the LO wasm target).
};

console.log(`[node-host] loading ${BUILD}/soffice.js`);
try {
  await import(pathToFileURL(path.join(BUILD, "soffice.js")).href);
} catch (err) {
  console.error("[node-host] failed to load soffice.js:", err.message);
  process.exit(1);
}

// Once the module is ready, zeta.js exposes Module.zetajs. The thread-boot.js
// script runs inside LOWA and can call:
//
//   const css = jetajs.uno.com.sun.star;   // (zetajs)
//   const acceptor = css.connection.Acceptor.create(zetajs.getUnoComponentContext());
//   const conn = acceptor.accept('socket,host=0.0.0.0,port=2002');
//   const bridge = css.bridge.BridgeFactory.createBridge('', 'urp', conn, zetajs.getUnoComponentContext());
//
// Any UNO client then connects to localhost:2002 via normal URP.
