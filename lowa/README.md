# Headless LibreOffice Wasm with proxied POSIX sockets

Goal: a **headless LOWA** build (`--disable-gui`) with
`--enable-emscripten-proxy-posix-sockets`, so the wasm LibreOffice can open
real sockets (proxied to the host over WebSocket by
`websocket_to_posix_proxy`). That is the path to a **standard UNO URP listener**
inside wasm:

```
native UNO client (Java/C++/…)
  │  TCP  uno:socket,host=localhost,port=N;urp;StarOffice.ComponentContext
  ▼
websocket_to_posix_proxy (host process)  ⇄  WebSocket  ⇄  wasm POSIX sockets
                                                          └─ SocketAcceptor + com.sun.star.bridge
```

## Recommended route: native in-memory URP endpoint (no sockets in wasm)

Rather than proxying real POSIX sockets into wasm, add a **native C++ memory
connection** and drive it from JS with opaque bytes. This avoids the unmerged
Emscripten socket fixes and never opens a socket inside wasm.

```
any UNO client
  │  TCP  uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext
  ▼
Node bridge (server.mjs, UNO_TCP_PORT=2002)      ← the real "UNO socket"
  │  WebSocket binary frames: 4-byte id + raw URP bytes
  ▼
headless Chrome (index.html)                      ← relays WS <-> worker
  │  MessagePort
  ▼
office_thread.js  →  Module.urpOpen/Push/Pull/Close   (Embind, bytes only)
  ▼
urp_memory_bridge.cxx (MemoryConnection : XConnection)
  → com.sun.star.bridge.BridgeFactory.createBridge("", "urp", conn, provider)
  → LibreOffice's own binaryurp runs the protocol
```

- The connection is **C++**, so the bridge's reader `osl::Thread` blocks on a
  `std::condition_variable` and never calls into JS (the reason a JS
  `unoObject` `XConnection` failed).
- JS only pushes/pulls opaque bytes — **no UNO interfaces in JavaScript**.
- Patch: [`urp_memory_bridge.cxx`](urp_memory_bridge.cxx). Add it to the LOWA
  wasm target (it is already `--bind`/Embind enabled) and rebuild. Then use the
  stock `server.mjs` relay with `UNO_TCP_PORT=2002`.

The transport plumbing (Node TCP socket + WS binary relay + worker pump) is
already implemented in `../server.mjs`, `../public/index.html`, and
`../public/office_thread.js`.

## Alternative route: `--enable-emscripten-proxy-posix-sockets`

## ⚠️ Resource requirements (why this usually can't run on a laptop)

| Resource | Needed | Typical laptop |
| --- | --- | --- |
| RAM (link step) | tens of GB (README says ~64 GB) | 16–32 GB |
| Disk | ~60–120 GB | 50–250 GB |
| Time | hours | — |
| Toolchain | Emscripten with the socket fixes (below) | — |

If you don't meet these, use the **Docker** route in the LibreOffice `static/README.wasm.md`
(lode/docker), or a large CI runner.

## Emscripten requirement

`network.md` (zetajs) notes the proxy needs an emsdk carrying:
- emscripten PR #22432 — *getsockopt mismatch in websocket_to_posix_proxy* (**open**)
- emscripten PR #22433 — *getsockname size fix* (**open**)
- `-sPROXY_POSIX_SOCKETS: Add websocket_proxy_poll` (stbergmann fork)

These live in `stbergmann/emscripten` on branches
`websocket-getsockopt`, `websocket-getsockname`, `websocket-poll`
(and `allotropia/emscripten:fixed-3.1.65` ships the full tool source).
`build.sh` uses the allotropia fork by default and can apply the stbergmann
fixes if needed.

## Usage

```bash
# Everything defaults under ~/lowa-build; override with LOWA_DIR.
bash lowa/build.sh

# Then, in a separate shell, run the host-side proxy:
~/lowa-build/websocket_to_posix_proxy 6932
```

Point the wasm host at the proxy *before* `soffice.js` loads, by setting the
global Emscripten `Module` property:

```js
window.Module = window.Module || {};
Module.uno_websocket_to_posix_socket_url = 'ws://127.0.0.1:6932';
```

Then, inside ZetaJS/UNO, host a standard URP endpoint:

```js
const css = zHT.zetajs.uno.com.sun.star;
const acceptor = css.connection.Acceptor.create(zHT.context); // or SocketAcceptor
const conn = acceptor.accept('socket,host=0.0.0.0,port=2002');
const bridge = css.bridge.BridgeFactory.createBridge('', 'urp', conn, zHT.context);
```

Now any language can connect with its normal UNO bindings to
`localhost:2002` (`uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext`).

## Node.js hosting

The default LOWA `soffice.js` targets the web (Worker/`importScripts`,
`-sPROXY_TO_PTHREAD`). Running under Node needs the build to include the Node
environment and a `worker_threads` host shim:

- Build with Emscripten's Node environment enabled (add to the LO wasm
  `-sENVIRONMENT` list; may require a small patch to LO's emscripten flags).
- Provide `Module` (canvas stub not needed for `--disable-gui`), a `Worker`
  shim over `worker_threads`, and `importScripts`.
- `node-host.mjs` is a starting skeleton (experimental / untested against a real
  build).

If Node hosting proves too invasive, run the headless build under `node`'s
`worker_threads` only for the proxy side and keep the wasm in a minimal
headless Chrome; either way the URP socket is the same.

## Node.js hosting (implemented)

`node-runtime.mjs` runs the **stock CDN wasm build** directly under Node —
no browser, no Chrome, no display. It uses `worker_threads` for the Emscripten
pthreads and speaks the same WebSocket protocol as `public/index.html`, so
`server.mjs` and the MCP stdio server are unchanged.

```bash
# 1. fetch + patch the wasm bundle once (into lowa/cdn)
node lowa/prepare-cdn.mjs

# 2. run the bridge with the Node runtime
node server.mjs --node

# or through the MCP server (default; LOWA_NODE=0 falls back to Chrome)
LOWA_NODE=1 node mcp_stdio_server.mjs
```

What `prepare-cdn.mjs` patches in `soffice.js` (everything else is stock):

| Patch | Why |
| --- | --- |
| `var Module=globalThis.Module` | CJS module scope shadows the global `Module` config |
| real `importScripts` | Emscripten's Node stub is `assert(false)`; the office pthread loads `zeta.js` with it |
| skip `#qtcanvas` transfer | GUI build demands a canvas; we run headless (`--headless` is passed to LO) |
| ports in worker payload | `worker_threads` drops ports that are only in the transfer list; LOWA posts its `MessageChannel` that way |
| `Module.__FS = FS` | let the host read exported files from the Wasm filesystem |

Notes:

- Pass `--headless` to the LO main (the runtime does this) — without it Qt
  tries to create a window and crashes in the pthread.
- The office pthread and the main runtime have **separate MEMFS instances**.
  Exports are written by the office thread but only visible in the main
  runtime's FS, so `node-runtime.mjs` reads `__save_file.fs_path` after the
  export reply (same as the browser page does).
- Rendering to a canvas is not available; document processing, formatting and
  export (odt/docx/pdf/…) all work.

## Files

| File | Purpose |
| --- | --- |
| `build.sh` | Full patched-emsdk + headless LO wasm + proxy build |
| `node-host.mjs` | Experimental Node loader for `soffice.js` |
