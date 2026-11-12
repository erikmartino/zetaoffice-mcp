# Deterministic layout API

`layout` is a thin, UNO-native layer on top of the existing bridge. UNO remains
the document model and the layout engine. The tool adds the four things UNO does
not give an agent directly:

1. stable, absolute paths instead of cursor/selection state
2. undo-group batches with a revision
3. measurement from the live layout
4. geometric diagnostics

It deliberately does **not** mirror UNO into a second document tree. Every
mutation and every measurement goes through the UNO JS bridge.

## Paths

Paths are resolved fresh on every call. They survive save/reload when they refer
to a named object (bookmark, frame, table, shape).

| Path | Object |
| --- | --- |
| `doc` | active document |
| `doc/body` | body text |
| `doc/body/p[3]` | paragraph 3, 1-indexed |
| `doc/body/bookmark:intro` | bookmark anchor |
| `doc/body/frame:sidebar` | text frame |
| `doc/body/table:Budget` | Writer table |
| `doc/body/table:Budget/row[2]/cell[3]` | Writer table cell |
| `doc/body/image:logo` | embedded picture |
| `doc/body/object:Object1` | embedded object |
| `doc/sheets[0]/cell:A1` | Calc cell |
| `doc/sheets:Data/cell:A1:B5` | Calc range |
| `doc/drawpage/shape:Chart1` | shape by name |

Use `bookmark` to give a paragraph a durable name:

```json
{ "action": "bookmark", "path": "doc/body/p[3]", "name": "summary" }
```

For shapes the action sets the shape's `Name`; for paragraphs it inserts a real
LibreOffice bookmark.

## Actions

| Action | Purpose |
| --- | --- |
| `resolve` | path -> `{ kind, handle, preview }` |
| `begin` | open an undo group for a batch |
| `apply` | apply `set` / `call` / `insert_text` / `bookmark` ops |
| `commit` | close the group, increment `rev`, return `hash` |
| `rollback` | close the group and undo it |
| `measure` | boxes for one or more paths |
| `check` | geometric diagnostics |
| `status` | revision, open transaction, page count, hash |

`set` always goes through `setPropertyValue` with an explicitly typed `Any`;
plain JS assignment on a ZetaJS proxy can silently no-op for paragraph
properties. Every `set` is read back and returned.

## Example: a checked batch

```json
{ "action": "begin" }
```

```json
{
  "action": "apply",
  "ops": [
    { "op": "set", "path": "doc/body/p[1]",
      "values": { "ParaStyleName": "Title" } },
    { "op": "set", "path": "doc/body/p[1]",
      "values": { "ParaAdjust": { "$e": "com.sun.star.style.ParagraphAdjust", "v": "CENTER" } } },
    { "op": "set", "path": "doc/body/p[2]",
      "values": { "ParaTopMargin": 500 } },
    { "op": "bookmark", "path": "doc/body/p[3]", "name": "summary" }
  ]
}
```

```json
{ "action": "check", "paths": ["doc/body/p[1]", "doc/body/p[2]", "doc/body/p[3]"],
  "inside_page": true, "no_overlap": true }
```

```json
{ "action": "commit" }
```

If `apply` throws after a mutation, it rolls the open group back and reports
that in the error. Explicit `rollback` does the same without committing.

## Measurement

Writer text is measured with the view cursor: the start and end of the range are
resolved to page coordinates, and the box is derived from those positions. Shape
bounds come from `XShape`. Calc cells and ranges are measured from the sheet's
column widths and row heights.

```json
{ "action": "measure", "paths": ["doc/body/p[1]", "doc/sheets[0]/cell:A1"] }
```

Returns:

```json
{
  "success": true,
  "page": { "width": 21001, "height": 29700, "name": "Standard" },
  "page_count": 1,
  "boxes": [
    { "path": "doc/body/p[1]", "kind": "text-range",
      "box": { "x": 0, "y": 0, "w": 3074, "h": 423, "page": 1, "basis": "view-cursor" } }
  ]
}
```

Multi-line text has `w: null` because a single end position cannot describe the
widest line; the height is still meaningful. Lengths are 1/100 mm.

## Checks

`check` currently reports:

- `outside_page` - a box starts or ends outside the page (tolerance configurable)
- `overlap` - two boxes intersect (skip with `no_overlap:false` or allow pairs)
- `text_overflow` - text in a frame needs more height than the frame provides
  (`text_fits:true`)

```json
{
  "action": "check",
  "paths": ["doc/body/frame:sidebar", "doc/body/image:logo"],
  "text_fits": true,
  "allow_overlap": [["doc/body/frame:sidebar", "doc/body/image:logo"]]
}
```

`ok` is true only when `diagnostics` is empty. Silent clipping is not detected
inside arbitrary embedded objects yet; treat `text_overflow` as a text-frame
check, not a universal guarantee.

## Determinism

- `rev` increments on commit; a rollback keeps the previous revision.
- `hash` is a stable FNV-1a over paragraph styles/text, Calc used ranges,
  slide count and page count. A no-op commit keeps the hash; changing a cell
  changes the hash.
- For cross-run determinism, pin the engine build and the fonts. The document
  hash above is model-level; it does not promise identical PDF bytes across
  LibreOffice versions.
- Batches use LibreOffice's undo manager. `set`, `insert_text` and `bookmark`
  are undoable; arbitrary `call` operations are only as undoable as the UNO API
  they invoke.

## Tests

```sh
node scripts/layout_smoke.mjs       # HTTP bridge, resolver/batch/measure/rollback
node scripts/layout_mcp_test.mjs    # spawns a fresh MCP stdio server, calls layout
```

Both default to `http://localhost:8765` and `LIBREOFFICE_TARGET=node`.
