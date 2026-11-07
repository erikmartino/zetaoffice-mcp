# ZetaOffice cookbook

Two things in one place:

1. **Known recipes** — exact call sequences for the common tasks (text, sheets,
   charts, embedding, formulas, export).
2. **A playbook for unknown tasks** — how to find the right service, interface
   and property, then compose the calls yourself.

Start with §1 if your task matches a recipe. Otherwise read §2–§5 once, then
follow the decision tree in §8.

This file is meant to be self-contained: a fresh agent with no earlier context
should be able to follow it using only these tools.

Tools: `document`, `text`, `sheet`, `embed`, `save`, `bridge`, `uno`
(`root/get/set/call/query/create/describe/release/handles`).

## 0. Find a recipe

Match the task to a heading; `cookbook {topic:"<word>"}` returns that section or
sub-recipe directly (topics match `##` and `###` headings).

| Task | Look at |
| --- | --- |
| text, paragraphs, styles | Styled Writer document; R1–R5 |
| tables with totals | Writer table with a computed total |
| math objects | Math formula |
| embedded Calc + chart | Embedded Calc sheet with a chart |
| Calc data, charts, freeze | Calc: header formatting; Calc: data series |
| page size, margins, header/footer | Page setup |
| track changes | Track changes with UNO |
| footnotes, comments | Footnote and annotation comment |
| captions, cross-references | Caption with a live sequence cross-reference |
| images, watermarks | Picture; Text watermark |
| export | Save, export, show in the browser |

---

## 1. Quickstart

```
bridge   {action:"status"}                  # is the Wasm runtime up?
cookbook {topic:"embed"}                    # read the matching recipe
document {action:"create", doc_type:"writer"}
text     {action:"insert", content:"Title\nBody text\n"}
text     {action:"style", style_name:"Title", paragraph_n:1}
save     {action:"export", file_path:"/abs/path/out.odt", export_format:"odt"}
```

`save`/`picture` resolve relative paths against this checkout's root, but use
absolute paths for anything outside it. MCP tool calls are pinned to one Wasm
worker (`LIBREOFFICE_TARGET=node`); do not open browser tabs during headless
work and never mix documents from `getCurrentComponent()` with the one you
created.

For anything not listed here, read §2–§4 and use `describe` before guessing.

---

## 2. Mental model

A LibreOffice document is a tree of UNO objects. You navigate it with accessors,
create children with a factory, attach them with an insert method, and configure
them with properties.

| Document | Entry point | Children |
| --- | --- | --- |
| Writer | `doc.getText()` | text cursor, paragraphs, tables, fields, embedded objects, pictures, frames |
| Calc | `doc.getSheets()` | sheet → `getCellRangeByName` / `getCellByPosition`; `sheet.getCharts()` |
| Impress | `doc.getDrawPages()` | page → `getByIndex(n)`; `page.add(shape)` |
| All | `doc.getCurrentController()` | view state (zoom, active sheet/page) |

The Desktop is the root of open documents:

```
root (component context) → ServiceManager
  → createInstanceWithContext("com.sun.star.frame.Desktop", root)
  → getCurrentComponent()  or  loadComponentFromURL(...)
```

UNO vocabulary used below:

| Term | Meaning | Typical call |
| --- | --- | --- |
| service | what you ask the factory to create | `doc.createInstance("com.sun.star.text.TextTable")` |
| interface | what you can call | `queryInterface("…XTextTablesSupplier")` |
| property | typed attribute | `set h name v`, `get h name` |
| accessor | `getX()` / `setX()` method | `call h "getText"` |
| supplier | `getX()` returning a collection | `getTextTables`, `getEmbeddedObjects`, `getTextFields` |
| collection | count + index/name lookup | `getCount`, `getByIndex`, `getByName`, `hasByName` |
| enumeration | iterator | `createEnumeration` → `hasMoreElements`, `nextElement` |
| sequence | array in JSON | `[...]` |
| struct | typed record | `{"$s":"com.sun.star.awt.Rectangle", X:0, Y:0, …}` |
| enum | named constant | `{"$e":"com.sun.star.text.TextContentAnchorType", v:"AS_CHARACTER"}` |

Values crossing the bridge: interfaces are `{"$h":n}`, sequences are arrays,
null is null.

---

## 3. Discovery loop

Do this instead of guessing names or argument counts:

1. **Module** — list what exists:
   `uno {op:"describe", type:"com.sun.star.text"}`
2. **Interface** — methods, parameter names/types/modes, return types:
   `uno {op:"describe", type:"com.sun.star.text.XText"}`
   Filter: `{op:"describe", type:"…XText", method:"insertString"}`
3. **Live object** — interfaces, services and **properties**:
   `uno {op:"describe", h:<handle>}`
4. **Handles** — what is handle 12?
   `uno {op:"handles"}`
5. **Docs** — full IDL when reflection is not enough:
   `https://api.libreoffice.org/docs/idl/ref/`
   `https://raw.githubusercontent.com/LibreOffice/core/master/offapi/com/sun/star/<module>/<Type>.idl`

