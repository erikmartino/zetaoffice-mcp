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

---

## 1. Quickstart

```
bridge   {action:"status"}                  # is the Wasm runtime up?
cookbook {topic:"embed"}                    # read the matching recipe
document {action:"create", doc_type:"writer"}
text     {action:"insert", content:"Title\nBody text\n"}
text     {action:"style", style_name:"Title", paragraph_n:1}
save     {action:"export", file_path:"out.odt", export_format:"odt"}
```

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
```

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
embed {service:"calc", width_mm:160, height_mm:95, values:[["Date","Weight (g)"],…]}
  -> {name, clsid, object:{$h}, model:{$h}}
```

It sets the GUID CLSID, anchor, size, inserts, verifies `getElementNames()`
grew, and returns the model. Then use `model` with `uno`.

Raw sequence and the CLSID table are in §R1/R7; the important bits:

- `CLSID` accepts **GUIDs only** (calc `47BBB4CB-CE4C-4E80-A591-42D9AE74950F`,
  writer `8BC6B165-…`, impress `9176E48A-…`, draw `4BAB8970-…`,
  math `078B7ABA-…`).
- `getEmbeddedObject()`, not the `Model` property.
- The OLE preview is captured at creation; set the size before inserting.

### Fill an embedded sheet and add a chart

Use `model` from `embed` exactly like a Calc document: `getSheets()` →
`getByIndex(0)` → `getCellRangeByName("A1:B10")` → `setDataArray`, then §R6.

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
   If that returns null, try the document's `ServiceManager`
   (`createInstanceWithContext`) or check the service name in the IDL docs.
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
| Wrong document edited | several docs open | keep the handle from create/load; don't rely on `getCurrentComponent` |
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

---

## 10. Adding a recipe

When you work out a new sequence:

1. Reduce it to the generic patterns in §2–§5 (create/attach/verify, supplier,
   property set).
2. Add it here with: intent, exact calls, verification, and the one gotcha that
   cost time.
3. Keep task-specific values (names, paths, numbers) out of the pattern; put
   them in the example only.
