# ZetaOffice cookbook

Task recipes for driving LibreOffice in the Wasm bridge. Each recipe is a
sequence of tool calls with a verification step. Prefer these over inventing
UNO orchestration: the fiddly parts (CLSIDs, anchors, cursor state, storage) are
already worked out.

Tools used here:

- `document` – create/info/content/styles for Writer/Calc/Impress.
- `text` – insert and style Writer paragraphs.
- `sheet` – read/write/format Calc cells and add charts.
- `embed` – insert a real OLE object into the active Writer document.
- `uno` – generic escape hatch: `root/get/set/call/query/create/describe/release`.
- `cookbook` – this document.

## Before you start

1. `uno {op:"describe", type:"com.sun.star.sheet"}` lists a module's interfaces
   and services. Describe an interface (`...XSpreadsheet`) for methods,
   parameter names/types/modes and return types.
2. `uno {op:"describe", h:<handle>}` lists the interfaces, services and
   **properties** of a live object.
3. `set` takes **`v`** (the MCP tool also accepts `value`). A missing value is
   an error; `null` clears a property.
4. Anything that mutates and returns `void` is unverified. Read the state back.

## Create a styled Writer document

```
document {action:"create", doc_type:"writer"}
text {action:"style", style_name:"Title", paragraph_n:1}
text {action:"insert", content:"Rabbit Weight Log\nWeekly weigh-ins\n\nMeasurements\n..."}
```
Paragraph `n` is 1-based. `\n` creates a paragraph. For precise control use
`uno`:

```
uno {op:"root"}                                   -> h0
uno {op:"get", h:h0, name:"ServiceManager"}       -> h1
uno {op:"call", h:h1, name:"createInstanceWithContext",
     args:["com.sun.star.frame.Desktop", { "$h": h0 }]} -> h2
uno {op:"call", h:h2, name:"getCurrentComponent"} -> doc
uno {op:"call", h:doc, name:"getText"}            -> text
uno {op:"call", h:text, name:"createTextCursor"}  -> cur
uno {op:"set", h:cur, name:"ParaStyleName", v:"Title"}
uno {op:"call", h:text, name:"insertString", args:[cur, "Rabbit Weight Log", false]}
uno {op:"call", h:text, name:"insertControlCharacter",
     args:[cur, { "$e":"com.sun.star.text.ControlCharacter", v:"PARAGRAPH_BREAK" }, false]}
```

## Embed a spreadsheet in a Writer document

Use the `embed` tool. It does the whole OLE dance and returns handles:

```
embed {service:"calc", width_mm:160, height_mm:95, values:[["Date","Weight (g)"],["2026-09-12",1420]]}
  -> { name:"Object1", clsid:"47BBB4CB-…", object:{$h:…}, model:{$h:…} }
```

Then use `model` with `uno` to fill cells and add a chart.

Raw sequence (what `embed` does, if you need to adapt it):

```
uno {op:"call", h:text, name:"createTextCursor"} -> end
uno {op:"call", h:end, name:"gotoEnd", args:[false]}
uno {op:"call", h:end, name:"collapseToEnd"}          # a range cursor silently no-ops
uno {op:"call", h:doc, name:"createInstance",
     args:["com.sun.star.text.TextEmbeddedObject"]} -> emb
uno {op:"set", h:emb, name:"CLSID", v:"47BBB4CB-CE4C-4E80-A591-42D9AE74950F"}
uno {op:"set", h:emb, name:"AnchorType",
     v:{ "$e":"com.sun.star.text.TextContentAnchorType", v:"AS_CHARACTER" }}
uno {op:"set", h:emb, name:"Width",  v:16000}      # 1/100 mm
uno {op:"set", h:emb, name:"Height", v:9500}
uno {op:"call", h:text, name:"insertTextContent", args:[end, emb, false]}
uno {op:"get",  h:doc,  name:"EmbeddedObjects"} -> objs
uno {op:"call", h:objs, name:"getElementNames"}     # verify a new name appeared
uno {op:"call", h:emb,  name:"getEmbeddedObject"} -> model
```

Embedded CLSIDs (the `CLSID` property accepts only these GUIDs, not service
names):