If a property is not in `properties`, it may be an accessor: try
`call h "getX"` (e.g. `getAxisTitle`, `getEmbeddedObject`).

Every `uno` result is `{success, op, value}`. An interface handle is
`value.$h`; a sequence is `value` (array). Do not read `$h` at the top level.

Handles belong to one Wasm worker and are renumbered after a bridge restart.
The bridge pins a session to one worker; if a call still finds a handle
invalid, re-acquire it from `root` — never reuse an old number.

---

## 4. The mutation pattern

Every change follows the same four steps. Do not skip step 4.

```
1. create     obj = doc.createInstance(service)      # or ServiceManager
2. configure  set properties (size, style, CLSID, …)
3. attach     text.insertTextContent(cursor, obj, false)
              page.add(shape)
              range.setDataArray(...)
              charts.addNewByName(...)
4. verify     enumerate the collection / read the value back
```

Attach points by target:

- **Writer text** — `text.insertTextContent(cursor, content, false)`.
  Use a collapsed cursor: `gotoEnd(false)` then `collapseToEnd()`. A range
  cursor silently does nothing.
- **Writer tables** — the table *is* text content (`initialize(rows, cols)`
  before inserting, then `getCellByName("A1")`).
- **Calc** — `range.setDataArray(rows)` for bulk, `cell.setValue()` /
  `setString()` for one cell, `sheet.getCharts()` for charts.
- **Impress/Draw** — `page.add(shape)`; set `Position`/`Size` structs after.
- **Document-level** — fields, page styles, document properties.

**Verification examples**

```
getTextTables().getCount()            # table present?
getEmbeddedObjects().getElementNames() # OLE object present?
getTextFields().getCount()            # field present?
sheet.getCharts().getCount()          # chart present?
cell.getString() / getValue()         # value written?
range.getDataArray()                  # whole block
```

Void methods (`insertTextContent`, `setPropertyValue`, `add`, `remove`) tell you
nothing on success. A no-op looks exactly like a success.

---

## 5. Collections, suppliers and formatting

**Suppliers** return collections. Common ones:

| Interface | Method | Returns |
| --- | --- | --- |
| `XTextTablesSupplier` | `getTextTables` | text tables |
| `XTextEmbeddedObjectsSupplier` | `getEmbeddedObjects` | OLE objects |
| `XTextFieldsSupplier` | `getTextFields` | fields |
| `XTextFramesSupplier` | `getTextFrames` | frames |
| `XTextGraphicObjectsSupplier` | `getGraphicObjects` | pictures |
| `XDrawPagesSupplier` | `getDrawPages` | slides/pages |
| `XSheetsSupplier` | `getSheets` | spreadsheets |

Query the document first, then call the supplier:

```
uno {op:"query", h:doc, iface:"com.sun.star.text.XTextTablesSupplier"} -> s
uno {op:"call", h:s, name:"getTextTables"} -> coll
uno {op:"call", h:coll, name:"getCount"}
```

Iterate anything with `createEnumeration`:

```
q = query text "com.sun.star.container.XEnumerationAccess" -> ea
call ea "createEnumeration" -> en
loop: call en "hasMoreElements" / "nextElement"
```

**Formatting** is a property set on a range. The same pattern works for a text
cursor, a cell range, a paragraph, a page style or a shape: apply the properties
to the smallest object that represents the area you want to change.

```
uno {op:"set", h:range, name:"CharWeight", v:{"$f":150}}   # bold (float)
uno {op:"set", h:range, name:"CharHeight", v:{"$f":12}}
uno {op:"set", h:range, name:"NumberFormat", v:<key>}      # from NumberFormats
uno {op:"set", h:pageStyle, name:"IsLandscape", v:true}
```

Prefer high-level tools when they exist (`sheet` format, `text` style) — they
carry the correct types (Float/Long/enum) for you.

---

## 6. Reusable recipes

### R1 — Insert any text content

Tables, pictures, fields, embedded objects and shapes all follow the same
create → configure → `insertTextContent` → verify sequence. Only the service,
the properties and the attach method change.

```
cursor.gotoEnd(false); cursor.collapseToEnd()
obj = doc.createInstance(service)
set obj properties
text.insertTextContent(cursor, obj, false)
verify with the matching supplier
```

### R2 — Enumerate a Writer document

Use the suppliers in §5 to list tables, embedded objects, fields, frames and
pictures. Print `getElementNames()` / iterate and `describe` each element when
you need its type.

### R3 — Tables

```
table = doc.createInstance("com.sun.star.text.TextTable")
table.initialize(rows, cols)
text.insertTextContent(cursor, table, false)      # verify getTextTables().getCount()
cell = table.getCellByName("B2")
cell.setString("text")  /  cell.setValue(42)
cell.setFormula("sum<C2:C5>")                     # Writer syntax, not Calc's of:=
```

Writer table formulas use the `ooow:` syntax (`sum<C2:C5>`, stored as
`ooow:sum&lt;...&gt;`); Calc cells use `of:=SUM(...)`. A header + 4 data rows +
a total row is 6 rows, not 5.

