# Document benchmark

Prompts for measuring how long a **fresh agent** (new session, no memory of
earlier work) takes to produce a document through the zetaoffice bridge.

Two groups:

- **A — cookbook-covered:** a recipe exists; the agent should read `cookbook`
  and follow it.
- **B — not covered:** the agent must use `describe` + the module index + the
  IDL docs and compose calls itself. These are the time sinks; if one is slow,
  promote its solution into the cookbook and re-run.

## Fresh agent, every task

This is the core of the benchmark: **one new session per prompt, no shared
context.** A run that reuses a session (or the evaluator's memory of the
cookbook) is invalid.

Checklist before each run:

1. **New session** for the task. Do not carry over files, notes or prior
   conversation.
2. **Clean environment:**
   ```
   node scripts/bench.mjs reset <id>
   ```
   This deletes `bench/out/<id>/`, restarts the bridge
   (fresh Wasm runtime, blank headless document) and waits until it is healthy.
3. **Give the agent only the prompt** plus, in the guided variant, the preamble
   below. Never show it this file, the acceptance checks, or the cookbook.
4. **Assert the toolset** first: `cookbook`, `bridge`, `embed` and `uno` must be
   present, or the run is invalid.
5. **One prompt per session.** Do not run A1 then B4 in the same context.
6. **Score afterwards** with the checks in the table; the agent should not see
   them.
7. **Record** whether the agent opened `cookbook` on its own (matters for the
   cold variant).

## How to run

Run the agent **from the repository root** (the `zetaoffice-mcp` checkout);
all paths below are relative to it.

1. Reset as above.
2. Start the timer when the prompt is delivered, stop when every check passes.
3. Record: wall time, tool calls, failed calls, retries, whether it read the
   cookbook, whether it used `describe`.
4. Grade with `node scripts/bench.mjs check <id>`, then reset again before the
   next prompt.

### Preamble (recommended for the "guided" variant)

> You have the zetaoffice MCP for LibreOffice. First call `bridge {action:"status"}`
> and `cookbook`. **If either tool is missing, reply exactly `STALE MCP` and
> stop — do not work around it with shell or other tools.** Otherwise prefer the
> high-level tools (`document`, `text`, `sheet`, `embed`, `save`). Use `uno`
> with `describe` only when the cookbook has no recipe. Verify results by
> reading state back, then report the file paths.

The `STALE MCP` abort is part of the protocol: a run on an older server does not
measure the current improvements.

### Cold variant

Omit the preamble. Compare guided vs cold to see whether the tool descriptions
alone make the cookbook discoverable.

### Targets

| Group | Tool calls | Wall time |
| --- | --- | --- |
| A (cookbook) | ≤ 8 | ≤ 90 s |
| B (novel) | ≤ 20 | ≤ 5 min |

A B-prompt over 5 minutes means: add a recipe, then re-run it as an A-prompt.

## Measurement quality

A run is only valid if the environment and the grading are fixed.

**Freeze the environment**

- Same MCP server build for every run: assert `cookbook`, `bridge`, `embed` and
  `uno` are available *before* starting; record the repo commit.
- One bridge, restarted before every run (`node scripts/bench.mjs reset <id>`).
- Target the headless runtime (or one freshly opened tab) so an old browser tab
  with stale worker code cannot answer instead.
- No unrelated documents open.

**Grade mechanically**

- Put checks in a script, not prose. `node scripts/bench.mjs check <id>` runs
  `scripts/bench_check.py` (file size, zip entries, cells, `pdftotext`);
  prompts without a mechanical check print `MANUAL`.
- Pass = every check; partial = list which failed.
- Repeat 3× per prompt and report the median and range.

**Separate the two costs**

- *Discovery*: `cookbook`, `describe`, docs reads, unknown/failed tool calls.
- *Execution*: mutating calls (`set`, `call`, `insert*`, `save`).
- The cookbook should shrink discovery, not execution. If only execution moves,
  the recipe is not teaching anything.

**Held-out set**

- Keep at least six novel prompts that were never used to write the cookbook,
  and rotate them after each cookbook change.
- Promote a concept only when it recurs in at least two held-out tasks.

**Counterfactual**

- Run each novel prompt with and without the cookbook (guided vs cold).
- If the cookbook does not reduce calls or time for that task class, it is not
  helping — remove or generalize it.

## A — cookbook-covered