| service | CLSID |
| --- | --- |
| calc | `47BBB4CB-CE4C-4E80-A591-42D9AE74950F` |
| writer | `8BC6B165-B1B2-4EDD-AA47-DAE2EE689DD6` |
| impress | `9176E48A-637A-4D1F-803B-99D9BFAC1047` |
| draw | `4BAB8970-8A3B-45B3-991C-CBEEAC6BD5E3` |
| math | `078B7ABA-54FC-457F-8551-6147E776A997` |

Notes:

- `insertTextContent` returns void and **silently drops** an object whose model
  could not be created. Always check `getElementNames()` grew.
- The model is `getEmbeddedObject()`, not the `Model` property.
- The OLE preview is captured when the object is created. Setting Width/Height
  later only stretches that preview; choose the size before inserting.

## Fill the embedded sheet and add a chart

```
sheet {action:"write", start:"A1", values:[["Date","Weight (g)"],["2026-09-12",1420]]}
```
`sheet` targets the active Calc document, not the embedded model. For the
embedded model use `uno` calls on `model` from `embed`:

```
uno {op:"call", h:model, name:"getSheets"} -> sheets
uno {op:"call", h:sheets, name:"getByIndex", args:[0]} -> sheet
uno {op:"call", h:sheet, name:"getCellRangeByName", args:["A1:B10"]} -> rng
uno {op:"call", h:rng, name:"setDataArray",
     args:[[["Date","Weight (g)"],["2026-09-12",1420],["2026-09-19",1475]]]}
uno {op:"call", h:sheet, name:"getCharts"} -> charts
uno {op:"call", h:rng, name:"getRangeAddress"} -> addr
uno {op:"call", h:charts, name:"addNewByName",
     args:["Chart1", { "$s":"com.sun.star.awt.Rectangle", X:500,Y:400,Width:15500,Height:9000 },
           [addr], true, true]}          # five arguments in this build
uno {op:"call", h:charts, name:"getByName", args:["Chart1"]} -> chart
uno {op:"call", h:chart, name:"getEmbeddedObject"} -> chartdoc
uno {op:"call", h:chartdoc, name:"createInstance",
     args:["com.sun.star.chart.LineDiagram"]}
uno {op:"set", h:chartdoc, name:"HasMainTitle", v:true}
uno {op:"call", h:chartdoc, name:"getTitle"} -> title
uno {op:"set", h:title, name:"String", v:"Rabbit Weight (g)"}
```

Axis captions come from `getAxisTitle()`, not a `Title` property:

```
uno {op:"call", h:chartdoc, name:"getDiagram"} -> diagram
uno {op:"call", h:diagram, name:"getXAxis"} -> axis
uno {op:"call", h:axis, name:"getAxisTitle"} -> atitle
uno {op:"set", h:atitle, name:"String", v:"Date"}
```

## Save, export and show in the browser

- MCP: `save {action:"export", file_path:"/path/out.odt", export_format:"odt"}`
  (odt/docx/pdf/…). Files are written on the bridge host.
- `document {action:"open_browser"}` mirrors the current document into a fresh
  browser tab. `?force=1` always opens a new tab.

## Restart or stop the bridge

After editing bridge or worker code, restart instead of killing processes:

```
bridge {action:"status"}    # health, mode, connected sessions
bridge {action:"restart"}   # stop, re-exec, wait until healthy
bridge {action:"start"}     # spawn it if it is not running
bridge {action:"quit"}      # clean shutdown (also stops the Wasm runtime)
```

HTTP equivalents: `POST /restart`, `POST /quit`. A restart keeps the browser
tabs; they reconnect and re-announce readiness automatically.

## Gotchas

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bad number of arguments … expected N vs actual M` | build-specific signature (e.g. `addNewByName` takes 5 here) | `describe` the interface or the live object |
| A `set` appears to succeed but nothing changes | missing/undefined value (void Any) | pass `v`; verify with `get` |
| `insertTextContent` succeeds, object missing | model could not be created (bad CLSID) or cursor is a range | use a GUID, `collapseToEnd()`, check `getElementNames()` |
| Embedded preview is zoomed/cropped | preview captured at creation | choose Width/Height before inserting |
| `UnknownPropertyException` on a plausible property | property is an accessor method (e.g. `getAxisTitle`) | `describe` the handle/interface |
| Wrong document edited | `getCurrentComponent()` returned another open doc | track the handle returned by `create`/`loadComponentFromURL` |
| `[RuntimeException, null]` | LibreOffice raised without a message | read state back; try the documented call order |