Header repetition, borders and cell formats are properties on the table / cell
range (`RepeatHeadline`, `BackColor`, `CharWeight`, …). Check with `describe`.

### R4 — Fields

A field is a text content created from a field service:

```
f = doc.createInstance("com.sun.star.text.TextField.PageNumber")
set f "NumberingType" / "SubType" / "Content" (per field type)
text.insertTextContent(cursor, f, false)
```

Field types live under `com.sun.star.text.TextField` (Date, PageNumber, FileName,
Author, …) and `com.sun.star.text.textfield` (reference/caption/…). `describe`
the module and the interface before setting values.

### R5 — Page and section properties

Page styles are the place for paper size, orientation, margins, headers and
footers:

```
families = doc.getStyleFamilies()
pages = families.getByName("PageStyles")
style = pages.getByName("Default")   # or the current page style
set style "IsLandscape" / "Width" / "Height" / "LeftMargin" / …
header = style.getPropertyValue("HeaderText")   # XText for the header
```

Sections (`doc.getTextSections()`) behave like sub-documents with their own
columns and link targets.

### R6 — Charts

Charts are document objects owned by a sheet (Calc) or by the document:

```
charts = sheet.getCharts()
addr = range.getRangeAddress()
charts.addNewByName(name, rect, [addr], columnHeaders, rowHeaders)   # 5 args here
chart = charts.getByName(name).getEmbeddedObject()
chart.createInstance("com.sun.star.chart.LineDiagram")
set chart "HasMainTitle"
chart.getTitle() -> set "String"
axis = chart.getDiagram().getXAxis(); axis.getAxisTitle() -> set "String"
```

Verify with `getCount()`. The diagram service selects line/bar/area/pie/scatter.
The first column of the data range becomes the category axis when
`rowHeaders` is true.

### R7 — Nested/embedded documents

An embedded object has its own model; treat it as a second document:

```
obj.getEmbeddedObject() -> model
model.getSheets() / getText() / getDrawPages()   # same object tree as a top-level doc
```

Fill it with the same calls you would use on a standalone document. Save the
container; the nested model is stored with it.

`embed` sizes the OLE preview to `width_mm`/`height_mm` automatically. If you
build the object by hand, size the **embedded model** (not the control): the
supplier/control path throws `WrongStateException` in this build.

```
model = obj.getEmbeddedObject()
call model "setVisualAreaSize" [4, {"$s":"com.sun.star.awt.Size","Width":16000,"Height":9500}]
set obj "Width" 16000
set obj "Height" 9500
```

### R8 — Export with options

`storeToURL(url, props)` where props are `PropertyValue` structs. `FilterName`
selects the format; `FilterData` carries format-specific options.

```
[{"$s":"com.sun.star.beans.PropertyValue","Name":"FilterName","Value":"writer8"},
 {"$s":"com.sun.star.beans.PropertyValue","Name":"Overwrite","Value":true}]
```

The `save` tool wraps this for odt/docx/pdf/xlsx/pptx. Use raw `storeToURL`
only for options the tool does not expose.

### R9 — Presentations

```
doc = loadComponentFromURL("private:factory/simpress", …)
pages = doc.getDrawPages()
page = pages.getByIndex(0)          # or pages.insertNewByIndex(n)
shape = doc.createInstance("com.sun.star.drawing.TextShape")
page.add(shape); set Position/Size; shape.setString("…")
```

`create presentation` / the `document` tool can build a deck from slide objects
in one call when the content is simple.

---

## 7. Known recipes (exact sequences)

### Styled Writer document

```
document {action:"create", doc_type:"writer"}
text {action:"insert", content:"Rabbit Weight Log\nWeekly weigh-ins\n\nMeasurements\n…"}
text {action:"style", style_name:"Title", paragraph_n:1}
text {action:"style", style_name:"Subtitle", paragraph_n:2}
text {action:"style", style_name:"Heading 1", paragraph_n:4}
```

Paragraph `n` is 1-based; `\n` creates a paragraph. For per-paragraph control
via `uno`: set `ParaStyleName` on a collapsed cursor, then `insertString`,
then `insertControlCharacter(PARAGRAPH_BREAK)`.

### Embed a spreadsheet in Writer

```
embed {service:"calc", width_mm:160, height_mm:95,
       values:[["Date","Weight (g)"],…],
       chart:{title:"Weight", x_title:"Date", y_title:"g"}}
  -> {name, clsid, object:{$h}, model:{$h}, values, chart, preview}
```

It sets the GUID CLSID, anchor, size, inserts, verifies `getElementNames()`
grew, writes `values`, optionally builds `chart`, sizes the preview, and returns
the model. Then use `model` with `uno` for anything the recipe does not cover.

Raw sequence and the CLSID table are in §R1/R7; the important bits:

- `CLSID` accepts **GUIDs only** (calc `47BBB4CB-CE4C-4E80-A591-42D9AE74950F`,
  writer `8BC6B165-…`, impress `9176E48A-…`, draw `4BAB8970-…`,
  math `078B7ABA-…`).
