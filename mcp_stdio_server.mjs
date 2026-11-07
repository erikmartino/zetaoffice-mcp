#!/usr/bin/env node
/**
 * MCP Stdio Server for ZetaJS WebAssembly LibreOffice Bridge
 * 
 * Provides the EXACT SAME 9 consolidated tool definitions and action signatures
 * as the native mcp-libre server (libreoffice_mcp_server.py).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIBREOFFICE_URL = process.env.LIBREOFFICE_URL || "http://localhost:8765";

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
    return data.browser_connected === true;
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
    const res = await fetch(`${LIBREOFFICE_URL}${endpoint}`, options);
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
    let target = result.file_path || fallbackPath;
    if (!target) {
      const dir = path.join(process.cwd(), "mcp-libre-output");
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
      text: z.string().optional()
    })).optional().describe("Slide content for doc_type 'presentation' (each item becomes one Impress slide)")
  },
  async ({ action, doc_type, style_name, parent_style, font_name, font_size, bold, italic, underline, alignment, slides }) => {
    if (action === "create") {
      if (doc_type === "presentation") {
        if (slides && slides.length) {
          return jsonResponse(await callLibreoffice("/tools/create_presentation_live", "POST", { slides }));
        }
        return jsonResponse(await callLibreoffice("/tools/load_presentation_live", "POST", {}));
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
    file_path: z.string().optional().describe("Absolute output path, e.g. /home/me/out.odt (required for 'export')"),
    export_format: z.enum(["pdf", "docx", "odt", "html", "txt", "odp", "pptx", "ppt"]).default("pdf").describe("Output format (for 'export')")
  },
  async ({ action, file_path, export_format }) => {
    if (action === "save") {
      const data = {};
      if (file_path) data.file_path = file_path;
      const result = await callLibreoffice("/tools/save_document_live", "POST", data);
      return jsonResponse(persistSaveResult(result, file_path));
    } else if (action === "export") {
      if (!file_path) return toolError(action, "Missing 'file_path'.", "Pass an absolute path, e.g. /home/me/report.odt.");
      const result = await callLibreoffice("/tools/export_document_live", "POST", {
        file_path,
        format: export_format
      });
      return jsonResponse(persistSaveResult(result, file_path));
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

// =============================================================================
// CONSOLIDATED TOOL 11: picture
// Actions: insert (inline graphic object from a local file)
// =============================================================================
server.tool(
  "picture",
  `Insert a raster picture into the document.

- insert(file_path, width_cm?, height_cm?, display?, align?): load a local
  png/jpg/gif/bmp file on the MCP server's filesystem and insert it as a real
  inline graphic (com.sun.star.text.TextGraphicObject).
  display (default true) puts it on its own paragraph; align is
  left|center|right. Sizes are in centimetres (default 5 x 5).

The image bytes are embedded in the document on export; use
save(export, export_format:"odt"|"docx"|"pdf").`,
  {
    action: z.enum(["insert"]).describe("Operation to perform"),
    file_path: z.string().optional().describe("Absolute path to a local image (png/jpg/gif/bmp) for 'insert'"),
    width_cm: z.number().optional().describe("Display width in centimetres (default 5)"),
    height_cm: z.number().optional().describe("Display height in centimetres (default 5)"),
    display: z.boolean().default(true).describe("Put the picture on its own paragraph"),
    align: z.enum(["left", "center", "right"]).optional().describe("Paragraph alignment for a displayed picture")
  },
  async ({ action, file_path, width_cm, height_cm, display, align }) => {
    if (action !== "insert") return toolError(action, `Invalid action '${action}'.`, "Valid actions: insert.");
    if (!file_path) return toolError(action, "Missing 'file_path'.", "Pass an absolute path, e.g. /home/me/maxwell.jpg.");
    let bytes;
    try {
      bytes = fs.readFileSync(file_path);
    } catch (err) {
      return toolError(action, `Cannot read '${file_path}': ${err.message}`, "Pass an absolute path to a png/jpg/gif/bmp file.");
    }
    const ext = (path.extname(file_path).replace(/^\./, '') || 'png').toLowerCase();
    const data = { image_base64: bytes.toString('base64'), image_type: ext, display };
    if (width_cm !== undefined) data.width_cm = width_cm;
    if (height_cm !== undefined) data.height_cm = height_cm;
    if (align) data.align = align;
    return jsonResponse(await callLibreoffice("/tools/insert_picture_live", "POST", data));
  }
);

// Connect via Stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