| ID | Prompt | Acceptance checks |
| --- | --- | --- |
| A1 | Create `bench/out/A1/letter.odt`: title "Notice of Inspection", a date line, two body paragraphs. Export `letter.pdf` beside it. | ODT > 5 KB; PDF > 5 KB; first paragraph style is `Title`; text contains the date line |
| A2 | Create `bench/out/A2/weights.xlsx`: columns `Date`, `Weight (g)` with 5 weekly rows (increasing weights), and a line chart with X = Date, Y = Weight (g). | xlsx exists; one chart in the package; header row bold; values match |
| A3 | Create `bench/out/A3/report.odt` with a title, one paragraph, then an embedded Calc sheet (2 columns × 4 rows) below it. Save ODT and DOCX. | ODT contains `Object 1/`; DOCX contains `word/embeddings/`; object count is 1 |
| A4 | Create `bench/out/A4/report.odt` with an embedded Calc sheet, fill it with 6 rows (header + 5 data rows), add a column chart, and export `report.pdf` beside it. Save the ODT too. | ODT has an embedded sheet; 6 rows; chart present; PDF exists |
| A5 | Insert `x = {-b +- sqrt{b^2 - 4ac}} over 2a` as a native Math object into a new Writer document; save `formula.odt`. | ODT contains a Math object (`Object 1`); formula text present |
| A6 | Create a Calc sheet with a header row, freeze it, bold it, set column widths, and export `table.xlsx`. | freeze pane on row 1; bold header; widths set; xlsx exists |
| A7 | Use `describe` to list the methods of `com.sun.star.text.XText` and report the signature of `insertString`. | answer names all params with types/modes; no document needed |
| A8 | Create `bench/out/A8/note.odt` with a heading and a paragraph, export it as DOCX and PDF, and open it in the browser. | ODT, DOCX and PDF exist; a browser tab shows the document |
| A9 | Restart the bridge cleanly and confirm it is healthy. | health green after restart; one Wasm runtime; no orphan processes |
| A10 | Create `bench/out/A10/note.odt` with a heading and a paragraph, then insert a local PNG as a picture below it. Save ODT. | picture count 1; image bytes embedded; ODT exists |

## B — not covered by the cookbook

| ID | Prompt | Acceptance checks |
| --- | --- | --- |
| B1 | Create a Writer document with a 5×3 table (`Item`, `Qty`, `Price`), fill 4 rows, and a total row whose Price cell sums the column. Export ODT. | native table (not embedded); 5 rows; formula evaluates to the correct total |
| B2 | Create a Writer document with A4 landscape, 1.5 cm margins, a "Confidential" header and a footer with page numbers. Export PDF. | page setup reflects the values; PDF contains header and page number |
| B3 | Create a Calc sheet titled "Budget" (merged A1:C1), amounts in C formatted as currency, and a conditional format that highlights Qty > 10. | merge exists; currency number format; one conditional rule |
| B4 | Add a bookmark named `intro` to paragraph 2 and a hyperlink from paragraph 1 that jumps to it, plus an external `https://` link. | bookmark exists; internal link targets `#intro`; external URL present |
| B5 | Enable track changes, edit one sentence, list the pending changes, then accept them all. | changes recorded then zero pending; text updated |
| B6 | Add a footnote to paragraph 1 and a comment to paragraph 2. | one footnote; one comment anchored to p2 |
| B7 | Create a document with three Heading 1 sections, insert a table of contents, and update the fields. | TOC present with 3 entries; field results populated |
| B8 | Create a Calc sheet with `Category` and `Amount` (10 rows), then build a pivot table summing Amount by Category. | pivot exists; sums correct; native pivot object present |
| B9 | Create a 3-slide presentation: title slide, bullets slide, closing slide. Save `deck.pptx`. | 3 slides; title + bullets text; pptx opens |
| B10 | Export a Writer document to PDF with a "DRAFT" watermark. | watermark visible in the PDF |
| B11 | Create a document with a figure caption and a cross-reference ("see figure 1") that updates when the caption number changes. | caption + REF field; reference text resolves |
| B12 | Create a Calc sheet with dates in A and values in B, insert a chart, and make the X axis use a date axis instead of text categories. | axis uses dates; labels formatted as dates |

## Recording

```
id,group,guided,wall_seconds,tool_calls,failed_calls,read_cookbook,used_describe,pass,notes
A1,A,1,,,,,,,
B1,B,0,,,,,,,
```

## Feedback loop

- B-prompt passes in ≤ 5 min → leave it as a generalization test.
- B-prompt is slow or fails → capture the working sequence, add a recipe to
  `docs/cookbook.md`, move the prompt to group A, and re-run it cold.