- `getEmbeddedObject()`, not the `Model` property.
- The OLE preview is captured at creation; set the size before inserting.

### Embedded Calc sheet with a chart (one call)

`embed` can write a value block, add a chart and size the OLE preview in one
call. Replace the example labels, numbers and output paths.

```js
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "writer" });
const h = doc.handle.$h;
await tools.zetaoffice.text({ action: "insert",
  content: "Report title\nSupporting line\n" });
const e = await tools.zetaoffice.embed({
  service: "calc", width_mm: 160, height_mm: 95,
  values: [["Label", "Value"], ["A", 10], ["B", 20], ["C", 15], ["D", 30], ["E", 25]],
  chart: { title: "Values by label", x_title: "Label", y_title: "Value", legend: false },
});
await tools.zetaoffice.save({ action: "export", file_path: "out/embedded.odt", export_format: "odt" });
await tools.zetaoffice.save({ action: "export", file_path: "out/embedded.pdf", export_format: "pdf" });
return e;
```

`e.values` reports the written block, `e.chart` the chart name/range/type and
`e.preview` the visual area. The first column becomes the category axis and the
header row the series name. That is sufficient verification for this pattern.

### Writer table with a computed total

Use `document.handle` for UNO. The number of rows and the sum range are yours;
this example uses a header, four data rows and a total row.

```js
const U = (o) => tools.zetaoffice.uno(o);
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "writer" });
const h = doc.handle.$h;
const text = (await U({ op: "call", h, name: "getText" })).value.$h;
const cur = (await U({ op: "call", h: text, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: cur, name: "gotoEnd", args: [false] });
await U({ op: "call", h: cur, name: "collapseToEnd" });

const table = (await U({ op: "call", h, name: "createInstance",
  args: ["com.sun.star.text.TextTable"] })).value.$h;
await U({ op: "call", h: table, name: "initialize", args: [6, 3] });
await U({ op: "call", h: text, name: "insertTextContent",
  args: [{ $h: cur }, { $h: table }, false] });

const cell = async (n) => (await U({ op: "call", h: table, name: "getCellByName", args: [n] })).value.$h;
const put = async (n, v) => {
  const c = await cell(n);
  if (typeof v === "number") await U({ op: "call", h: c, name: "setValue", args: [v] });
  else await U({ op: "call", h: c, name: "setString", args: [v] });
};

await put("A1", "Item"); await put("B1", "Qty"); await put("C1", "Price");
await put("A2", "Row 1"); await put("B2", 1); await put("C2", 10);
await put("A3", "Row 2"); await put("B3", 2); await put("C3", 20);
await put("A4", "Row 3"); await put("B4", 3); await put("C4", 30);
await put("A5", "Row 4"); await put("B5", 4); await put("C5", 40);
await put("A6", "Total");

const total = await cell("C6");
await U({ op: "call", h: total, name: "setFormula", args: ["sum<C2:C5>"] });
const value = (await U({ op: "call", h: total, name: "getValue" })).value;
const tables = (await U({ op: "call", h, name: "getTextTables" })).value.$h;
const count = (await U({ op: "call", h: tables, name: "getCount" })).value;

await tools.zetaoffice.save({ action: "export", file_path: "out/table.odt", export_format: "odt" });
return { count, value };
```

The total formula uses Writer syntax `sum<C2:C5>`; adjust the range to the data
rows. `value` and `count` are the verification.

### Calc: header formatting, column widths and freeze

```js
const U = (o) => tools.zetaoffice.uno(o);
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "calc" });
const h = doc.handle.$h;
await tools.zetaoffice.sheet({ action: "write", values: [
  ["Col A", "Col B", "Col C"],
  ["x", 1, 10], ["y", 2, 20], ["z", 3, 30],
] });
await tools.zetaoffice.sheet({ action: "format", range: "A1:C1", bold: true });
await tools.zetaoffice.sheet({ action: "column_width", column: "A", width_mm: 40 });
await tools.zetaoffice.sheet({ action: "column_width", column: "B", width_mm: 25 });

const ctl = (await U({ op: "call", h, name: "getCurrentController" })).value.$h;
const fz = (await U({ op: "query", h: ctl, iface: "com.sun.star.sheet.XViewFreezable" })).value.$h;
await U({ op: "call", h: fz, name: "freezeAtPosition", args: [0, 1] });
const frozen = (await U({ op: "get", h: ctl, name: "HasFrozenPanes" })).value;
await tools.zetaoffice.save({ action: "export", file_path: "out/table.xlsx", export_format: "xlsx" });
return { frozen };
```

`freezeAtPosition(0, 1)` freezes the first row; `HasFrozenPanes` confirms it.
Use one `column_width` call per column.

### Calc: data series with a line chart

