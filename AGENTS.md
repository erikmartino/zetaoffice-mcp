# AGENTS.md — working notes for agent sessions

This repo is a LibreOffice WebAssembly MCP bridge (ZetaJS + LOWA). These notes
are for any agent picking it up; they are the distilled version of the mistakes
that cost time.

## First moves

```
bridge   {action:"status"}          # or: curl -s localhost:8765/health
cookbook {topic:"<area>"}           # read the recipe before writing UNO by hand
```

- Read `docs/cookbook.md` before composing UNO calls.
- Use `uno {op:"describe", type:"com.sun.star.<module>"}` → interface →
  live object (`h`) before guessing names.
- Full IDL: https://api.libreoffice.org/docs/idl/ref/ and the raw `.idl` files.

## Golden rules

1. **Verify every void mutation.** `insertTextContent`, `setPropertyValue`,
   `add`, `remove` return nothing on success *and* on silent no-ops. Read the
   collection count or value back.
2. **Use the high-level tools first** (`document`, `text`, `sheet`, `embed`,
   `save`). `uno` is the escape hatch, not the default.
3. **`set` needs `v`** (MCP also accepts `value`). Use `null` to clear.
4. **Properties vs accessors.** If `describe` does not list a property, look for
   `getX()` (`getAxisTitle`, `getEmbeddedObject`, `getTextTables`).
5. **Embedded objects need GUID CLSIDs**, not service names; the table is in the
   cookbook. Get the model with `getEmbeddedObject()`, not `Model`.
6. **Cursor state matters.** Collapse to end (`gotoEnd(false)`,
   `collapseToEnd()`) before `insertTextContent`; a range cursor no-ops.
7. **Do not kill MCP stdio servers.** They are tied to the client's pipes.
   Restart the *bridge* with `bridge {action:"restart"}` (or
   `curl -X POST localhost:8765/restart`). Killing the stdio process removes the
   tools from the session.
8. **Never benchmark on a stale MCP.** If `cookbook`/`bridge` are missing, abort
   with `STALE MCP` — do not work around it. `scripts/bench.mjs reset` also
   refuses when the running `start.mjs` predates `mcp_stdio_server.mjs`.
9. **Stale browser tabs lie.** The bridge prefers the newest ready browser tab;
   an old tab can answer with "not implemented". Restart the bridge, open a
   fresh tab, or target `?target=node` for headless work.
10. **One client, one document.** `document {action:"create"}` returns
    `handle: {$h}` — use it for UNO. `getCurrentComponent()` may be a different
    open document, and the root → Desktop crawl wastes calls.
11. **Paths belong to the checkout.** `save`/`picture` resolve relative paths
    against the repo root; prefer absolute paths. Never search `/` for output.
12. **Pin headless runs to the node runtime.** Set `LIBREOFFICE_TARGET=node`
    (already in the MCP config). Do not open browser tabs during headless work;
    a reconnecting tab can take over the session mid-document.
13. **Embedded sheet + chart is one call.** Use
    `embed {values, chart:{title,x_title,y_title}}`; it also sizes the OLE
    preview. Do not hand-build chart2, and do not use the failed
    supplier/control `setVisualAreaSize` path.
14. **Track changes has no high-level support.** Set `RecordChanges` on the
    model; accept with `DispatchHelper.executeDispatch(".uno:AcceptAllTrackedChanges")`.
15. **`set_enum` is the general fix for silent 0s.** Short and enum
    properties can be inferred as Long by `set`: `NumberingLevel`, `AxisType`,
    `SequenceValue`, `ReferenceFieldSource`, `ReferenceFieldPart`. `set_enum`
    reads the Type from the property descriptor and works; read the value back.
16. **Conditional formatting is a known engine gap.** The range-level
    `ConditionalFormat` entries are not serialized to ODS/XLSX in this build.
    Do not spend calls on it; note the limitation.
17. **Verify with tool reads, not artifacts.** Read state back
    (`structure`, `sheet read`, `embed` counts). Do not unzip packages, run
    `pdftoppm`, or inspect screenshots to find out what happened.

## Benchmark discipline

- **Task-solving first.** Recipes must generalize: no prompt-specific values,
  test IDs or output paths in the cookbook. A correct, reusable recipe beats a
  brittle fast one.
- **Timing is a diagnostic, not a gate.** A novel prompt may exceed 30 s; do not
  contort the cookbook to make one known prompt fast.
- **Do not chase engine gaps.** If something cannot serialize (e.g.
  conditional formats), document it and move on; minutes spent reverse-
  engineering a broken path are wasted.
- One **fresh agent/session per prompt**. Never reuse context or prior results.
- Reset between runs: `node scripts/bench.mjs reset <id>` (cleans output,
  restarts the bridge).
- Follow the matching cookbook recipe; its responses are the verification.
  Extra `uno` reads to re-check charts/axes are wasted time. No filesystem
  spelunking, no images.
- Freeze the toolset: verify the running MCP server has the current tools
  (`cookbook`, `bridge`, `embed`, `uno`) before starting; otherwise the run is
  invalid.
- Grade with `node scripts/bench.mjs check <id>` (mechanical), not prose. Repeat
  runs (N≥3) and use medians.
- Promote **concepts**, not task specifics: add a recipe only when the same
  mechanism recurs in unknown tasks; strip task values from the pattern.

## Commit cadence

- Commit coherent units when a change is verified (tool + docs + recipe).
- Do not leave the tree dirty across sessions; push to `origin/main`.
- Keep `docs/cookbook.md` and this file current — they are the agent's memory.

## Layout

| Path | What |
| --- | --- |
| `server.mjs` | HTTP/WS bridge, `/quit`, `/restart`, `/tools/*` |
| `public/office_thread.js` | worker: UNO tools, `uno` ops, embed, charts |
| `public/index.html` | live canvas page |
| `mcp_stdio_server.mjs` | MCP tool definitions (`document`, `text`, `sheet`, `embed`, `cookbook`, `bridge`, `uno`) |
| `docs/cookbook.md` | recipes + unknown-task playbook |
| `docs/benchmark.md` | fresh-agent benchmark protocol |
| `scripts/bench.mjs` | run helpers (`list`, `reset`, `start`, `stop`, `summary`) |
| `scripts/gen-uno-index.mjs` | regenerates `public/uno-index.js` from the IDL docs |
