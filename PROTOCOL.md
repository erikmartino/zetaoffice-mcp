# UNO-over-WebSocket protocol

A language-agnostic, "dumb" transport for driving **LibreOffice WebAssembly**
(via ZetaJS) from any client. The bridge does not model UNO itself: it moves a
handful of operations and marshals values. The real UNO implementation runs in
the Wasm worker.

- **Endpoint:** `ws://localhost:8765/uno` (text frames, JSON).
- **Objects:** opaque integer handles, assigned by the server. `0` means null.
- **No callbacks** (listeners) in v1.

Anything that can open a WebSocket and encode JSON can use this — Node,
Go, a browser, an LLM agent emitting tool calls, `websocat`, etc.

## Request / response

Request:  `{"id": <int>, "op": "<op>", ...op fields}`
Response: `{"id": <int>, "ok": true,  "v": <value>}`
          `{"id": <int>, "ok": false, "e": {"msg": "<error>"}}`

`id` is client-chosen and echoed back. The broker also correlates internally.

## Operations

| `op` | fields | returns |
| --- | --- | --- |
| `root` | — | `{$h}` handle to the UNO component context |
| `get` | `h`, `name` | member value (attribute, `getX()`, or property) |
| `set` | `h`, `name`, `v` | `null` (attribute or `setPropertyValue`) |
| `call` | `h`, `name`, `args` | method result |
| `query` | `h`, `iface` | `{$h}` or `null` (`queryInterface`) |
| `release` | `h` | `null` (drops the server-side handle) |
| `create` | `service` | `{$h}` or `null` (`createInstanceWithContext`) |
| `describe` | `type` or `h`, `method?` | reflection metadata (see below) |
| `readFile` | `path` | `{data: <base64>, bytes}` (Wasm FS) |
| `writeFile` | `path`, `data` (base64) | `{path, bytes}` (Wasm FS) |

`describe` returns, for an interface name: `type`, `kind`, `superclasses`,
`methods[]` (`name`, `returns`, `params[]` with `name`/`type`/`mode`) and
`attributes[]`. With a handle it returns the object's `interfaces` and
`services`. A module name (e.g. `com.sun.star.sheet`) lists that module's
interfaces and services from the bundled index (`public/uno-index.js`,
regenerate with `node scripts/gen-uno-index.mjs`). Use it instead of guessing
method names or argument counts — e.g. the chart call in this build wants five
arguments, and axis captions come from `getAxisTitle()`, not a property.

Everything else — `createInstance`, `loadComponentFromURL`, `storeToURL`,
`getDrawPages`, `setPosition`, setting `FillColor`, … — is just `get`/`set`/
`call` on a handle. There is no higher-level API to keep in sync.

## Value encoding

| UNO value | JSON |
| --- | --- |
| boolean / long / double / string / void | `true` / `42` / `1.5` / `"x"` / `null` |
| float (needs to stay `double`) | `{"$f": 1.5}` |
| interface reference | `{"$h": <handle>}` |
| struct | `{"$s": "com.sun.star.awt.Point", "X": 1, "Y": 2}` |
| enum | `{"$e": "com.sun.star.drawing.FillStyle", "v": "SOLID"}` |
| sequence | `[<value>, ...]` |
| method reference (probe result) | `{"$m": 1}` |

`get` returns `{"$m":1}` when the name is a method (so a client can bind a
callable); otherwise it returns the decoded value.

## Minimal example (raw, any language)

```
-> {"id":1,"op":"root"}
<- {"id":1,"ok":true,"v":{"$h":1}}

-> {"id":2,"op":"get","h":1,"name":"ServiceManager"}
<- {"id":2,"ok":true,"v":{"$h":2}}

-> {"id":3,"op":"call","h":2,"name":"createInstanceWithContext",
    "args":["com.sun.star.frame.Desktop", {"$h":1}]}
<- {"id":3,"ok":true,"v":{"$h":3}}

-> {"id":4,"op":"call","h":3,"name":"loadComponentFromURL",
    "args":["private:factory/simpress","_blank",0,[]]}
<- {"id":4,"ok":true,"v":{"$h":4}}

-> {"id":5,"op":"call","h":4,"name":"createInstance",
    "args":["com.sun.star.drawing.RectangleShape"]}
<- {"id":5,"ok":true,"v":{"$h":5}}

-> {"id":6,"op":"call","h":5,"name":"setPosition",
    "args":[{"$s":"com.sun.star.awt.Point","X":1000,"Y":1000}]}
<- {"id":6,"ok":true,"v":null}

-> {"id":7,"op":"set","h":5,"name":"FillColor","v":{"$f":16732928}}
<- {"id":7,"ok":true,"v":null}
```

## File I/O

`storeToURL`/`loadComponentFromURL` use paths inside the Wasm virtual
filesystem. Write bytes in with `writeFile`, read results out with `readFile`
(base64). The protocol itself is just `readFile`/`writeFile`; path mapping is
left to the client.

## Clients

- **Any language:** implement the ops above directly.
- **MCP clients:** the same worker is reachable via `mcp_stdio_server.mjs`;
  the `uno` tool mirrors these ops (`root`, `get`, `set`, `call`, `query`,
  `create`, `describe`, `release`), so no per-feature tool is needed.