```js
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "calc" });
await tools.zetaoffice.sheet({ action: "write", values: [
  ["Date", "Value"],
  ["2026-01-05", 10], ["2026-01-12", 12], ["2026-01-19", 15],
  ["2026-01-26", 14], ["2026-02-02", 18],
] });
await tools.zetaoffice.sheet({ action: "format", range: "A1:B1", bold: true });
await tools.zetaoffice.sheet({ action: "chart", chart_type: "line",
  data_range: "A1:B6", title: "Value over time" });
await tools.zetaoffice.save({ action: "export", file_path: "out/chart.xlsx", export_format: "xlsx" });
```

`sheet {action:"chart"}` targets the active Calc document and uses the first
column as category labels. No UNO is needed for the basic chart.

### Page setup: landscape, margins, header and page-number footer

Page setup lives on a page **style**; header/footer are XText objects on it.
Use `value:` for these properties.

```js
const U = (o) => tools.zetaoffice.uno(o);
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "writer" });
const h = doc.handle.$h;
const fams = (await U({ op: "call", h, name: "getStyleFamilies" })).value.$h;
const pages = (await U({ op: "call", h: fams, name: "getByName", args: ["PageStyles"] })).value.$h;
const style = (await U({ op: "call", h: pages, name: "getByName", args: ["Standard"] })).value.$h;

for (const [name, value] of [
  ["IsLandscape", true], ["Width", 29700], ["Height", 21000],
  ["LeftMargin", 1500], ["RightMargin", 1500], ["TopMargin", 1500], ["BottomMargin", 1500],
  ["HeaderIsOn", true], ["FooterIsOn", true],
]) await U({ op: "set", h: style, name, value });

const ht = (await U({ op: "call", h: style, name: "getPropertyValue", args: ["HeaderText"] })).value.$h;
const hc = (await U({ op: "call", h: ht, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: ht, name: "insertString", args: [{ $h: hc }, "HEADER TEXT", false] });

const ft = (await U({ op: "call", h: style, name: "getPropertyValue", args: ["FooterText"] })).value.$h;
const fc = (await U({ op: "call", h: ft, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: ft, name: "insertString", args: [{ $h: fc }, "Page ", false] });
const field = (await U({ op: "call", h, name: "createInstance",
  args: ["com.sun.star.text.TextField.PageNumber"] })).value.$h;
await U({ op: "set", h: field, name: "NumberingType", value: 4 });
await U({ op: "call", h: ft, name: "insertTextContent",
  args: [{ $h: fc }, { $h: field }, false] });

await tools.zetaoffice.text({ action: "insert", content: "Body text.\n" });
await tools.zetaoffice.save({ action: "export", file_path: "out/layout.odt", export_format: "odt" });
await tools.zetaoffice.save({ action: "export", file_path: "out/layout.pdf", export_format: "pdf" });
return { landscape: (await U({ op: "get", h: style, name: "IsLandscape" })).value };
```

Lengths are in 1/100 mm (1.5 cm = 1500). Read back `IsLandscape`,
`Width`/`Height` and the header/footer strings as verification.

### Track changes with UNO

The high-level `track_changes` tool is a stub. Drive the model and redlines:

```js
const U = (o) => tools.zetaoffice.uno(o);
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "writer" });
const h = doc.handle.$h;
await tools.zetaoffice.text({ action: "insert", content:
  "First sentence stays.\\nSecond sentence will change.\\nThird sentence stays.\\n" });

await U({ op: "set", h, name: "RecordChanges", value: true });
const p2 = await tools.zetaoffice.structure({ action: "paragraph", n: 2 });
const text = (await U({ op: "call", h, name: "getText" })).value.$h;
const cur = (await U({ op: "call", h: text, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: cur, name: "gotoStart", args: [false] });
await U({ op: "call", h: cur, name: "goRight", args: [p2.start, false] });
await U({ op: "call", h: cur, name: "goRight", args: [p2.end - p2.start, true] });
await U({ op: "call", h: cur, name: "setString", args: ["The replacement sentence."] });

const q = (await U({ op: "query", h, iface: "com.sun.star.document.XRedlinesSupplier" })).value.$h;
const coll = (await U({ op: "call", h: q, name: "getRedlines" })).value.$h;
const pending = (await U({ op: "call", h: coll, name: "getCount" })).value;

const helper = (await U({ op: "create", service: "com.sun.star.frame.DispatchHelper" })).value.$h;
const ctrl = (await U({ op: "call", h, name: "getCurrentController" })).value.$h;
const frame = (await U({ op: "call", h: ctrl, name: "getFrame" })).value.$h;
const dp = (await U({ op: "query", h: frame, iface: "com.sun.star.frame.XDispatchProvider" })).value.$h;
await U({ op: "call", h: helper, name: "executeDispatch",
  args: [{ $h: dp }, ".uno:AcceptAllTrackedChanges", "_self", 0, []] });

const remaining = (await U({ op: "call", h: coll, name: "getCount" })).value;
await U({ op: "set", h, name: "RecordChanges", value: false });
await tools.zetaoffice.save({ action: "export", file_path: "out/tracked.odt", export_format: "odt" });
return { pending, remaining };
```

`pending > 0` then `remaining === 0` is the verification. Do not read
`RedlineText`/`RedlineDescription` (not exposed here).

### Footnote and annotation comment

