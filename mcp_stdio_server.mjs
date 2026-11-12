#!/usr/bin/env node
/**
 * MCP Stdio Server for ZetaJS WebAssembly LibreOffice Bridge
 * 
 * Provides the consolidated editing tools plus the high-level `table`, `page`,
 * `field` and `sheet` capability layer, with action signatures inspired by the
 * native mcp-libre server (libreoffice_mcp_server.py).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { patchXlsxFreeze } from "./xlsx_freeze.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIBREOFFICE_URL = process.env.LIBREOFFICE_URL || "http://localhost:8765";

// Freeze requests are keyed by sheet name and applied to exported xlsx files.
// The headless runtime has no attached view, so the filter cannot write panes.
const freezeSpecs = new Map();
// Pin tool calls to one Wasm host. Browser tabs reconnect asynchronously and can
// take over mid-document; "node" keeps a session deterministic (headless work).
const TARGET = process.env.ZETAOFFICE_TARGET || process.env.LIBREOFFICE_TARGET || "";

// Relative output paths belong to the checkout, not to whatever cwd the MCP
// client happened to launch us from.
function resolveHostPath(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.env.ZETAOFFICE_WORKDIR || __dirname, p);
}

let bridgeProcess = null;

async function checkHealth(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'healthy';
  } catch {
    return false;
  }
}

async function isWasmReady(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const data = await res.json();
    // Newer bridges report runtime_connected for Node or browser hosts. Keep the
    // old browser_connected check as a fallback for already-running bridges.
    return (data.runtime_connected ?? data.browser_connected) === true;
  } catch {
    return false;
  }
}

async function ensureBridge() {
  const isHealthy = await checkHealth(LIBREOFFICE_URL);
  if (isHealthy) {
    return;
  }

  // Only auto-spawn if running against localhost
  if (!LIBREOFFICE_URL.includes("localhost") && !LIBREOFFICE_URL.includes("127.0.0.1")) {
    return;
  }

  console.error(`[MCP] LibreOffice bridge not running at ${LIBREOFFICE_URL}. Auto-spawning Wasm bridge...`);

  const serverScript = path.join(__dirname, 'server.mjs');
  // Default: run the Wasm runtime under Node.js. Set LOWA_NODE=0 to fall back
  // to the headless Chrome runner.
  const useNodeRuntime = process.env.LOWA_NODE !== '0' && process.env.LOWA_NODE !== 'false';
  const isHeadless = process.env.HEADLESS !== 'false' && process.env.HEADLESS !== '0';
  const args = [serverScript];
  if (useNodeRuntime) {
    args.push('--node');
  } else if (isHeadless) {
    args.push('--headless');
  } else {
    args.push('--browser');
  }

  bridgeProcess = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env }
  });

  if (bridgeProcess.stdout) {
    bridgeProcess.stdout.on('data', (d) => {
      // Forward bridge logs to stderr so stdout remains pure JSON-RPC
      process.stderr.write(d);
    });
  }

  // Wait for server to become healthy and Wasm runner to connect (up to 15s)
  const startTime = Date.now();
  while (Date.now() - startTime < 15000) {
    await new Promise(r => setTimeout(r, 500));
    if (await isWasmReady(LIBREOFFICE_URL)) {
      console.error(`[MCP] LibreOffice Wasm bridge is ready and connected!`);
      return;
    }
  }
  console.error(`[MCP] Warning: Bridge started, but Wasm runner not yet confirmed connected.`);
}

function cleanupBridge() {
  if (bridgeProcess) {
    try {
      bridgeProcess.kill('SIGTERM');
    } catch {}
    bridgeProcess = null;
  }
}

process.on('exit', cleanupBridge);
process.on('SIGINT', () => { cleanupBridge(); process.exit(0); });
process.on('SIGTERM', () => { cleanupBridge(); process.exit(0); });

const server = new McpServer(
  {
    name: "zetaoffice",
    version: "1.0.0"
  },
  {
    instructions:
      "LibreOffice (WebAssembly) with ONE active document. " +
      "Workflow: document(create) -> text(insert) -> structure(count|paragraph) -> selection(paragraph|range) -> text(format|style) -> save(export). " +
      "text(insert) creates real paragraphs from \"\\n\"; there is no Markdown parsing. " +
      "Formatting only affects the ACTIVE SELECTION: call selection first and check its returned {start,end,text}. " +
      "Paragraph numbers are 1-indexed; character offsets are 0-based. " +
      "formula(insert) creates a native, editable LibreOffice Math object (StarMath syntax, not LaTeX); formula(list|update|delete) manages them. " +
      "picture(insert, file_path) embeds a local png/jpg/gif/bmp as an inline graphic. " +
      "Style CRUD, per-change track changes and persistent comments are not implemented in the WASM bridge. " +
      "Full notes: resource libreoffice://guide."
  }
);

// Helper function to call the ZetaJS Wasm HTTP bridge
async function callLibreoffice(endpoint, method = "POST", data = {}) {
  await ensureBridge();
  try {
    const options = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    if (method === "POST") {
      options.body = JSON.stringify(data);
    }
    let url = `${LIBREOFFICE_URL}${endpoint}`;
    if (TARGET && endpoint.startsWith("/tools")) {
      url += (endpoint.includes("?") ? "&" : "?") + "target=" + encodeURIComponent(TARGET);
    }
    const res = await fetch(url, options);
    return await res.json();
  } catch (err) {
    return {
      error: `Cannot connect to LibreOffice Wasm bridge at ${LIBREOFFICE_URL}. Error: ${err.message}`
    };
  }
}

function jsonResponse(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
  };
}

// Consistent, actionable error envelope for rejected calls.
function toolError(action, message, suggestion) {
  const payload = { success: false, action, error: message };
  if (suggestion) payload.suggestion = suggestion;
  return jsonResponse(payload);
}

const GUIDE = `# LibreOffice WASM MCP - working notes

One document is active at a time (a Writer canvas by default). Everything below
operates on that document; \`document action=create\` throws the current one away.

## Recommended workflow

1. \`document\` \`{action:"create", doc_type:"writer"}\` - start clean.
2. \`text\` \`{action:"insert", content:"Title\\nSubtitle\\n\\nBody paragraph..."}\`
   - \`\\n\` creates real paragraphs (not line breaks). Blank lines = empty paragraphs.
   - Inserts at the cursor / replaces the current selection.
   - There is no Markdown parsing: \`#\`, \`**\`, lists etc. are literal text.
3. \`structure\` \`{action:"count"}\` / \`{action:"paragraph", n:1}\`
   - Paragraphs are 1-indexed. Each paragraph returns \`start\`/\`end\` (0-based
     character offsets; the paragraph mark counts as one character).
4. \`selection\` then \`text\` \`{action:"format"}\`
   - Character formatting applies to the selection, so select first.
   - \`selection {action:"paragraph", n}\` selects one paragraph's text.
   - \`selection {action:"range", start, end}\` selects arbitrary characters
     (end exclusive) - use \`structure.paragraph\` offsets.
5. \`text\` \`{action:"style", style_name:"Title", paragraph_n:1}\` for paragraph
   styles (Title, Subtitle, Heading 1-3, Standard, Text body, Quotations,
   Preformatted Text). Style names are matched case/space-insensitively.
6. \`formula\` \`{action:"insert", formula:"e^{i %pi} + 1 = 0"}\` for a native,
   editable LibreOffice Math object (StarMath syntax, not LaTeX).
   - \`display\` (default true) puts it on its own paragraph; \`align\` is
     left|center|right. \`list\`, \`update\` and \`delete\` manage existing objects.
7. \`picture\` \`{action:"insert", file_path:"/abs/portrait.jpg", width_cm:4.5}\`
   - Embeds a real inline graphic (png/jpg/gif/bmp). \`display\` (default true)
     puts it on its own paragraph; \`align\` is left|center|right.
8. \`save\` \`{action:"export", file_path:"/abs/path/out.odt", export_format:"odt"}\`
   - The file is written on the MCP server's filesystem. Use an absolute path.

## High-level operations (prefer these)

- \`table {action:"create", values:[[...]], total_column:2}\` - native Writer
  table; the total row uses a Writer sum formula.
- \`page {action:"setup", orientation, margins_cm}\` and
  \`page {action:"header_footer", header, footer, page_number}\`.
- \`field {action:"bookmark"|"link"|"caption_pair", ...}\` - bookmarks, internal
  links and numbered captions with a real GetReference.
- \`sheet {action:"sheet_create"|"sheet_rename"|"sheet_activate"|"validation"|
  "named_range"|"freeze", ...}\` - Calc structure and data rules; \`chart\` accepts
  \`date_axis:true\`.
- Validation serializes in xlsx; the ODS export does not write it. The headless
  exporter cannot write frozen panes, so the MCP save layer patches xlsx and
  reports \`freeze_patched\`.

## Presentations (Impress)

\`document\` \`{action:"create", doc_type:"presentation", slides:[...]}\` builds a
real Impress deck: one 16:9 slide per entry, laid out with drawing text shapes
and exported with \`save\` (\`odp\`, \`pptx\`, \`ppt\`, \`pdf\`). Each slide accepts:

- \`title\` - slide headline.
- \`text\` - body copy; \`\\n\` starts a new paragraph (use "• " for bullets).
- \`notes\` - speaker notes, stored on the slide's notes page.
- \`kicker\` - small uppercase label above the title (e.g. "At a Glance").
- \`layout\` - \`cover\` (default for slide 1), \`content\`, \`section\`,
  \`closing\`, \`stats\` or \`steps\`.
- \`stats\` - for \`layout:"stats"\`: up to 4 \`{value, label}\` figures.
- \`steps\` - for \`layout:"steps"\`: up to 4 \`{title, text}\` process columns.

The design is a navy/gold corporate system: 16:9 pages, serif headlines, a
gold-framed cover, section dividers with oversized part numbers, and a
consistent footer. Section/closing/stats/steps slides are fully drawn. There is
no Markdown parsing on slides either. The bridge clears the default
placeholders, so the deck is fully generated by the supplied values.

## Key behaviours and gotchas

- The selection is stateful: it persists until you change it. Always call
  \`selection\` immediately before \`text(format)\`; check the returned
  \`selection\` object (start/end/text) to confirm what you are formatting.
- \`text(format)\` without a selection sets typing attributes at the cursor; it
  does not retroactively format existing text.
- Formatting is direct character formatting; \`text(style)\` changes the
  paragraph style. Direct formatting wins over styles (e.g. a 18pt run stays
  18pt after applying the Title style).
- Re-running \`document(create)\` mid-task resets the cursor, selection and
  typing attributes (back to 12pt normal).
- Export formats: odt, docx, pdf, html, txt (Writer); odp, pptx, ppt, pdf
  (Impress); ods via the same export list where available.
- \`formula(insert)\` makes a real Math OLE object; it needs the Math module in
  the Wasm build. After inserting, the shared cursor sits just after the object.
  A formula inserted mid-document splits/creates paragraphs when \`display\` is
  true, so re-read \`structure\` offsets afterwards.
- formulas are enumerated through the document's XTextEmbeddedObjectsSupplier
  (they are not text portions). \`formula(list)\` returns them in object order.
- Export fidelity: odt keeps the Math object exactly; docx converts it to OMML
  and LibreOffice can drop complex layout (e.g. integral limits) in that
  conversion; pdf is a rendered snapshot.
- \`layout\` is the absolute, repeatable path API: \`doc/body/p[3]\`,
  \`doc/body/table:Budget/row[2]/cell[3]\`, \`doc/sheets[0]/cell:A1\`.
  Batch with begin/apply/check/commit; rollback uses the UNO undo manager.
  \`measure\` and \`check\` query the live layout for boxes, page bounds and
  text overflow. Use it instead of cursor gymnastics when a task needs many
  related edits.
- Not implemented in the WASM bridge (return an error): \`document\` style CRUD
  (\`create_style\`, \`edit_style\`, \`delete_style\`, \`style_properties\`),
  per-change track-changes review, and persistent comments.
- An empty document still contains one empty paragraph; \`structure.count\` = 1.
`;

// Help agents discover the guide without a tool call.
try {
  server.registerResource(
    "guide",
    "libreoffice://guide",
    {
      title: "LibreOffice WASM MCP guide",
      description:
        "Workflow, coordinate conventions and gotchas for the LibreOffice WASM tools (read before multi-step editing).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }],
    })
  );
} catch (e) {
  // Older SDKs without resource support: the same text is in each tool description.
}

// The Wasm document is serialized in the browser and returned as base64 in the
// bridge response. Write it to the host filesystem so the MCP client gets a real file.
function persistSaveResult(result, fallbackPath) {
  if (!result || typeof result !== "object") return result;
  if (result.encoding !== "base64" || !result.data) {
    if (result.success && result.format) {
      return {
        success: false,
        error: `The ${result.format} document was produced but its bytes could not be read from the Wasm filesystem.`,
        suggestion: "Retry the export. If it keeps failing, restart the bridge runtime (its in-memory filesystem may be in a bad state).",
      };
    }
    return result;
  }
  try {
    let target = resolveHostPath(result.file_path || fallbackPath);
    if (!target) {
      const dir = path.join(process.env.ZETAOFFICE_WORKDIR || __dirname, "mcp-libre-output");
      target = path.join(dir, result.filename || `document.${result.format || "odt"}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buffer = Buffer.from(result.data, "base64");
    fs.writeFileSync(target, buffer);
    return {
      success: true,
      message: `${result.action === "export" ? "Exported" : "Saved"} document to ${target}`,
      file_path: target,
      format: result.format,
      bytes: buffer.length
    };
  } catch (err) {
    return { success: false, error: `Failed to write file: ${err.message}` };
  }
}

// Persist a save/export and apply any pending frozen-pane metadata to xlsx.
function persistWithFreeze(result, fallbackPath) {
  const saved = persistSaveResult(result, fallbackPath);
  if (saved && saved.success && saved.format === "xlsx" && freezeSpecs.size) {
    try {
      const patch = patchXlsxFreeze(saved.file_path, Object.fromEntries(freezeSpecs));
      saved.freeze_patched = patch.patched;
      if (patch.missing.length) saved.freeze_missing = patch.missing;
    } catch (err) {
      saved.freeze_warning = `Could not patch frozen panes: ${err.message}`;
    }
  }
  return saved;
}

// =============================================================================
// CONSOLIDATED TOOL 1: document
// Actions: create, info, list, content, status, styles,
//          create_style, edit_style, delete_style, style_properties
// =============================================================================
server.tool(
  "document",
  `Manage the single active LibreOffice/WASM document.

Actions:
- create: start a fresh document (doc_type writer|calc|impress|draw). Discards the current one.
- info: type, title, character/word and page counts.
- content: full plain text (paragraphs separated by "\\n").
- styles: list paragraph style names usable with text(style).
- list / status: active document info / bridge health.

Style CRUD (create_style, edit_style, delete_style, style_properties) is NOT implemented in the WASM bridge - it returns an error. Use the built-in styles via text(style) instead (Title, Subtitle, Heading 1-3, Standard, Text body, Quotations, Preformatted Text).

Typical flow: document(create) -> text(insert) -> structure(count|paragraph) -> selection(paragraph|range) -> text(format|style) -> save(export). See resource libreoffice://guide.`,
  {
    action: z.enum([
      "create", "info", "list", "content", "status",
      "styles", "create_style", "edit_style", "delete_style", "style_properties",
      "open_browser"
    ]).describe("Operation to perform. 'open_browser' shows the live canvas in a desktop browser."),
    doc_type: z.enum(["writer", "calc", "impress", "draw", "presentation"]).default("writer").describe("Document type for 'create' (use 'presentation' for slides)"),
    style_name: z.string().optional().describe("Style name for create_style / edit_style / delete_style / style_properties (not implemented in the WASM bridge)"),
    parent_style: z.string().optional().describe("Parent style for create_style / edit_style (default: Standard)"),
    font_name: z.string().optional().describe("Font family for create_style / edit_style"),
    font_size: z.number().optional().describe("Font size in points for create_style / edit_style"),
    bold: z.boolean().optional().describe("Bold weight for create_style / edit_style"),
    italic: z.boolean().optional().describe("Italic posture for create_style / edit_style"),
    underline: z.boolean().optional().describe("Underline for create_style / edit_style"),
    alignment: z.enum(["left", "right", "center", "justify"]).optional().describe("Alignment for create_style / edit_style"),
    slides: z.array(z.object({
      title: z.string().optional(),
      text: z.string().optional(),
      notes: z.string().optional(),
      kicker: z.string().optional(),
      layout: z.enum(["cover", "content", "section", "closing", "stats", "steps"]).optional(),
      stats: z.array(z.object({
        value: z.string(),
        label: z.string()
      })).optional(),
      steps: z.array(z.object({
        title: z.string(),
        text: z.string().optional()
      })).optional()
    })).optional().describe("Slide content for doc_type 'presentation' (each item becomes one 16:9 Impress slide). layout: cover|content|section|closing|stats|steps (default: cover for the first slide, content otherwise). notes adds speaker notes; kicker overrides the small label above the title; stats renders up to 4 figures; steps renders up to 4 numbered process columns.")
  },
  async ({ action, doc_type, style_name, parent_style, font_name, font_size, bold, italic, underline, alignment, slides }) => {
    if (action === "create") {
      freezeSpecs.clear();
      if (doc_type === "presentation") {
        // Always build a real Impress deck; load_presentation_live only wrote
        // plain text into a Writer document.
        return jsonResponse(await callLibreoffice("/tools/create_presentation_live", "POST", { slides: slides || [] }));
      }
      return jsonResponse(await callLibreoffice("/tools/create_document_live", "POST", { doc_type }));
    } else if (action === "info") {
      return jsonResponse(await callLibreoffice("/tools/get_document_info_live", "POST", {}));
    } else if (action === "list") {
      return jsonResponse(await callLibreoffice("/tools/list_open_documents", "POST", {}));
    } else if (action === "content") {
      return jsonResponse(await callLibreoffice("/tools/get_text_content_live", "POST", {}));
    } else if (action === "status") {
      return jsonResponse(await callLibreoffice("/health", "GET"));
    } else if (action === "open_browser") {
      return jsonResponse(await callLibreoffice("/tools/open_browser_live", "POST", {}));
    } else if (action === "styles") {
      return jsonResponse(await callLibreoffice("/tools/list_paragraph_styles_live", "POST", {}));
    } else if (action === "create_style") {
      if (!style_name) return toolError(action, "Missing 'style_name'.", "Pass the style name, e.g. style_name:\"My Style\".");
      const data = { style_name };
      if (parent_style) data.parent_style = parent_style;
      if (font_name) data.font_name = font_name;
      if (font_size !== undefined) data.font_size = font_size;
      if (bold !== undefined) data.bold = bold;
      if (italic !== undefined) data.italic = italic;
      if (underline !== undefined) data.underline = underline;
      if (alignment) data.alignment = alignment;
      return jsonResponse(await callLibreoffice("/tools/create_paragraph_style_live", "POST", data));
    } else if (action === "edit_style") {
      if (!style_name) return toolError(action, "Missing 'style_name'.", "Pass the style name to edit.");
      const data = { style_name };
      if (parent_style) data.parent_style = parent_style;
      if (font_name) data.font_name = font_name;
      if (font_size !== undefined) data.font_size = font_size;
      if (bold !== undefined) data.bold = bold;
      if (italic !== undefined) data.italic = italic;
      if (underline !== undefined) data.underline = underline;
      if (alignment) data.alignment = alignment;
      return jsonResponse(await callLibreoffice("/tools/edit_paragraph_style_live", "POST", data));
    } else if (action === "delete_style") {
      if (!style_name) return toolError(action, "Missing 'style_name'.", "Pass the style name to delete.");
      return jsonResponse(await callLibreoffice("/tools/delete_paragraph_style_live", "POST", { style_name }));
    } else if (action === "style_properties") {
      if (!style_name) return toolError(action, "Missing 'style_name'.", "Pass the style name to inspect.");
      return jsonResponse(await callLibreoffice("/tools/get_style_properties_live", "POST", { style_name }));
    }
    return toolError(action, `Invalid action '${action}'.`,
      "Valid actions: create, info, list, content, status, styles, create_style, edit_style, delete_style, style_properties, open_browser.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 2: structure
// Actions: outline, paragraph, range, count
// =============================================================================
server.tool(
  "structure",
  `Inspect paragraphs. Paragraphs are 1-indexed and each is a real paragraph (not a visual line).

- count: number of paragraphs (a fresh document has 1 empty paragraph).
- paragraph: text + paragraph style + start/end character offsets for paragraph n.
- range: texts of paragraphs start..end (inclusive).
- outline: paragraphs whose style is Title or Heading 1-3.

Offsets are 0-based and each paragraph mark counts as one character, so
paragraph.start / paragraph.end can be passed directly to selection(range).`,
  {
    action: z.enum(["outline", "paragraph", "range", "count"]).describe("Operation to perform"),
    n: z.number().int().optional().describe("Paragraph number, 1-indexed (for 'paragraph')"),
    start: z.number().int().optional().describe("First paragraph number, 1-indexed (for 'range')"),
    end: z.number().int().optional().describe("Last paragraph number, inclusive (for 'range')")
  },
  async ({ action, n, start, end }) => {
    if (action === "outline") {
      return jsonResponse(await callLibreoffice("/tools/get_document_outline_live", "POST", {}));
    } else if (action === "paragraph") {
      if (n === undefined) return toolError(action, "Missing 'n' (paragraph number).", "Call structure {action:'count'} first to learn the paragraph total.");
      return jsonResponse(await callLibreoffice("/tools/get_paragraph_live", "POST", { n }));
    } else if (action === "range") {
      if (start === undefined || end === undefined) return toolError(action, "Missing 'start' or 'end'.", "Both are 1-indexed paragraph numbers, inclusive.");
      return jsonResponse(await callLibreoffice("/tools/get_paragraphs_range_live", "POST", { start, end }));
    } else if (action === "count") {
      return jsonResponse(await callLibreoffice("/tools/get_paragraph_count_live", "POST", {}));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: outline, paragraph, range, count.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 3: cursor
// Actions: goto_paragraph, goto_position, position, context
// =============================================================================
server.tool(
  "cursor",
  `Move the shared edit cursor. The cursor is also the active selection, so this decides where text(insert) writes.

- goto_paragraph(n): collapse the cursor at the start of paragraph n.
- goto_position(char_pos): collapse it at a 0-based character offset.
- position: current start/end offsets and the paragraph number.
- context(chars): text around the cursor (before/after, default 100 chars each side).

text(insert) writes at the cursor and replaces any selection. For formatting,
prefer the selection tool - it sets both the cursor and the selection explicitly.`,
  {
    action: z.enum(["goto_paragraph", "goto_position", "position", "context"]).describe("Operation to perform"),
    n: z.number().int().optional().describe("Paragraph number, 1-indexed (for 'goto_paragraph')"),
    char_pos: z.number().int().optional().describe("0-based character offset (for 'goto_position')"),
    chars: z.number().int().default(100).describe("Characters of context on each side (for 'context')")
  },
  async ({ action, n, char_pos, chars }) => {
    if (action === "goto_paragraph") {
      if (n === undefined) return toolError(action, "Missing 'n'.", "Paragraph numbers start at 1; call structure {action:'count'} to see how many there are.");
      return jsonResponse(await callLibreoffice("/tools/goto_paragraph_live", "POST", { n }));
    } else if (action === "goto_position") {
      if (char_pos === undefined) return toolError(action, "Missing 'char_pos'.", "Use the start/end offsets returned by structure {action:'paragraph'}.");
      return jsonResponse(await callLibreoffice("/tools/goto_position_live", "POST", { char_pos }));
    } else if (action === "position") {
      return jsonResponse(await callLibreoffice("/tools/get_cursor_position_live", "POST", {}));
    } else if (action === "context") {
      return jsonResponse(await callLibreoffice("/tools/get_context_around_cursor_live", "POST", { chars }));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: goto_paragraph, goto_position, position, context.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 4: selection
// Actions: paragraph, range, delete, replace
// =============================================================================
server.tool(
  "selection",
  `Select text (or a whole paragraph) for the next text(format) / delete / replace.

- paragraph(n): select the text of paragraph n (1-indexed, without its mark).
- range(start,end): select characters [start,end) using 0-based offsets.
- delete: delete the current selection.
- replace(text): replace the selection (insert at the cursor when collapsed). "\\n" creates paragraphs.

The selection is stateful: it survives until you change it. Call selection
immediately before text(format) and check the returned selection
{start, end, text} - formatting applies to exactly that range.`,
  {
    action: z.enum(["paragraph", "range", "delete", "replace"]).describe("Operation to perform"),
    n: z.number().int().optional().describe("Paragraph number, 1-indexed (for 'paragraph')"),
    start: z.number().int().optional().describe("0-based start offset, inclusive (for 'range')"),
    end: z.number().int().optional().describe("0-based end offset, exclusive (for 'range')"),
    text: z.string().optional().describe("Replacement text (for 'replace'); '\\n' creates paragraph breaks")
  },
  async ({ action, n, start, end, text }) => {
    if (action === "paragraph") {
      if (n === undefined) return toolError(action, "Missing 'n'.", "Paragraph numbers start at 1; use structure {action:'count'} to check the total.");
      return jsonResponse(await callLibreoffice("/tools/select_paragraph_live", "POST", { n }));
    } else if (action === "range") {
      if (start === undefined || end === undefined) return toolError(action, "Missing 'start' or 'end'.", "Both are 0-based offsets; end is exclusive. structure.paragraph returns matching start/end values.");
      return jsonResponse(await callLibreoffice("/tools/select_text_range_live", "POST", { start, end }));
    } else if (action === "delete") {
      return jsonResponse(await callLibreoffice("/tools/delete_selection_live", "POST", {}));
    } else if (action === "replace") {
      if (text === undefined) return toolError(action, "Missing 'text'.", "Pass the replacement string; use selection {action:'delete'} to delete instead.");
      return jsonResponse(await callLibreoffice("/tools/replace_selection_live", "POST", { text }));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: paragraph, range, delete, replace.");
  }
);

// =============================================================================
// SPREADSHEET TOOL: sheet (Calc cells, formatting, charts)
// =============================================================================
server.tool(
  "sheet",
  `Read and write cells in the active Calc spreadsheet and add charts.

- read(range, sheet?): 2-D array of values for a range like "A1:B10".
- write(values, start?, sheet?, parse_dates?): write a 2-D array of rows;
  numbers stay numbers, strings starting with "=" become real formulas, and
  ISO dates (YYYY-MM-DD) become real date cells unless parse_dates is false.
- format(range, bold?, italic?, font_size?, align?, fill_color?, number_format?,
  sheet?): number_format is currency, percent, date, number, integer, or a
  custom format code.
- column_width(column, width_mm, sheet?): widen a column by its letter.
- chart(data_range, chart_type?, title?, x_title?, y_title?, legend?, sheet?,
  data_sheet?, x?, y?, width?, height?, date_axis?): insert an embedded chart
  on \`sheet\` using data from \`data_sheet\` (defaults to the same sheet).
  data_range should include the header row; its first column becomes the
  category (X) labels. date_axis switches the X axis to a date axis.
- sheet_create(name, index?): add a sheet.
- sheet_rename(name, new_name): rename a sheet.
- sheet_activate(name): make a sheet active (needed before chart/freeze).
- validation(range, type?, source?, show_list?, sheet?): set data validation.
- named_range(name, sheet, range): create a named range.
- freeze(sheet?, columns?, rows?): freeze panes.

The active document must be a spreadsheet: document {action:"create",
doc_type:"calc"}. Chart positions and sizes are in 1/100 mm.`,
  {
    action: z.enum(["read", "write", "format", "column_width", "chart", "sheet_create", "sheet_rename", "sheet_activate", "validation", "named_range", "freeze"]).describe("Operation to perform"),
    sheet: z.string().optional().describe("Sheet name (default: the active sheet)"),
    range: z.string().optional().describe("Cell range like 'A1:B10' (for 'read' and 'format')"),
    start: z.string().optional().describe("Top-left cell for 'write' (default 'A1')"),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional()
      .describe("2-D array of rows (for 'write')"),
    parse_dates: z.boolean().optional().describe("Treat ISO YYYY-MM-DD strings as real dates (default true)"),
    bold: z.boolean().optional().describe("Bold text (for 'format')"),
    italic: z.boolean().optional().describe("Italic text (for 'format')"),
    font_size: z.number().optional().describe("Font size in points (for 'format')"),
    align: z.enum(["left", "center", "right"]).optional().describe("Horizontal alignment (for 'format')"),
    fill_color: z.string().optional().describe("#RRGGBB cell background (for 'format')"),
    number_format: z.string().optional().describe("Number format: currency, percent, date, number, integer or a custom code (for 'format')"),
    data_sheet: z.string().optional().describe("Sheet that owns the chart data (for 'chart'; default same as sheet)"),
    column: z.string().optional().describe("Column letter for 'column_width'"),
    width_mm: z.number().optional().describe("Column width in millimetres (for 'column_width')"),
    data_range: z.string().optional().describe("Data range for 'chart', including the header row"),
    chart_type: z.enum(["line", "column", "bar", "area", "pie", "scatter"]).optional().describe("Chart type (default line)"),
    title: z.string().optional().describe("Chart title"),
    x_title: z.string().optional().describe("Category (X) axis title"),
    y_title: z.string().optional().describe("Value (Y) axis title"),
    legend: z.boolean().optional().describe("Show the legend (default true)"),
    x: z.number().optional().describe("Chart X position in 1/100 mm"),
    y: z.number().optional().describe("Chart Y position in 1/100 mm"),
    width: z.number().optional().describe("Chart width in 1/100 mm"),
    height: z.number().optional().describe("Chart height in 1/100 mm"),
    date_axis: z.boolean().optional().describe("Use a date X axis (for 'chart')"),
    type: z.enum(["list", "whole", "decimal", "date", "time", "text_length"]).optional().describe("Validation type (for 'validation')"),
    source: z.string().optional().describe("Validation source/list range (for 'validation')"),
    show_list: z.boolean().optional().describe("Show the dropdown (for 'validation')"),
    new_name: z.string().optional().describe("New sheet name (for 'sheet_rename')"),
    index: z.number().int().optional().describe("Insert position (for 'sheet_create')"),
    columns: z.number().int().optional().describe("Columns to freeze (for 'freeze')"),
    rows: z.number().int().optional().describe("Rows to freeze (for 'freeze')"),
    name: z.string().optional().describe("Sheet or named-range name")
  },
  async ({ action, sheet, range, start, values, parse_dates, bold, italic, font_size, align,
           fill_color, number_format, data_sheet, column, width_mm, data_range,
           chart_type, title, x_title, y_title, legend, x, y, width, height,
           date_axis, type, source, show_list, new_name, index, columns, rows, name }) => {
    if (action === "read") {
      if (!range) return toolError(action, "Missing 'range'.", 'Pass a range like "A1:B10".');
      return jsonResponse(await callLibreoffice("/tools/get_cells_live", "POST", { range, sheet }));
    } else if (action === "write") {
      if (!Array.isArray(values) || !values.length) {
        return toolError(action, "Missing 'values'.", "Pass a 2-D array of rows, e.g. [[\"Date\",\"Weight\"],[\"2026-01-01\",1500]].");
      }
      return jsonResponse(await callLibreoffice("/tools/set_cells_live", "POST", {
        values, start: start || "A1", sheet, parse_dates
      }));
    } else if (action === "format") {
      if (!range) return toolError(action, "Missing 'range'.", 'Pass a range like "A1:B1".');
      return jsonResponse(await callLibreoffice("/tools/format_range_live", "POST", {
        range, sheet, bold, italic, font_size, align, fill_color, number_format
      }));
    } else if (action === "column_width") {
      if (!column) return toolError(action, "Missing 'column'.", "Pass a column letter such as 'A'.");
      return jsonResponse(await callLibreoffice("/tools/set_column_width_live", "POST", {
        column, width_mm: width_mm || 25, sheet
      }));
    } else if (action === "chart") {
      if (!data_range) return toolError(action, "Missing 'data_range'.", 'Pass the range the chart plots, e.g. "A1:B10".');
      return jsonResponse(await callLibreoffice("/tools/add_chart_live", "POST", {
        data_range, chart_type: chart_type || "line", title, x_title, y_title,
        legend, x, y, width, height, sheet, data_sheet, date_axis
      }));
    } else if (action === "sheet_create") {
      if (!name) return toolError(action, "Missing 'name'.", "Pass the new sheet name.");
      return jsonResponse(await callLibreoffice("/tools/calc_sheet_live", "POST", { action: "create", name, index }));
    } else if (action === "sheet_rename") {
      if (!name || !new_name) return toolError(action, "Missing 'name' or 'new_name'.", "Pass both names.");
      return jsonResponse(await callLibreoffice("/tools/calc_sheet_live", "POST", { action: "rename", name, new_name }));
    } else if (action === "sheet_activate") {
      if (!name) return toolError(action, "Missing 'name'.", "Pass the sheet name.");
      return jsonResponse(await callLibreoffice("/tools/calc_sheet_live", "POST", { action: "activate", name }));
    } else if (action === "validation") {
      if (!range) return toolError(action, "Missing 'range'.", 'Pass the target range like "B2:B10".');
      if (!source) return toolError(action, "Missing 'source'.", 'Pass a list/cell range like "$Sheet1.$A$1:$A$3".');
      return jsonResponse(await callLibreoffice("/tools/calc_validation_live", "POST", {
        range, sheet, type: type || "list", source, show_list
      }));
    } else if (action === "named_range") {
      if (!name || !range) return toolError(action, "Missing 'name' or 'range'.", "Pass both.");
      return jsonResponse(await callLibreoffice("/tools/calc_named_range_live", "POST", { name, range, sheet }));
    } else if (action === "freeze") {
      const result = await callLibreoffice("/tools/calc_freeze_live", "POST", { sheet, columns, rows });
      if (result && result.success) {
        const sheetName = result.sheet || sheet;
        const pane = { columns: Number(result.columns || 0), rows: Number(result.rows || 0) };
        if (sheetName && (pane.columns || pane.rows)) freezeSpecs.set(sheetName, pane);
      }
      return jsonResponse(result);
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: read, write, format, column_width, chart, sheet_create, sheet_rename, sheet_activate, validation, named_range, freeze.");
  }
);

// =============================================================================
// GENERIC TOOL: uno (any interface, no dedicated tool required)
// =============================================================================
server.tool(
  "uno",
  `Generic UNO access to the active LibreOffice document: drive any
com.sun.star interface without needing a dedicated tool.

- root: handle to the UNO component context.
- get(h, name): attribute, getX() accessor or property value.
- set(h, name, value): attribute or property.
- set_enum(h, name, value): set a numeric or enum property using the type
  carried by the property itself. Use it when set reports success but the
  value stays 0 (short properties like NumberingLevel/AxisType, and enums whose
  type name is not registered such as ReferenceFieldSource).
- call(h, name, args): invoke a method.
- query(h, iface): queryInterface -> handle or null.
- create(service): createInstanceWithContext (no handle needed).
- describe(type?, h?, method?): reflection metadata for an interface/service,
  or the interfaces/services of a live object.
- release(h): drop a handle.

Value encoding (same as PROTOCOL.md): interface -> {"$h": n}, struct ->
{"$s": "com.sun.star.awt.Point", X: 1, Y: 2}, enum -> {"$e": "...", v: "SOLID"},
float -> {"$f": 1.5}, sequence -> [...], null -> null.

Typical start: root, get "ServiceManager", call createInstanceWithContext
["com.sun.star.frame.Desktop", root], call getCurrentComponent [].
Use describe first rather than guessing method names or argument counts.
Describe a module (e.g. "com.sun.star.sheet") to list its interfaces and
services, then describe one of those for methods, parameter types/modes and
return types.

Docs: https://api.libreoffice.org/docs/idl/ref/ (per-type pages) and
https://raw.githubusercontent.com/LibreOffice/core/master/offapi/com/sun/star/
<module>/<Type>.idl (raw IDL). The Wasm build can differ from the docs, so
describe is authoritative.`,
  {
    op: z.enum(["root", "get", "set", "set_enum", "call", "query", "create", "describe", "release"])
      .describe("Operation to perform"),
    h: z.number().int().optional().describe("Object handle (from a previous result)"),
    name: z.string().optional().describe("Member or method name (for 'get', 'set', 'set_enum', 'call')"),
    iface: z.string().optional().describe("Interface name (for 'query')"),
    service: z.string().optional().describe("Service name (for 'create')"),
    type: z.string().optional().describe("Interface or service name (for 'describe')"),
    method: z.string().optional().describe("Only describe this method (for 'describe')"),
    args: z.array(z.any()).optional().describe("Method arguments (for 'call')"),
    value: z.any().optional().describe("Value to assign (for 'set'); numeric enum value for 'set_enum'")
  },
  async ({ op, h, name, iface, service, type, method, args, value }) => {
    const payload = { op, h, name, iface, service, type, method, args, v: value };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return jsonResponse(await callLibreoffice("/tools/uno_live", "POST", payload));
  }
);

// =============================================================================
// TOOL: embed (real OLE objects inside a Writer document)
// =============================================================================
server.tool(
  "embed",
  `Insert a real OLE embedded document into the active Writer text document.

- service: calc | writer | impress | draw | math (or a CLSID GUID).
- width_mm / height_mm: frame size in millimetres (set them before inserting).
- anchor: "inline" (as character, default) or "paragraph".
- values: optional 2-D array written into the embedded Calc model (first sheet).

Returns {name, clsid, object: {$h}, model: {$h}, values, chart?}. For an
embedded Calc sheet, pass chart to add a real chart in the same call; the
embedded model and its preview area are sized to the frame for you.

chart fields: title, x_title, y_title, legend (default true), range (defaults
to the values block), name, and x/y/width/height in 1/100 mm.`,
  {
    service: z.enum(["calc", "writer", "impress", "draw", "math"]).optional()
      .describe("Embedded document type (default calc)"),
    width_mm: z.number().optional().describe("Frame width in millimetres"),
    height_mm: z.number().optional().describe("Frame height in millimetres"),
    anchor: z.enum(["inline", "paragraph"]).optional().describe("Anchor mode (default inline)"),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional()
      .describe("Optional 2-D array written into the embedded Calc sheet"),
    chart: z.object({
      title: z.string().optional(),
      x_title: z.string().optional(),
      y_title: z.string().optional(),
      legend: z.boolean().optional(),
      range: z.string().optional().describe("Data range, default A1:<last value cell>"),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional()
    }).optional().describe("Add a chart inside the embedded Calc sheet in the same call")
  },
  async ({ service, width_mm, height_mm, anchor, values, chart }) => {
    return jsonResponse(await callLibreoffice("/tools/insert_embedded_object_live", "POST", {
      service: service || "calc",
      width_mm,
      height_mm,
      anchor: anchor === "paragraph" ? "paragraph" : "as_char",
      values,
      chart
    }));
  }
);

// =============================================================================
// TOOL: cookbook (task recipes with exact call sequences)
// =============================================================================
server.tool(
  "cookbook",
  `Return the ZetaOffice task cookbook: runnable recipes with exact call
sequences, verification steps and known gotchas.

Use it before writing UNO orchestration by hand. Pass topic to get one section
(e.g. "embed", "chart", "save", "text", "describe", "gotchas"); omit it for the
whole document.`,
  {
    topic: z.string().optional().describe("Section keyword, e.g. 'embed' or 'chart'")
  },
  async ({ topic }) => {
    const file = path.join(__dirname, "docs", "cookbook.md");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      return toolError("cookbook", "Cookbook not found.", `Expected ${file}.`);
    }
    if (topic) {
      const re = new RegExp("^(#{2,3})\\s+.*" + topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*$", "im");
      const m = re.exec(text);
      if (m) {
        const start = m.index;
        const level = m[1].length;
        const nextRe = new RegExp(`\\n#{2,${level}} `);
        const tail = text.slice(start + m[0].length);
        const next = nextRe.exec(tail);
        text = text.slice(start, next ? start + m[0].length + next.index : undefined);
      } else {
        text = `No section matching '${topic}'. Sections:\n` +
          (text.match(/^#{2,3}\\s+.*$/gm) || []).join("\n");
      }
      if (/formula/i.test(topic) && !/Math formula/.test(text)) {
        text = 'For a native Writer Math object, use cookbook {topic:"math"}.\n\n' + text;
      }
    }
    return { content: [{ type: "text", text }] };
  }
);

// =============================================================================
// TOOL: bridge (start/stop/restart the Wasm bridge)
// =============================================================================
async function waitForBridge(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth(LIBREOFFICE_URL)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

server.tool(
  "bridge",
  `Manage the LibreOffice Wasm bridge process.

- status: health, mode and connected sessions.
- start: spawn the bridge if it is not running, and wait until it is healthy.
- restart: stop the bridge and start a fresh process, then wait until healthy.
  Use this after changing server.mjs, office_thread.js or other worker code -
  no kill -9 and no orphaned Wasm runtimes.
- quit: shut the bridge down cleanly (stops the Wasm runtime too).`,
  {
    action: z.enum(["status", "start", "restart", "quit"]).describe("Operation to perform")
  },
  async ({ action }) => {
    if (action === "status") {
      return jsonResponse(await callLibreoffice("/health", "GET"));
    }
    if (action === "start") {
      await ensureBridge();
      const healthy = await waitForBridge();
      return jsonResponse({
        success: healthy,
        message: healthy ? "Bridge is running" : "Bridge did not become healthy",
        health: healthy ? await callLibreoffice("/health", "GET") : null
      });
    }
    if (action === "restart") {
      const response = await callLibreoffice("/restart", "POST", {});
      await new Promise((r) => setTimeout(r, 1200));
      const healthy = await waitForBridge();
      return jsonResponse({
        success: healthy,
        message: healthy ? "Bridge restarted" : "Bridge did not come back",
        restart: response,
        health: healthy ? await callLibreoffice("/health", "GET") : null
      });
    }
    if (action === "quit") {
      return jsonResponse(await callLibreoffice("/quit", "POST", {}));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: status, start, restart, quit.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 5: search
// Actions: find, replace, replace_all
// =============================================================================
server.tool(
  "search",
  `Find and replace plain text (literal strings, no regex).

- find(query): up to 50 matches with 0-based "position" and "length".
- replace(old,new): replace the first match.
- replace_all(old,new): replace every match.

Matches are searched in the flat document text, so positions line up with
selection(range) offsets. Replacement preserves the character formatting of the
surrounding text (unlike rebuilding the document).`,
  {
    action: z.enum(["find", "replace", "replace_all"]).describe("Operation to perform"),
    query: z.string().optional().describe("Literal text to find (for 'find')"),
    old: z.string().optional().describe("Literal text to replace (for 'replace' / 'replace_all')"),
    new: z.string().optional().describe("Replacement text (for 'replace' / 'replace_all')")
  },
  async ({ action, query, old: oldText, new: newText }) => {
    if (action === "find") {
      if (!query) return toolError(action, "Missing 'query'.", "Search is literal (no regex); pass the exact text to find.");
      return jsonResponse(await callLibreoffice("/tools/find_text_live", "POST", { query }));
    } else if (action === "replace") {
      if (!oldText || !newText) return toolError(action, "Missing 'old' or 'new'.", "Use action 'replace_all' to change every occurrence.");
      return jsonResponse(await callLibreoffice("/tools/find_and_replace_live", "POST", { old: oldText, new: newText }));
    } else if (action === "replace_all") {
      if (!oldText || !newText) return toolError(action, "Missing 'old' or 'new'.", "The empty string is not a valid search term.");
      return jsonResponse(await callLibreoffice("/tools/find_and_replace_all_live", "POST", { old: oldText, new: newText }));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: find, replace, replace_all.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 6: track_changes
// Actions: status, enable, disable, list, accept, reject, accept_all, reject_all
// =============================================================================
server.tool(
  "track_changes",
  `Track-changes status and bulk accept/reject.

LIMITATION (WASM bridge): recording is only an in-memory flag. No revisions are
actually recorded, 'list' always returns [], and 'accept'/'reject' by index are
no-ops. 'accept_all'/'reject_all' report success but there is nothing to apply.
Treat this tool as informational only.`,
  {
    action: z.enum(["status", "enable", "disable", "list", "accept", "reject", "accept_all", "reject_all"]).describe("Operation to perform"),
    index: z.number().int().optional().describe("Change index, 0-based (for 'accept'/'reject'; unavailable in the WASM bridge)"),
    show: z.boolean().default(true).describe("Show revisions while recording is enabled")
  },
  async ({ action, index, show }) => {
    if (action === "status") {
      return jsonResponse(await callLibreoffice("/tools/get_track_changes_status_live", "POST", {}));
    } else if (action === "enable") {
      return jsonResponse(await callLibreoffice("/tools/set_track_changes_live", "POST", { enabled: true, show }));
    } else if (action === "disable") {
      return jsonResponse(await callLibreoffice("/tools/set_track_changes_live", "POST", { enabled: false, show }));
    } else if (action === "list") {
      return jsonResponse(await callLibreoffice("/tools/get_tracked_changes_live", "POST", {}));
    } else if (action === "accept") {
      if (index === undefined) return toolError(action, "Missing 'index'.", "The WASM bridge records no revisions, so there is nothing to accept; this is a stub.");
      return jsonResponse(await callLibreoffice("/tools/accept_tracked_change_live", "POST", { index }));
    } else if (action === "reject") {
      if (index === undefined) return toolError(action, "Missing 'index'.", "The WASM bridge records no revisions, so there is nothing to reject; this is a stub.");
      return jsonResponse(await callLibreoffice("/tools/reject_tracked_change_live", "POST", { index }));
    } else if (action === "accept_all") {
      return jsonResponse(await callLibreoffice("/tools/accept_all_changes_live", "POST", {}));
    } else if (action === "reject_all") {
      return jsonResponse(await callLibreoffice("/tools/reject_all_changes_live", "POST", {}));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: status, enable, disable, list, accept, reject, accept_all, reject_all.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 7: comments
// Actions: list, add
// =============================================================================
server.tool(
  "comments",
  `List or add document comments.

LIMITATION (WASM bridge): comments are not persisted. 'list' always returns an
empty array and 'add' only reports success without inserting an annotation.
Use document text (e.g. a bracketed note paragraph) if comments must survive.`,
  {
    action: z.enum(["list", "add"]).describe("Operation to perform"),
    text: z.string().optional().describe("Comment text (for 'add')"),
    author: z.string().default("Claude").describe("Author name for 'add'")
  },
  async ({ action, text, author }) => {
    if (action === "list") {
      return jsonResponse(await callLibreoffice("/tools/get_comments_live", "POST", {}));
    } else if (action === "add") {
      if (!text) return toolError(action, "Missing 'text'.", "Pass the comment body in 'text'.");
      return jsonResponse(await callLibreoffice("/tools/add_comment_live", "POST", { text, author }));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: list, add.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 8: save
// Actions: save, export
// =============================================================================
server.tool(
  "save",
  `Write the active document to the host filesystem.

- export: serialize as export_format and write to file_path.
- save: same but keeps the document's current format.

file_path should be an absolute path; the MCP server writes it (the client does
not receive bytes). Existing files are overwritten. Returns {file_path, format,
bytes}. Supported formats: odt, docx, pdf, html, txt (Writer); odp, pptx, ppt,
pdf (Impress); ods/xlsx/csv where the document type allows it.`,
  {
    action: z.enum(["save", "export"]).describe("Operation to perform"),
    file_path: z.string().optional().describe("Output path, e.g. out.odt (required for 'export')"),
    export_format: z.enum(["pdf", "docx", "odt", "html", "txt", "odp", "pptx", "ppt", "xlsx", "ods", "csv", "odg", "svg"]).default("pdf").describe("Output format (for 'export')")
  },
  async ({ action, file_path, export_format }) => {
    if (action === "save") {
      const data = {};
      if (file_path) data.file_path = file_path;
      const result = await callLibreoffice("/tools/save_document_live", "POST", data);
      return jsonResponse(persistWithFreeze(result, file_path));
    } else if (action === "export") {
      if (!file_path) return toolError(action, "Missing 'file_path'.", "Pass a path, e.g. report.odt.");
      const result = await callLibreoffice("/tools/export_document_live", "POST", {
        file_path,
        format: export_format
      });
      return jsonResponse(persistWithFreeze(result, file_path));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: save, export.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 9: text
// Actions: insert, format, style
// =============================================================================
server.tool(
  "text",
  `Write and format text.

- insert(content): insert at the cursor, replacing any selection. "\\n" creates
  real paragraph breaks; use an empty "\\n\\n" for a blank line. No Markdown:
  "#", "**", "- " are inserted literally.
- format(bold|italic|underline|font_size|font_name): apply character formatting
  to the ACTIVE SELECTION (set via selection first) or, with no selection, as
  typing attributes at the cursor. It does not change the paragraph style.
- style(style_name, paragraph_n?): apply a paragraph style to paragraph_n (or the
  paragraph at the cursor). Names: Title, Subtitle, Heading 1-3, Standard,
  Text body, Quotations, Preformatted Text; matching ignores case and spaces.
- page_break: insert a page break at the cursor.

Formatting one paragraph: structure(paragraph n) -> selection(paragraph n) ->
text(format ...). Formatting a run of paragraphs: selection(range start,end).
To make a heading both big and bold, call text(style) and text(format) - direct
character formatting overrides the style.`,
  {
    action: z.enum(["insert", "format", "style", "page_break"]).describe("Operation to perform"),
    content: z.string().optional().describe("Text to insert (for 'insert'); '\\n' = new paragraph"),
    bold: z.boolean().optional().describe("Bold on/off (for 'format')"),
    italic: z.boolean().optional().describe("Italic on/off (for 'format')"),
    underline: z.boolean().optional().describe("Underline on/off (for 'format')"),
    font_size: z.number().optional().describe("Font size in points (for 'format'), e.g. 11"),
    font_name: z.string().optional().describe("Font family (for 'format'), e.g. 'Liberation Serif'"),
    style_name: z.string().optional().describe("Paragraph style for 'style' (e.g. 'Title', 'Heading 1', 'Text body')"),
    paragraph_n: z.number().int().optional().describe("Target paragraph for 'style', 1-indexed (default: the cursor's paragraph)"),
    page_break: z.boolean().optional().describe("Insert a page break before the text (for 'insert')")
  },
  async ({ action, content, bold, italic, underline, font_size, font_name, style_name, paragraph_n, page_break }) => {
    if (action === "insert") {
      if (content === undefined) return toolError(action, "Missing 'content'.", "Pass the text to insert; use '\\n' between paragraphs.");
      return jsonResponse(await callLibreoffice("/tools/insert_text_live", "POST", { text: content, page_break }));
    } else if (action === "page_break") {
      return jsonResponse(await callLibreoffice("/tools/insert_page_break_live", "POST", {}));
    } else if (action === "format") {
      const formatting = {};
      if (bold !== undefined) formatting.bold = bold;
      if (italic !== undefined) formatting.italic = italic;
      if (underline !== undefined) formatting.underline = underline;
      if (font_size !== undefined) formatting.font_size = font_size;
      if (font_name !== undefined) formatting.font_name = font_name;
      if (!Object.keys(formatting).length) {
        return toolError(action, "No formatting properties given.", "Pass at least one of bold, italic, underline, font_size, font_name.");
      }
      return jsonResponse(await callLibreoffice("/tools/format_text_live", "POST", { formatting }));
    } else if (action === "style") {
      if (!style_name) return toolError(action, "Missing 'style_name'.", "Call document {action:'styles'} for the available names.");
      const data = { style_name };
      if (paragraph_n !== undefined) data.paragraph_n = paragraph_n;
      return jsonResponse(await callLibreoffice("/tools/format_paragraph_live", "POST", data));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: insert, format, style, page_break.");
  }
);

// =============================================================================
// CONSOLIDATED TOOL 10: formula
// Actions: insert, list, update, delete (native LibreOffice Math objects)
// =============================================================================
server.tool(
  "formula",
  `Insert and manage native LibreOffice Math formulas.

Unlike text(insert), this creates a real embedded Math object
(com.sun.star.text.TextEmbeddedObject with the Math CLSID). The result is an
editable equation object, not a text approximation, and survives export to
odt/docx/pdf.

- insert(formula, display?, align?): insert a Math object at the cursor.
  display (default true) puts it on its own paragraph; align is
  left|center|right and only applies to a displayed formula.
- list: enumerate embedded formulas as [{index, formula}].
- update(index, formula): rewrite the StarMath source of an existing formula.
- delete(index): remove an embedded formula.

'formula' is LibreOffice Math (StarMath) syntax, NOT LaTeX:
  e^{i %pi} + 1 = 0
  x = {-b +- sqrt{b^2 - 4ac}} over 2a
  int_0^1 x^2 dx = 1 over 3
Indices come from formula {action:"list"}. Use odt export for exact fidelity:
docx converts Math to OMML and LibreOffice can lose complex layout such as
n-ary limits there.`,
  {
    action: z.enum(["insert", "list", "update", "delete"]).describe("Operation to perform"),
    formula: z.string().optional().describe("LibreOffice Math (StarMath) source (for 'insert' / 'update')"),
    index: z.number().int().optional().describe("Formula index from formula {action:'list'} (for 'update' / 'delete')"),
    display: z.boolean().default(true).describe("Put the inserted formula on its own paragraph (default true)"),
    align: z.enum(["left", "center", "right"]).optional().describe("Paragraph alignment for a displayed formula (for 'insert')")
  },
  async ({ action, formula, index, display, align }) => {
    if (action === "insert") {
      if (!formula) return toolError(action, "Missing 'formula'.", "Pass StarMath source, e.g. formula:\"e^{i %pi} + 1 = 0\".");
      const data = { formula, display };
      if (align) data.align = align;
      return jsonResponse(await callLibreoffice("/tools/insert_formula_live", "POST", data));
    } else if (action === "list") {
      return jsonResponse(await callLibreoffice("/tools/list_formulas_live", "POST", {}));
    } else if (action === "update") {
      if (index === undefined) return toolError(action, "Missing 'index'.", "Call formula {action:'list'} for the current indices.");
      if (!formula) return toolError(action, "Missing 'formula'.", "Pass the new StarMath source.");
      return jsonResponse(await callLibreoffice("/tools/update_formula_live", "POST", { index, formula }));
    } else if (action === "delete") {
      if (index === undefined) return toolError(action, "Missing 'index'.", "Call formula {action:'list'} for the current indices.");
      return jsonResponse(await callLibreoffice("/tools/delete_formula_live", "POST", { index }));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: insert, list, update, delete.");
  }
);

function imageDimensions(bytes) {
  try {
    if (bytes.length > 24 && bytes.toString("ascii", 1, 4) === "PNG") {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        const len = bytes.readUInt16BE(i + 2);
        i += 2 + len;
      }
    }
    if (bytes.toString("ascii", 0, 3) === "GIF") {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.toString("ascii", 0, 2) === "BM") {
      return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
    }
  } catch (err) { /* unsupported/broken header */ }
  return null;
}

