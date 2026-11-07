/* -*- Mode: JS; tab-width: 2; indent-tabs-mode: nil; fill-column: 100 -*- */
// SPDX-License-Identifier: MIT
// Runs inside the LOWA/UNO thread (listed in Module.uno_scripts after zeta.js).
// Hosts a standard UNO URP acceptor on a proxied POSIX socket, so any language
// with UNO bindings can connect via `uno:socket,host=...,port=...;urp;`.
//
// Requires a headless LOWA build with --enable-emscripten-proxy-posix-sockets
// and a running websocket_to_posix_proxy (see README.md). EXPERIMENTAL.

(function () {
  const ACCEPT = (globalThis.UNO_ACCEPT || 'socket,host=0.0.0.0,port=2002');

  function boot() {
    const zetajs = globalThis.Module && globalThis.Module.zetajs;
    if (!zetajs || typeof zetajs.then !== 'function') return false;
    zetajs.then((z) => {
      try {
        const css = z.uno.com.sun.star;
        const ctx = z.getUnoComponentContext();
        const acceptor = css.connection.Acceptor.create(ctx);
        const conn = acceptor.accept(ACCEPT);
        const bridge = css.bridge.BridgeFactory.createBridge('', 'urp', conn, ctx);
        console.log('[thread-boot] URP acceptor listening on ' + ACCEPT + ' -> bridge ' + bridge);
      } catch (e) {
        console.error('[thread-boot] failed to host URP acceptor:', e);
      }
    });
    return true;
  }

  // Module.zetajs is created by zeta.js once uno_init resolves.
  const t = setInterval(() => { if (boot()) clearInterval(t); }, 100);
})();