The `comments` tool is a stub; a real comment is a `TextField.Annotation`.

```js
const U = (o) => tools.zetaoffice.uno(o);
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "writer" });
const h = doc.handle.$h;
await tools.zetaoffice.text({ action: "insert", content: "First paragraph.\\nSecond paragraph.\\n" });

const p1 = await tools.zetaoffice.structure({ action: "paragraph", n: 1 });
const text = (await U({ op: "call", h, name: "getText" })).value.$h;
const cur = (await U({ op: "call", h: text, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: cur, name: "gotoStart", args: [false] });
await U({ op: "call", h: cur, name: "goRight", args: [p1.end - p1.start, false] });
await U({ op: "call", h: cur, name: "collapseToEnd" });
const foot = (await U({ op: "call", h, name: "createInstance",
  args: ["com.sun.star.text.Footnote"] })).value.$h;
await U({ op: "call", h: text, name: "insertTextContent",
  args: [{ $h: cur }, { $h: foot }, false] });

const fns = (await U({ op: "query", h, iface: "com.sun.star.text.XFootnotesSupplier" })).value.$h;
const coll = (await U({ op: "call", h: fns, name: "getFootnotes" })).value.$h;
const fn = (await U({ op: "call", h: coll, name: "getByIndex", args: [0] })).value.$h;
const fcur = (await U({ op: "call", h: fn, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: fn, name: "insertString",
  args: [{ $h: fcur }, "Footnote text.", false] });

const p2 = await tools.zetaoffice.structure({ action: "paragraph", n: 2 });
const c2 = (await U({ op: "call", h: text, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: c2, name: "gotoStart", args: [false] });
await U({ op: "call", h: c2, name: "goRight", args: [p2.end, false] });
await U({ op: "call", h: c2, name: "collapseToEnd" });
const ann = (await U({ op: "call", h, name: "createInstance",
  args: ["com.sun.star.text.TextField.Annotation"] })).value.$h;
await U({ op: "set", h: ann, name: "Author", value: "Reviewer" });
await U({ op: "set", h: ann, name: "Initials", value: "RV" });
await U({ op: "set", h: ann, name: "Content", value: "Comment text." });
await U({ op: "call", h: text, name: "insertTextContent",
  args: [{ $h: c2 }, { $h: ann }, false] });

const fnCount = (await U({ op: "call", h: coll, name: "getCount" })).value;
await tools.zetaoffice.save({ action: "export", file_path: "out/notes.odt", export_format: "odt" });
return { fnCount };
```

The footnote text is inserted through the footnote's own text cursor. The
annotation's `Content`/`Author` and the footnote count are the verification.

### Text watermark

`document create` clears text but not drawing-page shapes, so clear the page
first. Keep the text horizontal: rotated text is visually fine but
`pdftotext` splits it into single letters.

```js
const U = (o) => tools.zetaoffice.uno(o);
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "writer" });
const h = doc.handle.$h;
await tools.zetaoffice.text({ action: "insert", content: "Body text.\\n" });
const pages = (await U({ op: "call", h, name: "getDrawPages" })).value.$h;
const page = (await U({ op: "call", h: pages, name: "getByIndex", args: [0] })).value.$h;
for (let i = (await U({ op: "call", h: page, name: "getCount" })).value - 1; i >= 0; i--) {
  const old = (await U({ op: "call", h: page, name: "getByIndex", args: [i] })).value.$h;
  await U({ op: "call", h: page, name: "remove", args: [{ $h: old }] });
}
const shape = (await U({ op: "call", h, name: "createInstance",
  args: ["com.sun.star.drawing.TextShape"] })).value.$h;
await U({ op: "call", h: page, name: "add", args: [{ $h: shape }] });
await U({ op: "call", h: shape, name: "setSize",
  args: [{ $s: "com.sun.star.awt.Size", Width: 18000, Height: 4000 }] });
await U({ op: "call", h: shape, name: "setPosition",
  args: [{ $s: "com.sun.star.awt.Point", X: 2000, Y: 3000 }] });
await U({ op: "call", h: shape, name: "setString", args: ["WATERMARK"] });
for (const [name, value] of Object.entries({
  CharHeight: { $f: 60 }, CharWeight: { $f: 150 }, CharColor: 12500670,
  TextAutoGrowHeight: false, TextAutoGrowWidth: false, TextWordWrap: false,
  TextHorizontalAdjust: 1, TextVerticalAdjust: 1,
})) await U({ op: "set", h: shape, name, value });
await U({ op: "set", h: shape, name: "ZOrder", value: 0 });

await tools.zetaoffice.save({ action: "export", file_path: "out/watermarked.odt", export_format: "odt" });
await tools.zetaoffice.save({ action: "export", file_path: "out/watermarked.pdf", export_format: "pdf" });
return { shapes: (await U({ op: "call", h: page, name: "getCount" })).value };
```

Replace `WATERMARK` with the required text. The page shape count is the
verification.

### Caption with a live sequence cross-reference

