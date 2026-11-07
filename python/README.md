# PyUNO over WebSocket → LibreOffice Wasm

Run **stock `import uno`** Python scripts against **LibreOffice WebAssembly**
(booted headless by the bridge) instead of a native LibreOffice.

This is a *dumb* UNO-over-WebSocket transport: the bridge only moves a handful
of operations (`root/get/set/call/query/release`) plus value marshalling, and
the real UNO implementation (ZetaJS / LOWA) executes them. There is no
re-implementation of the UNO object model in Python beyond a thin proxy.

```
your script (import uno; from com.sun.star.awt import Point, Size)
   │
   ▼
uno.py + uno_ws/  (thin proxy + value codec)
   │  WebSocket ws://127.0.0.1:8765/uno
   ▼
server.mjs (broker) ──▶ index.html (relay) ──▶ office_thread.js (ZetaJS UNO)
                                                    └── LibreOffice Wasm
```

## Layout

| File | Purpose |
| --- | --- |
| `uno.py` | Drop-in `uno` module (getComponentContext, Enum, systemPathToFileUrl, …) |
| `unohelper.py` | Import-compatible `unohelper` shim |
| `uno_ws/wsclient.py` | Dependency-free synchronous WebSocket client |
| `uno_ws/bridge.py` | Connection + op dispatcher + `ensure_bridge()` auto-start |
| `uno_ws/proxy.py` | `RemoteObject` (attribute get/set, method call, queryInterface) |
| `uno_ws/types.py` | Struct/Enum classes + value marshalling |
| `uno_ws/importhook.py` | Resolves `from com.sun.star.awt import Point, Size` |
| `uno_ws/bootstrap.py` | Local `ServiceManager` / `UnoUrlResolver` bootstrap chain |

## Quick start

```python
import sys
sys.path.insert(0, "python")  # from the repository root

import uno
from com.sun.star.awt import Point, Size
from com.sun.star.beans import PropertyValue

local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local)
ctx = resolver.resolve("uno:socket,host=localhost,port=2044;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

doc = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, ())
pages = doc.getDrawPages()
page = pages.getByIndex(0)

shape = doc.createInstance("com.sun.star.drawing.RectangleShape")
shape.setPosition(Point(1000, 1000))
shape.setSize(Size(5000, 3000))
shape.FillStyle = uno.Enum("com.sun.star.drawing.FillStyle", "SOLID")
shape.FillColor = 0xFF5300
page.add(shape)

doc.storeToURL(uno.systemPathToFileUrl("/tmp/demo.odp"), ())
doc.dispose()
```

## Notes

- `systemPathToFileUrl(host_path)` maps a host path to a path inside the Wasm
  virtual filesystem; after `storeToURL`/`storeAsURL` the bytes are read back
  and written to the real host path, so `os.path.getsize`/`pdftoppm` work.
- The bridge auto-starts `node server.mjs --node` (no browser needed).
  Set `UNO_WS_URL` / `LIBREOFFICE_URL` to point elsewhere.
- Callbacks/listeners (`XEventListener` etc.) are not supported yet.
- `uno.Enum`, structs (`Point`/`Size`/`PropertyValue`) and interface references
  are marshalled as tagged JSON values; floats are marked so property sets keep
  their `double` type.