// =============================================================================
// CONSOLIDATED TOOL 11: picture
// Actions: insert (inline graphic object from a local file)
// =============================================================================
server.tool(
  "picture",
  `Insert a raster picture into the document.

- insert(file_path, width_cm?, height_cm?, display?, align?, paragraph_n?, at?):
  load a local png/jpg/gif/bmp file on the MCP server's filesystem and insert
  it as a real inline graphic (com.sun.star.text.TextGraphicObject).
  display (default true) puts it on its own paragraph; align is
  left|center|right. Give one size to preserve the image aspect ratio (default
  width 5 cm). paragraph_n inserts at the start/end of that paragraph instead of
  the current cursor; at is start|end (default end).

The image bytes are embedded in the document on export; use
save(export, export_format:"odt"|"docx"|"pdf").`,
  {
    action: z.enum(["insert"]).describe("Operation to perform"),
    file_path: z.string().optional().describe("Local image path (png/jpg/gif/bmp) for 'insert'"),
    width_cm: z.number().optional().describe("Display width in centimetres (default 5, or derived from height/aspect ratio)"),
    height_cm: z.number().optional().describe("Display height in centimetres (default derived from width/aspect ratio)"),
    display: z.boolean().default(true).describe("Put the picture on its own paragraph"),
    align: z.enum(["left", "center", "right"]).optional().describe("Paragraph alignment for a displayed picture"),
    paragraph_n: z.number().int().optional().describe("Insert at this paragraph (1-indexed) instead of the current cursor"),
    at: z.enum(["start", "end"]).optional().describe("Picture position within the paragraph (default end)")
  },
  async ({ action, file_path, width_cm, height_cm, display, align, paragraph_n, at }) => {
    if (action !== "insert") return toolError(action, `Invalid action '${action}'.`, "Valid actions: insert.");
    if (!file_path) return toolError(action, "Missing 'file_path'.", "Pass a path, e.g. picture.png.");
    let bytes;
    const resolved = resolveHostPath(file_path);
    try {
      bytes = fs.readFileSync(resolved);
    } catch (err) {
      return toolError(action, `Cannot read '${file_path}': ${err.message}`, "Pass a local png/jpg/gif/bmp path.");
    }
    const ext = (path.extname(resolved).replace(/^\./, '') || 'png').toLowerCase();
    const data = { image_base64: bytes.toString('base64'), image_type: ext, display };
    const dims = imageDimensions(bytes);
    let width = width_cm;
    let height = height_cm;
    if (dims && dims.width > 0 && dims.height > 0) {
      if (width === undefined && height === undefined) width = 5;
      if (width === undefined) width = height * dims.width / dims.height;
      if (height === undefined) height = width * dims.height / dims.width;
      if (width !== undefined) width = Math.round(width * 100) / 100;
      if (height !== undefined) height = Math.round(height * 100) / 100;
    }
    if (width !== undefined) data.width_cm = width;
    if (height !== undefined) data.height_cm = height;
    if (align) data.align = align;
    if (paragraph_n !== undefined) data.paragraph_n = paragraph_n;
    if (at) data.at = at;
    return jsonResponse(await callLibreoffice("/tools/insert_picture_live", "POST", data));
  }
);