A caption number is a `SetExpression` **sequence** field; the cross-reference
is a `GetReference` field. Use `set_enum` for the numeric/enum properties: a
typed `set` can silently leave them at 0 in this build. That includes the
reference's `SequenceNumber` (a SHORT): it must point at the caption's number
(from `SequenceValue`) or the field stays at 0 and renders
`Error: Reference source not found`.

```js
const U = (o) => tools.zetaoffice.uno(o);
const doc = await tools.zetaoffice.document({ action: "create", doc_type: "writer" });
const h = doc.handle.$h;
const text = (await U({ op: "call", h, name: "getText" })).value.$h;
const cur = (await U({ op: "call", h: text, name: "createTextCursor" })).value.$h;
await U({ op: "call", h: cur, name: "gotoEnd", args: [false] });
await U({ op: "call", h: cur, name: "collapseToEnd" });

const masters = (await U({ op: "call", h, name: "getTextFieldMasters" })).value.$h;
const master = (await U({ op: "call", h: masters, name: "getByName",
  args: ["com.sun.star.text.fieldmaster.SetExpression.Figure"] })).value.$h;
await U({ op: "call", h: text, name: "insertString", args: [{ $h: cur }, "Figure ", false] });

const seq = (await U({ op: "call", h, name: "createInstance",
  args: ["com.sun.star.text.textfield.SetExpression"] })).value.$h;
await U({ op: "call", h: seq, name: "attachTextFieldMaster", args: [{ $h: master }] });
await U({ op: "set_enum", h: seq, name: "SubType", value: 1 });        // SEQUENCE
await U({ op: "set", h: seq, name: "Content", value: "Figure+1" });    // formula
await U({ op: "set_enum", h: seq, name: "NumberingType", value: 4 });  // ARABIC
await U({ op: "set_enum", h: seq, name: "SequenceValue", value: 1 });
await U({ op: "call", h: text, name: "insertTextContent",
  args: [{ $h: cur }, { $h: seq }, false] });
await U({ op: "call", h: text, name: "insertString", args: [{ $h: cur }, ": caption text.", false] });
await U({ op: "call", h: text, name: "insertControlCharacter", args: [{ $h: cur }, 0, false] });

await U({ op: "call", h: text, name: "insertString", args: [{ $h: cur }, "see figure ", false] });
const ref = (await U({ op: "call", h, name: "createInstance",
  args: ["com.sun.star.text.textfield.GetReference"] })).value.$h;
await U({ op: "set_enum", h: ref, name: "ReferenceFieldSource", value: 1 }); // SEQUENCE_FIELD
await U({ op: "set", h: ref, name: "SourceName", value: "Figure" });
await U({ op: "set_enum", h: ref, name: "ReferenceFieldPart", value: 7 });   // ONLY_SEQUENCE_NUMBER
await U({ op: "set_enum", h: ref, name: "SequenceNumber", value: 1 });       // target caption number
await U({ op: "call", h: text, name: "insertTextContent",
  args: [{ $h: cur }, { $h: ref }, false] });

// Re-render fields after a change (DispatchHelper, not just refresh()).
const helper = (await U({ op: "create", service: "com.sun.star.frame.DispatchHelper" })).value.$h;
const ctrl = (await U({ op: "call", h, name: "getCurrentController" })).value.$h;
const frame = (await U({ op: "call", h: ctrl, name: "getFrame" })).value.$h;
const dp = (await U({ op: "query", h: frame, iface: "com.sun.star.frame.XDispatchProvider" })).value.$h;
await U({ op: "call", h: helper, name: "executeDispatch",
  args: [{ $h: dp }, ".uno:UpdateFields", "_self", 0, []] });

const presented = async (field) => (await U({ op: "call", h: field,
  name: "getPresentation", args: [false] })).value;
const updateFields = () => U({ op: "call", h: helper, name: "executeDispatch",
  args: [{ $h: dp }, ".uno:UpdateFields", "_self", 0, []] });

const before = { caption: await presented(seq), reference: await presented(ref) };

await tools.zetaoffice.save({ action: "export", file_path: "out/caption.odt", export_format: "odt" });
return { before };
```

`before` should be `{caption:"1", reference:"1"}`. Without the `SequenceNumber`
call the reference stays `Error: Reference source not found`.

**Renumbering is document order.** Writer numbers sequence fields by their
position, not by `SequenceValue`. Changing `SequenceValue` alone does **not**
change the caption number in this build, so do not use that as the liveness
test. To prove liveness, insert another `Figure` sequence caption *before* this
one and dispatch `UpdateFields`: the first caption and the reference become 2.
`SequenceValue`/`SequenceNumber` are cached values; after a real renumbering,
update the reference's `SequenceNumber` or refresh fields so it follows.

The default field masters (`Figure`, `Illustration`, `Table`, `Text`, `Drawing`)
already exist on a fresh document; `getByName` is safe.

Enum values used: `SetVariableType.SEQUENCE=1`, `NumberingType.ARABIC=4`,
`ReferenceFieldSource.SEQUENCE_FIELD=1`, `ReferenceFieldPart.ONLY_SEQUENCE_NUMBER=7`
(`CATEGORY_AND_NUMBER=5` includes the label). For a sequence field the
`Content` is a formula (`Figure+1`), not a literal label; the displayed number
derives from `SequenceValue`. `getPresentation(false)` returns the displayed
text, `getPresentation(true)` the command.

### Math formula

```
formula {formula:"x = {-b +- sqrt{b^2 - 4ac}} over 2a", display:true}
```
Creates a real embedded Math object. Verify with `formula {action:"list"}`.

### Picture

```
picture {action:"insert", file_path:"picture.png", width_cm:8, height_cm:5}
```

### Save, export, show in the browser

```
save {action:"export", file_path:"out.docx", export_format:"docx"}
document {action:"open_browser"}          # mirrors the current doc into a tab
```

### Bridge lifecycle

```
bridge {action:"status"|"start"|"restart"|"quit"}
```
`restart` reloads `server.mjs` and worker code and waits for health.

---

## 8. Playbook for unknown tasks

Work through this in order; each step removes a class of guessing.

1. **Classify the target.** Which document type and which area: text, cells,
   slides, page, document, or the application itself?
2. **Find the interface.** `describe` the module (e.g. `com.sun.star.sheet`),
   then the interface that matches the area (e.g. `XSpreadsheet`, `XColumnRowRange`).
   Use the IDL docs for descriptions.
3. **Find the container.** Most objects are reached through a supplier or a
   controller: `getText()`, `getSheets()`, `getDrawPages()`,
   `getCurrentController()`, `getStyleFamilies()`, `getTextSections()`.
4. **Find the factory.** Create children with `doc.createInstance(service)`.
   Document content (tables, fields, embedded objects, shapes) must go through
   the document factory; `ServiceManager.createInstanceWithContext` returns null
   for many of these in the Wasm build.
5. **Attach it.** Text content → `insertTextContent`; shape → `page.add`;
   cell data → `setDataArray`; chart → `addNewByName`; style → mutate the style.
6. **Configure it.** `describe` the live object for properties; if a property is
   missing, look for a `getX()` accessor or a sub-object
   (e.g. axis titles come from `getAxisTitle()`).
7. **Verify.** Read the collection count or the value back. If the call was
   void and nothing changed, the mutation silently failed.
8. **Export/verify visually.** `save`, then render/export and check the output.

Common dead ends and their fix:

| Dead end | Likely cause | Next move |
| --- | --- | --- |
| `createInstance` returns null | service not in this build or wrong name | `describe` the module; try `ServiceManager.createInstanceWithContext` |
| A method "does not exist" | wrong interface/accessor | `describe h`; look for `getX` |
| `UnknownPropertyException` | property belongs to a sub-object | `getX()` then describe that object |
| Call succeeds, nothing changes | void no-op (bad CLSID, stale cursor, wrong target) | verify; check `getElementNames()` / counts |
| Wrong document edited | several docs open or two Wasm workers | keep the handle from create/load; the bridge pins one worker per session |
| Handle suddenly invalid | bridge restarted or worker reloaded | re-acquire from `root`; handles are per worker |
| `uno` result looks empty | reading `$h` at top level | use `value.$h` (envelope is `{success, op, value}`) |
| Argument count mismatch | build-specific signature | `describe` the method; follow the reported count |
| Preview looks wrong | cached OLE preview | size at creation; not a data problem |

---

## 9. Gotchas

| Symptom | Cause | Fix |
| --- | --- | --- |
| `set` succeeds but nothing changes | missing value (void Any) | pass `v`; `value` is accepted as an alias; read back |
| `insertTextContent` succeeds, object missing | model could not be created, or cursor is a range | GUID CLSID, `collapseToEnd()`, verify count |
| `[RuntimeException, null]` | LibreOffice raised without a message | read state back, follow the documented order |
| Sequence comes back as a handle | older bridge build | use a fresh tab / restart the bridge |
| Browser tab not updating | stale cached page | reload the tab; the bridge reloads old tabs once |
| `'<tool>' is not implemented` | the active client is an old browser tab | restart the bridge, open a fresh tab, or use `?target=node` |
| Float property rejects a number | integer became Long | use `{"$f":1.5}` for floats |
| Conditional format vanishes on export | `range.ConditionalFormat.addNew()` accepts the entry but it is not attached to the sheet model in this build; the ODS/XLSX writers emit nothing | known engine gap (B3): report it instead of retrying; `XConditionalFormats.createByRange` needs an `XSheetCellRanges` that is not reachable here |
| `set` on an enum property leaves it at 0 | the enum type name is not registered in this build, so a typed Any cannot be built by name | use `uno {op:"set_enum", h, name, value:<number>}`: it takes the Type from the runtime property descriptor |

---

## 10. Adding a recipe

When you work out a new sequence:

1. Reduce it to the generic patterns in §2–§5 (create/attach/verify, supplier,
   property set).
2. Add it here with: intent, exact calls, verification, and the one gotcha that
   cost time.
3. Keep task-specific values (names, paths, numbers) out of the pattern; put
   them in the example only.