// =============================================================================
// TOOL: field (high-level bookmarks, links, captions)
// =============================================================================
server.tool(
  "field",
  `High-level Writer field operations.

- bookmark(name, paragraph_n?, at?): add a bookmark at the start/end of a paragraph.
- link(paragraph_n, text?, target): make a paragraph substring (or the whole
  paragraph) a hyperlink. target is "#bookmark" or an https:// URL.
- caption_pair(category?, caption?, reference?, sequence_number?): append a
  numbered caption and a real GetReference cross-reference in one call; returns
  the rendered caption/reference strings.

Captions are sequence fields numbered in document order.`,
  {
    action: z.enum(["bookmark", "link", "caption_pair"]).describe("Operation to perform"),
    name: z.string().optional().describe("Bookmark name (for 'bookmark')"),
    paragraph_n: z.number().int().optional().describe("Paragraph number, 1-indexed"),
    at: z.enum(["start", "end"]).optional().describe("Bookmark position in the paragraph"),
    text: z.string().optional().describe("Substring to link (default: whole paragraph)"),
    target: z.string().optional().describe("Link target: '#bookmark' or https:// URL"),
    category: z.string().optional().describe("Caption category (default Figure)"),
    caption: z.string().optional().describe("Caption text after the number"),
    reference: z.string().optional().describe("Text before the cross-reference (default 'see figure ')"),
    sequence_number: z.number().int().optional().describe("Target caption number (default 1)")
  },
  async ({ action, name, paragraph_n, at, text, target, category, caption, reference, sequence_number }) => {
    if (action === "bookmark") {
      if (!name) return toolError(action, "Missing 'name'.", "Pass the bookmark name.");
      return jsonResponse(await callLibreoffice("/tools/field_bookmark_live", "POST", { name, paragraph_n, at }));
    } else if (action === "link") {
      if (!target) return toolError(action, "Missing 'target'.", "Pass '#bookmark' or an https:// URL.");
      return jsonResponse(await callLibreoffice("/tools/field_link_live", "POST", { paragraph_n: paragraph_n || 1, text, target, name }));
    } else if (action === "caption_pair") {
      return jsonResponse(await callLibreoffice("/tools/field_caption_pair_live", "POST", {
        category, caption, reference, sequence_number
      }));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: bookmark, link, caption_pair.");
  }
);

// =============================================================================
// TOOL: page (high-level page setup)
// =============================================================================
server.tool(
  "page",
  `High-level Writer page setup and header/footer.

- setup(orientation?, margins_cm?, width_mm?, height_mm?): apply to the Standard
  page style (A4 portrait/landscape by default).
- header_footer(header?, footer?, page_number?): turn on and fill header/footer;
  page_number adds a live page-number field.

Lengths are millimetres/centimetres.`,
  {
    action: z.enum(["setup", "header_footer"]).describe("Operation to perform"),
    orientation: z.enum(["portrait", "landscape"]).optional().describe("Page orientation (for 'setup')"),
    margins_cm: z.number().optional().describe("All margins in centimetres (for 'setup')"),
    width_mm: z.number().optional().describe("Custom page width in millimetres"),
    height_mm: z.number().optional().describe("Custom page height in millimetres"),
    header: z.string().optional().describe("Header text (for 'header_footer')"),
    footer: z.string().optional().describe("Footer text before the page number"),
    page_number: z.boolean().optional().describe("Add a page-number field to the footer"),
    style: z.string().optional().describe("Page style name (default Standard)")
  },
  async ({ action, orientation, margins_cm, width_mm, height_mm, header, footer, page_number, style }) => {
    if (action === "setup") {
      const data = { orientation, width_mm, height_mm, style };
      if (margins_cm !== undefined) {
        data.margin_left_cm = margins_cm;
        data.margin_right_cm = margins_cm;
        data.margin_top_cm = margins_cm;
        data.margin_bottom_cm = margins_cm;
      }
      return jsonResponse(await callLibreoffice("/tools/page_setup_live", "POST", data));
    } else if (action === "header_footer") {
      return jsonResponse(await callLibreoffice("/tools/page_header_footer_live", "POST", {
        header, footer, page_number, style
      }));
    }
    return toolError(action, `Invalid action '${action}'.`, "Valid actions: setup, header_footer.");
  }
);

// =============================================================================
// TOOL: table (high-level Writer table)
// =============================================================================
server.tool(
  "table",
  `Create a native Writer table with optional computed total.

- create(values, total_column?, total_label?, header?): values is a 2-D array.
  When total_column is given, a total row is appended and that column gets a
  Writer sum formula over the data rows. Numbers stay numbers.`,
  {
    action: z.enum(["create"]).describe("Operation to perform"),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional()
      .describe("2-D array of rows (including the header row)"),
    total_column: z.number().int().optional().describe("0-based column to total (adds a total row)"),
    total_label: z.string().optional().describe("Label in the total row (default 'Total')"),
    header: z.boolean().default(true).describe("The first values row is a header")
  },
  async ({ action, values, total_column, total_label, header }) => {
    if (action !== "create") return toolError(action, `Invalid action '${action}'.`, "Valid actions: create.");
    if (!Array.isArray(values) || !values.length) return toolError(action, "Missing 'values'.", "Pass a 2-D array of rows.");
    return jsonResponse(await callLibreoffice("/tools/writer_table_live", "POST", {
      values, total_column, total_label, header
    }));
  }
);

// =============================================================================
// TOOL: layout (deterministic, UNO-native addressing, batches and measurement)
// =============================================================================
server.tool(
  "layout",
  `Deterministic layout layer on top of UNO. UNO remains the document model and
the layout engine; this tool adds stable paths, checkpointed batches and
measurement/diagnostics.

Paths are absolute and resolve fresh on every call:
  doc
  doc/body/p[3]                         paragraph 3 (1-indexed)
  doc/body/bookmark:intro              bookmark anchor
  doc/body/frame:sidebar               text frame
  doc/body/table:Budget                Writer table
  doc/body/table:Budget/row[2]/cell[3] table cell
  doc/body/image:logo                  picture
  doc/body/object:Object1              embedded object
  doc/sheets[0]/cell:A1:B5             Calc range
  doc/drawpage/shape:Chart1            shape by name
  doc/sheets:Data/drawpage/shape:Chart1

Actions:
- resolve(path): resolve a path to a UNO handle, kind and text preview.
- bookmark(path, name): name a paragraph (bookmark) or a shape (Name property),
  giving you a durable ID that survives save/reload.
- begin(): checkpoint the document and lock controllers.
- apply(ops): apply {op:"set"|"call"|"insert_text"|"bookmark", path, ...} as one
  batch. Every set is read back; failures are reported per operation.
- commit(): unlock and increment the revision; returns a layout hash.
- rollback(): restore the checkpoint and the previous revision.
- measure(paths): boxes from the live view cursor / shape bounds.
- check(paths, inside_page?, no_overlap?, text_fits?, tolerance?): geometric
  diagnostics (outside_page, overlap, text_overflow).
- status(): revision, open transaction, page count and hash.

Recommended flow: begin -> apply -> check -> commit (rollback on failure).
Lengths are 1/100 mm. This layer does not re-implement paragraph or table
layout; it queries the rendered UNO layout.`,
  {
    action: z.enum(["resolve", "bookmark", "begin", "apply", "commit", "rollback", "measure", "check", "status"])
      .describe("Operation to perform"),
    path: z.string().optional().describe("Absolute layout path"),
    paths: z.array(z.string()).optional().describe("Absolute paths for measure/check"),
    name: z.string().optional().describe("Stable name for the bookmark action"),
    ops: z.array(z.object({
      op: z.enum(["set", "call", "insert_text", "bookmark"]),
      path: z.string(),
      values: z.record(z.string(), z.any()).optional(),
      method: z.string().optional(),
      args: z.array(z.any()).optional(),
      text: z.string().optional(),
      name: z.string().optional()
    })).optional().describe("Batch operations for apply"),
    inside_page: z.boolean().optional().describe("Check page bounds (default true)"),
    no_overlap: z.boolean().optional().describe("Check pairwise overlap (default true)"),
    text_fits: z.boolean().optional().describe("Check text containers for overflow"),
    tolerance: z.number().int().optional().describe("Tolerance in 1/100 mm (default 50)"),
    allow_overlap: z.array(z.array(z.string())).optional()
      .describe("Path pairs allowed to overlap")
  },
  async (args) => jsonResponse(await callLibreoffice("/tools/layout_live", "POST", args))
);

// Connect via Stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
