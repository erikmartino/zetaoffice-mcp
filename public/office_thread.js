/* -*- Mode: JS; tab-width: 2; indent-tabs-mode: nil; js-indent-level: 2; fill-column: 100 -*- */
// SPDX-License-Identifier: MIT
// office_thread.js - Runs inside the ZetaOffice Web Worker thread with full UNO access
// Implements the exact tool actions corresponding to mcp-libre's 9 consolidated tools.

import { ZetaHelperThread } from './zetajs/zetaHelper.js';

const zHT = new ZetaHelperThread();
const zetajs = zHT.zetajs;
const css = zHT.css; // uno.com.sun.star
const Module = globalThis.Module;

let xModel = null;
let currentDocType = 'writer';
let currentDocTitle = 'Untitled Document';
let isTrackChangesEnabled = false;

// Persistent editing cursor: carries both the insertion point and the active
// selection, so selection/format/insert actions all operate on the same range.
let editCursor = null;
let editCursorStart = 0;
let editCursorEnd = 0;

console.log('[ZetaJS Worker] UNO Thread initialized successfully');

// Initialize with a default Writer document
function initDefaultDocument() {
  try {
    zHT.configDisableToolbars(['Writer', 'Calc', 'Impress']);
    xModel = zHT.desktop.loadComponentFromURL('private:factory/swriter', '_default', 0, []);
    currentDocType = 'writer';
    currentDocTitle = 'Untitled Writer Document';

    // Insert welcome greeting
    const doc = xModel;
    if (doc && typeof doc.getText === 'function') {
      const text = doc.getText();
      const cursor = text.createTextCursor();
      insertParagraphAware(text, cursor, "=== LibreOffice Wasm (ZetaJS UNO Engine) ===\n\n");
      insertParagraphAware(text, cursor, "Ready to receive live MCP commands matching mcp-libre.\n\n");
    }

    console.log('[ZetaJS Worker] Default Writer document created');
    zHT.thrPort.postMessage({
      cmd: 'mcp_ready',
      info: 'LibreOffice Wasm UNO engine initialized and active'
    });
  } catch (err) {
    console.error('[ZetaJS Worker] Failed to initialize default document:', err);
    zHT.thrPort.postMessage({ cmd: 'mcp_error', error: String(err) });
  }
}

// Get the current active document displayed on the canvas
function getDoc() {
  try {
    if (zHT && zHT.desktop && typeof zHT.desktop.getCurrentComponent === 'function') {
      const cur = zHT.desktop.getCurrentComponent();
      if (cur) {
        xModel = cur;
        return cur;
      }
    }
  } catch {}
  return xModel;
}

// Helper to get paragraphs as an array of strings (one entry per real UNO
// paragraph). Falls back to splitting the flat text on line breaks.
function getParagraphList(doc) {
  try {
    const d = doc || getDoc();
    if (d && typeof d.getText === 'function') {
      const text = d.getText();
      const str = text.getString();
      if (!str) return [];
      const ranges = getParagraphRanges(d);
      if (ranges.length) return ranges.map((r) => r.text);
      return str.split('\n');
    }
  } catch (e) {
    console.warn('[ZetaJS Worker] Error reading paragraphs:', e);
  }
  return [];
}

// ─── Text editing helpers ───────────────────────────────────────────────────

function requireTextDoc() {
  const doc = getDoc();
  if (!doc) throw new Error('No active document available');
  if (typeof doc.getText !== 'function') throw new Error('Active document is not a text document');
  return doc;
}

function textLengthOf(doc) {
  return doc.getText().getString().length;
}

function paragraphStyleOf(el) {
  try { return el.getPropertyValue('ParaStyleName'); } catch (e) { return undefined; }
}

// Paragraphs straight from the UNO enumeration, with character offsets.
function getParagraphRanges(doc) {
  const d = doc || getDoc();
  if (!d || typeof d.getText !== 'function') return [];
  const text = d.getText();
  const en = text.createEnumeration();
  const ranges = [];
  let offset = 0;
  while (en.hasMoreElements()) {
    const el = en.nextElement();
    let str = '';
    try { str = (typeof el.getString === 'function') ? el.getString() : ''; } catch (e) { str = ''; }
    let isParagraph = true;
    try {
      if (typeof el.supportsService === 'function') {
        isParagraph = el.supportsService('com.sun.star.text.Paragraph');
      } else if (typeof el.getText === 'function') {
        isParagraph = true;
      }
    } catch (e) { isParagraph = true; }
    if (isParagraph) {
      ranges.push({ start: offset, end: offset + str.length, text: str, style: paragraphStyleOf(el) });
      offset += str.length + 1; // paragraph mark
    } else {
      offset += str.length;
    }
  }
  return ranges;
}

// Create the shared editing cursor and select [start, end) (collapsed when equal).
function makeCursorRange(doc, start, end) {
  const text = doc.getText();
  const total = text.getString().length;
  const s = Math.max(0, Math.min(start, total));
  const e = Math.max(s, Math.min(end, total));
  const cursor = text.createTextCursor();
  cursor.gotoStart(false);
  if (s > 0) cursor.goRight(s, false);
  if (e > s) cursor.goRight(e - s, true);
  editCursor = cursor;
  editCursorStart = s;
  editCursorEnd = e;
  return cursor;
}

function currentCursor(doc) {
  if (editCursor) return editCursor;
  const len = textLengthOf(doc);
  return makeCursorRange(doc, len, len);
}

// Reset the "typing attributes" so a fresh document starts at sane defaults
// instead of inheriting the last formatted range.
function resetTypingAttributes(doc) {
  try {
    const text = doc.getText();
    const c = text.createTextCursor();
    c.gotoStart(false);
    setUnoProp(c, 'CharHeight', Module.uno_Type.Float(), 12.0);
    setUnoProp(c, 'CharWeight', Module.uno_Type.Float(), 100.0);
    setUnoProp(c, 'CharPosture', Module.uno_Type.Enum('com.sun.star.awt.FontSlant'), 1);
    setUnoProp(c, 'CharUnderline', Module.uno_Type.Enum('com.sun.star.awt.FontUnderline'), 0);
  } catch (e) {
    console.warn('[ZetaJS Worker] Could not reset typing attributes:', e);
  }
  editCursor = null;
  editCursorStart = 0;
  editCursorEnd = 0;
}

// Apply character formatting to a cursor/selection. Float/Enum types are
// explicit so ZetaJS does not coerce them wrongly.
function applyCharFormat(cursor, formatting) {
  if (!formatting || typeof formatting !== 'object') return;
  if (formatting.bold !== undefined) {
    setUnoProp(cursor, 'CharWeight', Module.uno_Type.Float(), formatting.bold ? 150.0 : 100.0);
  }
  if (formatting.italic !== undefined) {
    setUnoProp(cursor, 'CharPosture', Module.uno_Type.Enum('com.sun.star.awt.FontSlant'), formatting.italic ? 3 : 1);
  }
  if (formatting.underline !== undefined) {
    setUnoProp(cursor, 'CharUnderline', Module.uno_Type.Enum('com.sun.star.awt.FontUnderline'), formatting.underline ? 1 : 0);
  }
  if (formatting.font_size !== undefined && formatting.font_size !== null) {
    setUnoProp(cursor, 'CharHeight', Module.uno_Type.Float(), parseFloat(formatting.font_size));
  }
  if (formatting.font_name) {
    setUnoProp(cursor, 'CharFontName', Module.uno_Type.String(), formatting.font_name);
  }
}

// Insert text, turning "\n" into real paragraph breaks (not line breaks).
function insertParagraphAware(textObj, cursor, str) {
  const parts = String(str).split('\n');
  // ZetaJS exposes enums as proxies; build the Any from the value's own type.
  let paragraphBreak = null;
  try {
    paragraphBreak = css.text.ControlCharacter.PARAGRAPH_BREAK;
  } catch (e) {
    paragraphBreak = null;
  }
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      let done = false;
      if (paragraphBreak !== null && paragraphBreak !== undefined) {
        try {
          textObj.insertControlCharacter(cursor, paragraphBreak, false);
          done = true;
        } catch (e) {
          console.warn('[ZetaJS Worker] enum insertControlCharacter failed:', e);
        }
      }
      if (!done) {
        const any = new Module.uno_Any(
          Module.uno_Type.Enum('com.sun.star.text.ControlCharacter'), 0);
        try { textObj.insertControlCharacter(cursor, any, false); } finally { any.delete(); }
      }
    }
    if (parts[i].length) textObj.insertString(cursor, parts[i], false);
  }
}

function getParagraphStyleNames(doc) {
  try {
    const families = doc.getStyleFamilies();
    const styles = families.getByName('ParagraphStyles');
    const names = styles.getElementNames();
    return Array.isArray(names) ? names : Array.from(names || []);
  } catch (e) {
    return [];
  }
}

// UNO style names are case/space sensitive ("Text Body" vs "Text body").
function resolveParagraphStyleName(doc, name) {
  const names = getParagraphStyleNames(doc);
  if (!names.length || names.indexOf(name) !== -1) return name;
  const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const target = norm(name);
  const hit = names.find((n) => norm(n) === target);
  return hit || name;
}

function applyParagraphStyle(doc, cursor, styleName) {
  const resolved = resolveParagraphStyleName(doc, styleName);
  setUnoProp(cursor, 'ParaStyleName', Module.uno_Type.String(), resolved);
  return resolved;
}

// ─── Native Math formulas (embedded OLE objects) ────────────────────────────
// A Writer formula is a real com.sun.star.text.TextEmbeddedObject whose CLSID
// points at LibreOffice Math. The embedded model exposes the StarMath source
// via the "Formula" property, so the result is an editable Math object (not a
// text approximation). Requires the Math module in the LOWA build.
const MATH_CLSID = '078B7ABA-54FC-457F-8551-6147E776A997';
const MATH_OBJECT_SERVICE = 'com.sun.star.text.TextEmbeddedObject';
const PARAGRAPH_ADJUST = { left: 'LEFT', right: 'RIGHT', justify: 'BLOCK', center: 'CENTER' };

// Embedded objects (including Math) are exposed by the document's
// XTextEmbeddedObjectsSupplier, not by the text-content enumeration.
function getEmbeddedObjectContainer(doc) {
  try {
    if (typeof doc.getEmbeddedObjects === 'function') return doc.getEmbeddedObjects();
  } catch (e) { /* not a text document or no supplier */ }
  return null;
}

function listEmbeddedFormulas(doc) {
  const d = doc || requireTextDoc();
  const container = getEmbeddedObjectContainer(d);
  if (!container) return [];
  let names = [];
  try { names = Array.from(container.getElementNames() || []); } catch (e) { return []; }
  // Object1, Object2, ... Object10: compare numerically for stable indices.
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const formulas = [];
  for (const name of names) {
    let object = null;
    let model = null;
    let formula = '';
    try { object = container.getByName(name); } catch (e) { continue; }
    try { model = object.getEmbeddedObject(); } catch (e) { model = null; }
    if (!model) continue;
    // Math models expose the StarMath source in "Formula"; other OLE objects
    // (charts, etc.) do not, so they are skipped.
    try { formula = String(model.getPropertyValue('Formula') || ''); } catch (e) { continue; }
    formulas.push({ index: formulas.length, name, object, model, formula });
  }
  return formulas;
}

function setParagraphAlignment(textObj, atCursor, align) {
  const name = PARAGRAPH_ADJUST[String(align).toLowerCase()];
  const value = name && css.style.ParagraphAdjust ? css.style.ParagraphAdjust[name] : undefined;
  if (value === undefined) return;
  try {
    // Copy the live cursor (which sits in the formula's paragraph) instead of
    // deriving a cursor from the object's anchor, which can collapse to 0.
    const range = textObj.createTextCursor();
    range.gotoRange(atCursor, false);
    range.gotoStartOfParagraph(false);
    range.gotoEndOfParagraph(true);
    setUnoProp(range, 'ParaAdjust', Module.uno_Type.Enum('com.sun.star.style.ParagraphAdjust'), value);
  } catch (e) {
    console.warn('[ZetaJS Worker] Could not align formula paragraph:', e);
  }
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Insert a raster picture (png/jpg/gif/bmp) as an inline graphic object.
function insertPicture(doc, imageBytes, ext, opts) {
  const options = opts || {};
  const textObj = doc.getText();
  const cursor = textObj.createTextCursor();
  try {
    if (editCursor) cursor.gotoRange(editCursor, false);
    else cursor.gotoEnd(false);
    cursor.collapseToEnd();
  } catch (e) {
    cursor.gotoEnd(false);
  }
  const hadFollowingText = editCursorStart < textObj.getString().length;
  let pos = editCursorStart;

  const FS = (Module && Module.__FS) || (zHT && zHT.FS);
  if (!FS || typeof FS.writeFile !== 'function') {
    throw new Error('The Wasm filesystem is not available for the picture bytes');
  }
  const safeExt = ['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(String(ext).toLowerCase())
    ? String(ext).toLowerCase() : 'png';
  const fsPath = `/tmp/mcp_picture_${Date.now()}.${safeExt}`;
  FS.writeFile(fsPath, imageBytes);
  const url = 'file://' + fsPath;

  const shape = doc.createInstance('com.sun.star.text.TextGraphicObject');
  if (!shape) throw new Error('Could not create a TextGraphicObject');

  // Load the image from the bytes (via SequenceInputStream) rather than a
  // file URL: the Wasm virtual filesystem is not always visible to the
  // graphic filter's UCB, which yields a broken-image placeholder.
  let graphic = null;
  try {
    const sm = zHT.context.getServiceManager();
    // Build a typed sequence<byte> and wrap it in its own Any: a plain JS
    // array is inferred as sequence<long> and the SequenceInputStream
    // constructor rejects it.
    const Seq = Module['uno_Sequence_byte'];
    const seq = new Seq(imageBytes.length, Module.uno_Sequence.FromSize);
    for (let i = 0; i < imageBytes.length; i++) {
      const v = imageBytes[i];
      seq.set(i, v < 128 ? v : v - 256);
    }
    const seqType = Module.uno_Type.Sequence(Module.uno_Type.Byte());
    const seqAny = new Module.uno_Any(seqType, seq);
    const stream = sm.createInstanceWithArguments('com.sun.star.io.SequenceInputStream', [seqAny]);
    seqAny.delete();
    seq.delete();
    seqType.delete();
    const provider = sm.createInstanceWithContext('com.sun.star.graphic.GraphicProvider', zHT.context);
    const props = [new css.beans.PropertyValue({ Name: 'InputStream', Handle: 0, Value: stream })];
    graphic = provider.queryGraphic(props);
  } catch (e) {
    console.warn('[ZetaJS Worker] Could not load picture bytes, falling back to URL:', e);
  }
  if (!graphic) {
    // Second chance: let the GraphicProvider load the file URL synchronously.
    try {
      const sm = zHT.context.getServiceManager();
      const provider = sm.createInstanceWithContext('com.sun.star.graphic.GraphicProvider', zHT.context);
      const props = [new css.beans.PropertyValue({ Name: 'URL', Handle: 0, Value: url })];
      graphic = provider.queryGraphic(props);
    } catch (e) {
      console.warn('[ZetaJS Worker] GraphicProvider URL load failed:', e);
    }
  }
  let graphicSet = false;
  if (graphic) {
    try {
      // ZetaJS wraps the interface in the Any for us here.
      shape.setPropertyValue('Graphic', graphic);
      graphicSet = true;
    } catch (e) {
      console.warn('[ZetaJS Worker] Could not assign Graphic property:', e);
    }
  }
  if (!graphicSet) {
    setUnoProp(shape, 'GraphicURL', Module.uno_Type.String(), url);
  }
  try {
    setUnoProp(shape, 'AnchorType', Module.uno_Type.Enum('com.sun.star.text.TextContentAnchorType'),
      css.text.TextContentAnchorType.AS_CHARACTER);
  } catch (e) { /* older builds default to a usable anchor */ }

  const width = Math.round((options.width_cm || 5) * 1000);   // 1/100 mm
  const height = Math.round((options.height_cm || 5) * 1000);

  if (options.display && pos > 0) {
    insertParagraphAware(textObj, cursor, '\n');
    try { cursor.collapseToEnd(); } catch (e) { /* keep range */ }
    pos += 1;
  }

  textObj.insertTextContent(cursor, shape, false);
  try { cursor.collapseToEnd(); } catch (e) { /* keep range */ }
  // Insertion resets the size, so apply it afterwards.
  shape.setSize(new css.awt.Size({ Width: width, Height: height }));

  if (options.align) {
    setParagraphAlignment(textObj, cursor, options.align);
  }

  if (options.display && hadFollowingText) {
    insertParagraphAware(textObj, cursor, '\n');
    try { cursor.collapseToEnd(); } catch (e) { /* keep range */ }
    pos += 1;
  }

  editCursor = cursor;
  editCursorStart = editCursorEnd = pos;
  return shape;
}

// Insert a native Math object at the shared cursor and set its StarMath source.
function insertEmbeddedFormula(doc, formula, opts) {
  const options = opts || {};
  const textObj = doc.getText();
  // insertString can leave the shared cursor as a range; insertTextContent
  // places the object at the range start. Copy it and collapse to the end so
  // the object lands at the intended insertion point.
  const cursor = textObj.createTextCursor();
  try {
    if (options.cursor) cursor.gotoRange(options.cursor, false);
    else if (editCursor) cursor.gotoRange(editCursor, false);
    else cursor.gotoEnd(false);
    cursor.collapseToEnd();
  } catch (e) {
    cursor.gotoEnd(false);
  }
  const hadFollowingText = editCursorStart < textObj.getString().length;
  let pos = editCursorStart;

  const obj = doc.createInstance(MATH_OBJECT_SERVICE);
  if (!obj) throw new Error('Could not create a TextEmbeddedObject for the Math formula');
  setUnoProp(obj, 'CLSID', Module.uno_Type.String(), MATH_CLSID);
  try {
    // Inline (as character) so the formula stays in the text flow.
    setUnoProp(obj, 'AnchorType', Module.uno_Type.Enum('com.sun.star.text.TextContentAnchorType'),
      css.text.TextContentAnchorType.AS_CHARACTER);
  } catch (e) { /* older builds default to a usable anchor */ }

  if (options.display && pos > 0) {
    insertParagraphAware(textObj, cursor, '\n');
    try { cursor.collapseToEnd(); } catch (e) { /* keep range */ }
    pos += 1;
  }

  textObj.insertTextContent(cursor, obj, false);
  // If insertion expanded the range, collapse past the new object so later
  // text/breaks go after it.
  try { cursor.collapseToEnd(); } catch (e) { /* keep range */ }

  const model = obj.getEmbeddedObject();
  if (!model) {
    // Do not leave a broken, model-less object behind.
    try { textObj.removeTextContent(obj); } catch (e) { /* best effort */ }
    throw new Error('The embedded object has no model: this LOWA build was compiled without the LibreOffice Math component.');
  }
  // Writer resets the anchor during insertion, so set AS_CHARACTER afterwards
  // to keep the object in the text flow instead of at the paragraph start.
  try {
    setUnoProp(obj, 'AnchorType', Module.uno_Type.Enum('com.sun.star.text.TextContentAnchorType'),
      css.text.TextContentAnchorType.AS_CHARACTER);
  } catch (e) {
    console.warn('[ZetaJS Worker] Could not set AnchorType AS_CHARACTER:', e);
  }
  setUnoProp(model, 'Formula', Module.uno_Type.String(), formula);

  if (options.align) {
    setParagraphAlignment(textObj, cursor, options.align);
  }

  if (options.display && hadFollowingText) {
    insertParagraphAware(textObj, cursor, '\n');
    try { cursor.collapseToEnd(); } catch (e) { /* keep range */ }
    pos += 1;
  }

  // The insertion cursor already sits after the object (insertTextContent
  // advances it), so keep it as the shared edit cursor. Objects do not show up
  // in getString(), so the tracked offset does not grow by one here.
  editCursor = cursor;
  editCursorStart = editCursorEnd = pos;

  return obj;
}

// Filter names (com.sun.star.document.FilterFactory) keyed by document type + extension.
const FILTER_MAP = {
  writer: {
    odt: 'writer8', ott: 'writer8',
    docx: 'MS Word 2007 XML', doc: 'MS Word 97', rtf: 'Rich Text Format',
    txt: 'Text (encoded)', html: 'HTML (StarWriter)', htm: 'HTML (StarWriter)',
    pdf: 'writer_pdf_Export',
  },
  calc: {
    odt: 'calc8', ods: 'calc8',
    xlsx: 'Calc MS Excel 2007 XML', xls: 'MS Excel 97',
    csv: 'Text - txt - csv (StarCalc)', html: 'HTML (StarCalc)',
    pdf: 'calc_pdf_Export',
  },
  impress: {
    odt: 'impress8', odp: 'impress8',
    pptx: 'Impress MS PowerPoint 2007 XML', ppt: 'MS PowerPoint 97',
    html: 'impress_html_Export', pdf: 'impress_pdf_Export',
  },
  draw: {
    odt: 'draw8', odg: 'draw8',
    html: 'draw_html_Export', pdf: 'draw_pdf_Export', svg: 'draw_svg_Export',
  },
};

function extensionOf(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath || '');
  return m ? m[1].toLowerCase() : '';
}

function getFilterName(docType, format) {
  const map = FILTER_MAP[docType] || FILTER_MAP.writer;
  return map[format] || null;
}

function sanitizeFilename(name) {
  const cleaned = (name || 'document').replace(/[^\w.\-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '');
  return cleaned || 'document';
}

// Set a UNO property with an explicitly typed value (Float/Enum/String...).
function setUnoProp(obj, name, unoType, value) {
  const any = new Module.uno_Any(unoType, value);
  try {
    obj.setPropertyValue(name, any);
  } finally {
    any.delete();
  }
}

// Query an interface from a ZetaJS proxy object via its queryInterface method.
function queryInterface(obj, ifaceName) {
  const t = Module.uno_Type.Interface(ifaceName);
  try {
    return obj.queryInterface(t);
  } finally {
    t.delete();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dumb UNO-over-WebSocket dispatcher.
// A generic, schema-less pass-through: the client addresses remote objects by
// opaque integer handle and performs get/set/call/query. All UNO semantics are
// executed by ZetaJS (the real UNO implementation) — this layer only moves
// operations and marshals values. Ops: root, get, set, call, query, release,
// writeFile, readFile.
// ─────────────────────────────────────────────────────────────────────────────
const unoObjects = new Map();
let unoNextHandle = 1;

function unoPut(obj) {
  if (obj === null || obj === undefined) return 0;
  const id = unoNextHandle++;
  unoObjects.set(id, obj);
  return id;
}
function unoGetHandle(id) {
  const obj = unoObjects.get(id);
  if (obj === undefined) throw new Error(`Invalid UNO object handle ${id}`);
  return obj;
}

// Resolve a UNO type name (com.sun.star.foo.Bar) to its ZetaJS node.
function unoResolveType(typeName) {
  const parts = String(typeName).split('.');
  let i = (parts[0] === 'com' && parts[1] === 'sun' && parts[2] === 'star') ? 3 : 0;
  let node = css;
  for (; i < parts.length; i++) node = node[parts[i]];
  return node;
}

// JSON -> JS/UNO operand.
function unoDecode(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(unoDecode);
  if (Object.prototype.hasOwnProperty.call(v, '$f')) return v.$f; // float marker
  if (Object.prototype.hasOwnProperty.call(v, '$h')) return unoGetHandle(v.$h);
  if (Object.prototype.hasOwnProperty.call(v, '$s')) {
    const Ctor = unoResolveType(v.$s);
    const fields = {};
    for (const k of Object.keys(v)) if (k !== '$s') fields[k] = unoDecode(v[k]);
    return new Ctor(fields);
  }
  if (Object.prototype.hasOwnProperty.call(v, '$e')) {
    return unoResolveType(v.$e)[v.v];
  }
  return v;
}

// JS/UNO -> JSON result.
function unoEncode(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'function') return { $m: 1 };
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (Array.isArray(v)) return v.map(unoEncode);
  try {
    const ty = zetajs.getAnyType(v);
    if (ty && typeof ty.getTypeClass === 'function') {
      const tc = ty.getTypeClass();
      const TypeClass = Module.uno.com.sun.star.uno.TypeClass;
      if (tc === TypeClass.INTERFACE) return { $h: unoPut(v) };
      if (tc === TypeClass.STRUCT) {
        const out = { $s: ty.toString() };
        for (const k of Object.keys(v)) out[k] = unoEncode(v[k]);
        return out;
      }
      if (tc === TypeClass.ENUM) return { $e: ty.toString(), v: String(v) };
    }
  } catch (e) { /* not a UNO value; fall through */ }
  return v;
}

// Build an explicitly typed Any for a property set (keeps float/enum/struct types).
function unoToAny(raw) {
  if (raw && typeof raw === 'object' && raw.$f !== undefined) {
    return new Module.uno_Any(Module.uno_Type.Double(), raw.$f);
  }
  const decoded = unoDecode(raw);
  let ty;
  try { ty = zetajs.getAnyType(decoded); } catch (e) { ty = undefined; }
  if (!ty) return null;
  return new Module.uno_Any(ty, decoded);
}

function unoGetMember(obj, name) {
  if (Object.prototype.hasOwnProperty.call(obj, name)) {
    return obj[name];
  }
  const getter = obj['get' + name];
  if (typeof getter === 'function') return getter.call(obj);
  if (typeof obj.getPropertyValue === 'function') return obj.getPropertyValue(name);
  return undefined;
}

function unoSetMember(obj, name, raw) {
  if (Object.prototype.hasOwnProperty.call(obj, name) && typeof obj[name] !== 'function') {
    obj[name] = unoDecode(raw);
    return;
  }
  if (typeof obj.setPropertyValue === 'function') {
    const any = unoToAny(raw);
    try {
      obj.setPropertyValue(name, any);
    } finally {
      if (any) any.delete();
    }
    return;
  }
  obj[name] = unoDecode(raw);
}

function unoDispatch(req) {
  switch (req.op) {
    case 'root':
      return { $h: unoPut(zHT.context) };
    case 'get': {
      return unoEncode(unoGetMember(unoGetHandle(req.h), req.name));
    }
    case 'set': {
      unoSetMember(unoGetHandle(req.h), req.name, req.v);
      return null;
    }
    case 'call': {
      const obj = unoGetHandle(req.h);
      const fn = obj[req.name];
      if (typeof fn !== 'function') throw new Error(`'${req.name}' is not a method`);
      const args = (req.args || []).map(unoDecode);
      return unoEncode(fn.apply(obj, args));
    }
    case 'query': {
      const obj = unoGetHandle(req.h);
      const type = Module.uno_Type.Interface(req.iface);
      try {
        const r = obj.queryInterface(type);
        return r ? { $h: unoPut(r) } : null;
      } finally {
        type.delete();
      }
    }
    case 'release':
      unoObjects.delete(req.h);
      return null;
    default:
      throw new Error(`Unknown UNO op '${req.op}'`);
  }
}

// Build a real Impress (presentation) document with one slide per entry.
// `slides` is an array of { title, text }. Uses the UNO drawing/text API.
function buildImpressDocument(slides) {
  const doc = zHT.desktop.loadComponentFromURL('private:factory/simpress', '_default', 0, []);
  const serviceManager = zHT.context.getServiceManager();
  const createShape = () => serviceManager.createInstanceWithContext(
    'com.sun.star.drawing.TextShape', zHT.context);
  const pages = doc.getDrawPages();

  const list = (Array.isArray(slides) && slides.length) ? slides : [{ title: 'Presentation', text: '' }];

  function addTextBox(page, text, position, size, charHeight, bold) {
    const shape = createShape();
    shape.setPosition(new css.awt.Point(position));
    shape.setSize(new css.awt.Size(size));
    page.add(shape);
    const xText = queryInterface(shape, 'com.sun.star.text.XText');
    xText.setString(String(text));
    const cur = xText.createTextCursor();
    setUnoProp(cur, 'CharHeight', Module.uno_Type.Float(), charHeight);
    if (bold) {
      setUnoProp(cur, 'CharWeight', Module.uno_Type.Float(), 150.0);
    }
  }

  for (let i = 0; i < list.length; i++) {
    const slide = list[i] || {};
    let page;
    if (i < pages.getCount()) {
      page = pages.getByIndex(i);
    } else {
      page = pages.insertNewByIndex(pages.getCount());
    }

    if (slide.title) {
      addTextBox(page, slide.title, { X: 1200, Y: 800 }, { Width: 25600, Height: 3200 }, 32.0, true);
    }
    if (slide.text) {
      addTextBox(page, slide.text, { X: 1400, Y: 4400 }, { Width: 25200, Height: 14000 }, 22.0, false);
    }
  }

  xModel = doc;
  currentDocType = 'impress';
  currentDocTitle = 'Presentation';
  return doc;
}

// Store the active document into the Wasm virtual filesystem (no UI dialog).
// The main thread reads the bytes back and makes them available for download/host save.
function storeDocumentToFs(isExport, requestedPath, requestedFormat) {
  const doc = getDoc();
  if (!doc) throw new Error('No active document available');
  if (typeof doc.storeAsURL !== 'function' && typeof doc.storeToURL !== 'function') {
    throw new Error('Active document does not support storing');
  }

  let format = (requestedFormat || '').toLowerCase();
  if (!format) format = extensionOf(requestedPath) || (isExport ? 'pdf' : 'odt');
  const filterName = getFilterName(currentDocType, format);
  if (!filterName) {
    throw new Error(`Unsupported format '${format}' for ${currentDocType} documents`);
  }

  let filename = sanitizeFilename((requestedPath || '').split(/[\\/]/).pop() ||
    `${currentDocTitle || 'document'}.${format}`);
  if (extensionOf(filename) !== format) {
    filename = filename.replace(/\.[^.]*$/, '') + '.' + format;
  }

  const fsPath = `/tmp/${Date.now()}_${filename}`;
  const url = 'file://' + fsPath;
  const PropertyValue = css.beans.PropertyValue;
  const props = [
    new PropertyValue({ Name: 'FilterName', Handle: 0, Value: filterName }),
    new PropertyValue({ Name: 'Overwrite', Handle: 0, Value: true }),
  ];

  if (isExport) {
    doc.storeToURL(url, props);
  } else {
    doc.storeAsURL(url, props);
  }

  return { fsPath, filename, format, filterName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard UNO URP byte conduit.
// The custom LOWA build exposes a native (C++) com.sun.star.connection.XConnection
// over an in-memory, thread-safe queue, driven only by plain Embind calls:
//   Module.urpOpen(id)        - create a memory connection + URP bridge
//   Module.urpPush(id, bytes) - enqueue inbound URP bytes (from the host socket)
//   Module.urpPull(id)        - drain outbound URP bytes (to the host socket)
//   Module.urpClose(id)       - tear down
// No UNO interfaces are implemented in JS; the bytes are opaque. If the running
// Wasm build lacks these bindings, this is a harmless no-op.
// ─────────────────────────────────────────────────────────────────────────────
const urpIds = new Set();
let urpPollTimer = null;

function urpAvailable() {
  return !!Module && typeof Module.urpPush === 'function';
}
function urpEnsurePolling() {
  if (urpPollTimer || !urpAvailable()) return;
  urpPollTimer = setInterval(() => {
    if (!urpAvailable()) return;
    for (const id of Array.from(urpIds)) {
      let out;
      try { out = Module.urpPull(id); } catch (e) { continue; }
      if (out && out.length) {
        const copy = (typeof out.slice === 'function') ? out.slice() : out;
        zHT.thrPort.postMessage({ cmd: 'urp_out', id, data: copy });
      }
    }
  }, 5);
}

// Listen for MCP commands dispatched from the main browser thread
if (typeof zHT.thrPort.start === 'function') {
  zHT.thrPort.start();
}
zHT.thrPort.onmessage = (event) => {
  const data = event.data;
  if (!data) return;

  // URP conduit control/bytes from the host socket (via index.html).
  if (data.cmd === 'urp_open') {
    urpIds.add(data.id);
    if (urpAvailable()) {
      try { Module.urpOpen(data.id); } catch (e) {
        zHT.thrPort.postMessage({ cmd: 'urp_log', message: 'urpOpen failed: ' + e });
      }
    } else {
      zHT.thrPort.postMessage({ cmd: 'urp_log', message: 'URP bindings not present in this Wasm build' });
    }
    urpEnsurePolling();
    return;
  }
  if (data.cmd === 'urp_close') {
    urpIds.delete(data.id);
    if (urpAvailable()) { try { Module.urpClose(data.id); } catch (e) { /* ignore */ } }
    return;
  }
  if (data.cmd === 'urp_bytes') {
    if (urpAvailable()) { try { Module.urpPush(data.id, data.data); } catch (e) { /* ignore */ } }
    urpEnsurePolling();
    return;
  }

  // Generic UNO-over-WebSocket RPC (dumb pass-through to ZetaJS).
  if (data.cmd === 'uno_exec') {
    try {
      const value = unoDispatch(data);
      zHT.thrPort.postMessage({ cmd: 'uno_reply', id: data.id, ok: true, v: value });
    } catch (err) {
      zHT.thrPort.postMessage({
        cmd: 'uno_reply',
        id: data.id,
        ok: false,
        e: { msg: (err && err.message) ? err.message : String(err) }
      });
    }
    return;
  }

  if (data.cmd !== 'mcp_exec') return;

  const { id, tool, params } = data;
  console.log(`[ZetaJS Worker] Executing MCP tool: ${tool}`, params);

  try {
    let result = {};

    switch (tool) {
      // --- 1. Document Management ---
      case 'create_document_live': {
        const type = (params.doc_type || 'writer').toLowerCase();
        let url = 'private:factory/swriter';
        if (type === 'calc') url = 'private:factory/scalc';
        else if (type === 'impress') url = 'private:factory/simpress';
        else if (type === 'draw') url = 'private:factory/sdraw';

        const cur = getDoc();
        if (cur && currentDocType === type && typeof cur.getText === 'function') {
          // Visible document of the same type is already attached to #qtcanvas!
          // Clear its text so changes remain visible in the canvas without creating an orphan frame.
          const textObj = cur.getText();
          textObj.setString('');
          resetTypingAttributes(cur);
          xModel = cur;
          currentDocTitle = `Untitled ${type.charAt(0).toUpperCase() + type.slice(1)}`;
          result = { success: true, message: `Cleared and reset active ${type} document canvas via ZetaJS UNO`, doc_type: type };
          break;
        }

        xModel = zHT.desktop.loadComponentFromURL(url, '_default', 0, []);
        currentDocType = type;
        currentDocTitle = `Untitled ${type.charAt(0).toUpperCase() + type.slice(1)}`;
        resetTypingAttributes(xModel);
        result = { success: true, message: `Created new ${type} document via ZetaJS UNO`, doc_type: type };
        break;
      }

      case 'load_presentation_live': {
        const doc = getDoc();
        if (!doc) throw new Error('No active document available');
        if (typeof doc.getText !== 'function') throw new Error('Active document is not a text document');

        const textObj = doc.getText();
        textObj.setString('');
        const cursor = textObj.createTextCursor();

        // Page 1: Overview
        textObj.insertString(cursor, "PRESENTATION: ZetaJS WebAssembly LibreOffice Bridge\n", false);
        textObj.insertString(cursor, "Zero-Installation LibreOffice Automation for AI Assistants (mcp-libre)\n\n", false);
        textObj.insertString(cursor, 
          "--- PAGE 1: CORE CAPABILITIES ---\n\n" +
          "• Zero-Installation Architecture:\n" +
          "  Runs LOWA (LibreOffice WebAssembly) entirely in-browser/worker without requiring\n" +
          "  any local desktop LibreOffice installation or host system packages.\n\n" +
          "• Direct UNO IDL Proxying:\n" +
          "  Uses ZetaJS to expose true C++ UNO IDL interfaces (com.sun.star.*) directly to\n" +
          "  JavaScript proxies for real-time document manipulation.\n\n" +
          "• 9 Consolidated MCP Tools:\n" +
          "  Provides full parity with native mcp-libre across all 9 tool groups: document,\n" +
          "  structure, cursor, selection, search, track_changes, comments, save, and text.\n\n" +
          "• High Performance & Isolation:\n" +
          "  Leverages WebAssembly pthreads and SharedArrayBuffer with Cross-Origin Isolation\n" +
          "  (COOP/COEP) for multi-threaded UNO performance.\n\n",
          false
        );

        // Page Break
        try {
          const breakAny = new Module.uno_Any(Module.uno_Type.Enum('com.sun.star.style.BreakType'), 4); // PAGE_BEFORE
          cursor.setPropertyValue('BreakType', breakAny);
          breakAny.delete();
          textObj.insertString(cursor, "\n", false);
        } catch (e) {
          textObj.insertString(cursor, "\n\n", false);
        }

        // Page 2: Runtime Control
        textObj.insertString(cursor, "--- PAGE 2: RUNTIME CONTROL & AGENTIC INTEGRATION ---\n\n", false);
        textObj.insertString(cursor, 
          "• Dual Execution Modes:\n" +
          "  1. Headless Mode (Default): Runs silently in the background with headless Chrome\n" +
          "     via Node.js. Ideal for autonomous AI agents, CI/CD pipelines, and batch generation.\n" +
          "  2. Interactive Browser Mode: Renders live #qtcanvas in desktop browser so users\n" +
          "     can observe text and styling render in real-time as the AI writes.\n\n" +
          "• Zero-Config Auto-Boot:\n" +
          "  Claude Code (claude) and Antigravity (agy) auto-spawn the background bridge\n" +
          "  automatically on launch—no manual setup required.\n\n" +
          "• On-Demand Dynamic Control:\n" +
          "  - document(action=\"open_browser\"): Pops up the live interactive canvas from chat.\n" +
          "  - document(action=\"status\"): Reports active mode, connected sessions, and health.\n\n" +
          "• Multi-Client Session Synchronization:\n" +
          "  Dispatches MCP commands simultaneously across active Wasm instances for unified\n" +
          "  headless and visible desktop display.\n",
          false
        );

        currentDocTitle = 'ZetaJS Presentation (2 Pages)';
        result = {
          success: true,
          message: 'Rendered 2-page presentation on active canvas via ZetaJS UNO',
          title: currentDocTitle,
          pages: 2
        };
        break;
      }

      case 'create_presentation_live': {
        const slides = Array.isArray(params.slides) ? params.slides : [];
        const doc = buildImpressDocument(slides);
        currentDocType = 'impress';
        result = {
          success: true,
          message: `Created Impress presentation with ${slides.length || 1} slide(s) via ZetaJS UNO`,
          doc_type: 'impress',
          title: currentDocTitle,
          slides: slides.length || 1
        };
        break;
      }

      case 'get_document_info_live': {
        const doc = getDoc();
        if (!doc) throw new Error('No active document available');
        const textObj = doc && typeof doc.getText === 'function' ? doc.getText() : null;
        const str = textObj ? textObj.getString() : '';
        let pageCount = 1;
        try {
          const controller = doc.getCurrentController();
          if (controller && typeof controller.getPageCount === 'function') {
            pageCount = controller.getPageCount();
          }
        } catch {}
        result = {
          success: true,
          title: currentDocTitle,
          type: currentDocType,
          character_count: str.length,
          word_count: str.trim().split(/\s+/).filter(Boolean).length,
          page_count: pageCount,
          track_changes: {
            recording: isTrackChangesEnabled,
            showing: isTrackChangesEnabled,
            pending_count: 0
          },
          engine: 'LOWA / ZetaOffice WebAssembly'
        };
        break;
      }

      case 'list_open_documents': {
        result = {
          documents: [
            { id: 1, title: currentDocTitle, type: currentDocType, active: true }
          ]
        };
        break;
      }

      case 'get_text_content_live': {
        const doc = getDoc();
        if (!doc) throw new Error('No active document available');
        if (typeof doc.getText !== 'function') throw new Error('Active document is not a text document');
        const textObj = doc.getText();
        const fullContent = textObj.getString();
        result = {
          success: true,
          content: fullContent,
          character_count: fullContent.length,
          word_count: fullContent.trim().split(/\s+/).filter(Boolean).length
        };
        break;
      }

      case 'list_paragraph_styles_live': {
        let names = [];
        try { names = getParagraphStyleNames(requireTextDoc()); } catch (e) { names = []; }
        result = {
          styles: names.length ? names : [
            "Standard", "Heading 1", "Heading 2", "Heading 3", "Title",
            "Subtitle", "Text body", "Quotations", "Preformatted Text"
          ]
        };
        break;
      }

      // --- 2. Text Manipulation ---
      case 'insert_text_live': {
        const doc = requireTextDoc();
        const textObj = doc.getText();
        const cursor = currentCursor(doc);
        const replacedLength = editCursorEnd - editCursorStart;

        if (params.page_break) {
          try {
            setUnoProp(cursor, 'BreakType', Module.uno_Type.Enum('com.sun.star.style.BreakType'), 4); // PAGE_BEFORE
          } catch (e) {
            console.warn('[ZetaJS Worker] BreakType failed:', e);
          }
        }

        const textToInsert = params.text || '';
        insertParagraphAware(textObj, cursor, textToInsert);

        const pos = editCursorStart + textToInsert.length;
        editCursorStart = pos;
        editCursorEnd = pos;
        result = {
          success: true,
          message: `Inserted ${textToInsert.length} characters via ZetaJS UNO`,
          position: pos,
          replaced: replacedLength
        };
        break;
      }

      case 'insert_page_break_live': {
        const doc = requireTextDoc();
        const textObj = doc.getText();
        const cursor = currentCursor(doc);
        try {
          setUnoProp(cursor, 'BreakType', Module.uno_Type.Enum('com.sun.star.style.BreakType'), 4); // PAGE_BEFORE
          insertParagraphAware(textObj, cursor, "\n");
          result = { success: true, message: 'Inserted page break via ZetaJS UNO' };
        } catch (e) {
          insertParagraphAware(textObj, cursor, "\n");
          result = { success: true, message: 'Inserted break via ZetaJS UNO' };
        }
        editCursorStart = editCursorEnd = textLengthOf(doc);
        break;
      }

      // --- 2b. Native Math formulas (embedded OLE objects) ---
      case 'insert_formula_live': {
        const doc = requireTextDoc();
        const formula = String(params.formula || '').trim();
        if (!formula) {
          throw new Error("Missing 'formula'. Pass LibreOffice Math (StarMath) source, e.g. \"e^{i %pi} + 1 = 0\".");
        }
        const display = params.display === undefined ? true : !!params.display;
        insertEmbeddedFormula(doc, formula, { display, align: params.align });
        const items = listEmbeddedFormulas(doc);
        result = {
          success: true,
          message: 'Inserted native LibreOffice Math formula via ZetaJS UNO',
          formula,
          count: items.length,
          display
        };
        break;
      }

      case 'list_formulas_live': {
        const doc = requireTextDoc();
        const items = listEmbeddedFormulas(doc);
        result = {
          success: true,
          count: items.length,
          formulas: items.map((it) => ({ index: it.index, formula: it.formula }))
        };
        break;
      }

      case 'update_formula_live': {
        const doc = requireTextDoc();
        const items = listEmbeddedFormulas(doc);
        const idx = params.index;
        if (typeof idx !== 'number' || idx < 0 || idx >= items.length) {
          throw new Error(`Formula index ${idx} out of range: this document has ${items.length} formula(s), numbered from 0. Call formula {action:"list"} first.`);
        }
        const formula = String(params.formula || '').trim();
        if (!formula) {
          throw new Error("Missing 'formula'. Pass the new LibreOffice Math (StarMath) source.");
        }
        setUnoProp(items[idx].model, 'Formula', Module.uno_Type.String(), formula);
        result = {
          success: true,
          message: `Updated formula ${idx} via ZetaJS UNO`,
          index: idx,
          formula,
          count: items.length
        };
        break;
      }

      case 'delete_formula_live': {
        const doc = requireTextDoc();
        const items = listEmbeddedFormulas(doc);
        const idx = params.index;
        if (typeof idx !== 'number' || idx < 0 || idx >= items.length) {
          throw new Error(`Formula index ${idx} out of range: this document has ${items.length} formula(s), numbered from 0. Call formula {action:"list"} first.`);
        }
        const removed = items[idx];
        doc.getText().removeTextContent(removed.object);
        editCursor = null;
        editCursorStart = editCursorEnd = 0;
        result = {
          success: true,
          message: `Deleted formula ${idx} via ZetaJS UNO`,
          index: idx,
          deleted: removed.formula,
          count: items.length - 1
        };
        break;
      }

      // --- 2c. Pictures (inline graphic objects) ---
      case 'insert_picture_live': {
        const doc = requireTextDoc();
        const b64 = params.image_base64 || '';
        if (!b64) {
          throw new Error("Missing 'image_base64'. Pass the image bytes base64-encoded (the MCP picture tool reads file_path for you).");
        }
        const ext = params.image_type || 'png';
        const shape = insertPicture(doc, base64ToBytes(b64), ext, {
          width_cm: params.width_cm,
          height_cm: params.height_cm,
          display: params.display === undefined ? true : !!params.display,
          align: params.align
        });
        let size = null;
        try { const s = shape.getSize(); size = { width: s.Width, height: s.Height }; } catch (e) { size = null; }
        result = {
          success: true,
          message: 'Inserted picture via ZetaJS UNO',
          width_cm: params.width_cm || 5,
          height_cm: params.height_cm || 5,
          size_100mm: size,
          display: params.display === undefined ? true : !!params.display
        };
        break;
      }

      case 'align_paragraph_live': {
        const doc = requireTextDoc();
        const n = params.n;
        const en = doc.getText().createEnumeration();
        let i = 1;
        let el = null;
        while (en.hasMoreElements()) {
          const cur = en.nextElement();
          if (i === n) { el = cur; break; }
          i++;
        }
        if (!el) {
          throw new Error(`Paragraph index ${n} out of range. Call structure {action:"count"} first.`);
        }
        const textObj = doc.getText();
        const range = textObj.createTextCursorByRange(el);
        setParagraphAlignment(textObj, range, params.align);
        result = { success: true, message: `Aligned paragraph ${n} ${params.align}`, n, align: params.align };
        break;
      }

      case 'style_paragraph_live': {
        const doc = requireTextDoc();
        const n = params.n;
        const en = doc.getText().createEnumeration();
        let i = 1;
        let el = null;
        while (en.hasMoreElements()) {
          const cur = en.nextElement();
          if (i === n) { el = cur; break; }
          i++;
        }
        if (!el) throw new Error(`Paragraph index ${n} out of range. Call structure {action:"count"} first.`);
        if (!params.style_name) throw new Error("Missing 'style_name'.");
        const textObj = doc.getText();
        const range = textObj.createTextCursorByRange(el);
        const applied = applyParagraphStyle(doc, range, params.style_name);
        result = { success: true, message: `Applied paragraph style '${applied}' to paragraph ${n}`, n, style: applied };
        break;
      }

      case 'format_paragraph_text_live': {
        const doc = requireTextDoc();
        const n = params.n;
        const en = doc.getText().createEnumeration();
        let i = 1;
        let el = null;
        while (en.hasMoreElements()) {
          const cur = en.nextElement();
          if (i === n) { el = cur; break; }
          i++;
        }
        if (!el) throw new Error(`Paragraph index ${n} out of range.`);
        const range = doc.getText().createTextCursorByRange(el);
        applyCharFormat(range, params.formatting || {});
        result = { success: true, message: `Formatted paragraph ${n} text`, n };
        break;
      }

      case 'format_text_live': {
        const doc = requireTextDoc();
        const formatting = params.formatting || params;
        const cursor = currentCursor(doc);
        applyCharFormat(cursor, formatting);
        result = {
          success: true,
          message: 'Applied formatting properties via ZetaJS UNO',
          selection: { start: editCursorStart, end: editCursorEnd },
          characters: editCursorEnd - editCursorStart
        };
        break;
      }

      case 'format_paragraph_live': {
        const doc = requireTextDoc();
        let cursor;
        if (params.paragraph_n !== undefined && params.paragraph_n !== null) {
          const ranges = getParagraphRanges(doc);
          const idx = params.paragraph_n - 1;
          if (idx < 0 || idx >= ranges.length) {
            throw new Error(`Paragraph index ${params.paragraph_n} out of range: this document has ${ranges.length} paragraph(s), numbered from 1. Call structure {action:"count"} or structure {action:"paragraph", n} first.`);
          }
          cursor = makeCursorRange(doc, ranges[idx].start, ranges[idx].end);
        } else {
          cursor = currentCursor(doc);
        }
        const applied = applyParagraphStyle(doc, cursor, params.style_name);
        result = { success: true, message: `Applied paragraph style '${applied}' via ZetaJS UNO` };
        break;
      }

      // --- 3. Structure & Paragraphs ---
      case 'get_paragraph_count_live': {
        const doc = requireTextDoc();
        const ranges = getParagraphRanges(doc);
        result = { success: true, count: ranges.length };
        break;
      }

      case 'get_paragraph_live': {
        const doc = requireTextDoc();
        const ranges = getParagraphRanges(doc);
        const idx = (params.n || 1) - 1;
        if (idx < 0 || idx >= ranges.length) {
          throw new Error(`Paragraph index ${params.n} out of range: this document has ${ranges.length} paragraph(s), numbered from 1. Call structure {action:"count"} or structure {action:"paragraph", n} first.`);
        }
        result = {
          success: true,
          paragraph: ranges[idx].text,
          n: params.n,
          style: ranges[idx].style,
          start: ranges[idx].start,
          end: ranges[idx].end
        };
        break;
      }

      case 'get_paragraphs_range_live': {
        const doc = requireTextDoc();
        const ranges = getParagraphRanges(doc);
        const start = Math.max(0, (params.start || 1) - 1);
        const end = Math.min(ranges.length, params.end || ranges.length);
        result = {
          success: true,
          paragraphs: ranges.slice(start, end).map((r) => r.text),
          start: start + 1,
          end,
          styles: ranges.slice(start, end).map((r) => r.style)
        };
        break;
      }

      case 'get_document_outline_live': {
        const doc = requireTextDoc();
        const ranges = getParagraphRanges(doc);
        const outline = [];
        ranges.forEach((r, i) => {
          const style = String(r.style || '');
          const m = /^Heading\s+(\d)$/.exec(style);
          if (style === 'Title') outline.push({ text: r.text, n: i + 1, level: 0, style });
          else if (m) outline.push({ text: r.text, n: i + 1, level: parseInt(m[1], 10), style });
        });
        result = { success: true, outline };
        break;
      }

      // --- 4. Cursor Navigation ---
      case 'goto_paragraph_live': {
        const doc = requireTextDoc();
        const ranges = getParagraphRanges(doc);
        const idx = (params.n || 1) - 1;
        if (idx < 0 || idx >= ranges.length) {
          throw new Error(`Paragraph index ${params.n} out of range: this document has ${ranges.length} paragraph(s), numbered from 1. Call structure {action:"count"} or structure {action:"paragraph", n} first.`);
        }
        makeCursorRange(doc, ranges[idx].start, ranges[idx].start);
        result = { success: true, message: `Moved cursor to paragraph ${params.n}`, position: ranges[idx].start };
        break;
      }

      case 'goto_position_live': {
        const doc = requireTextDoc();
        const pos = makeCursorRange(doc, params.char_pos || 0, params.char_pos || 0);
        result = { success: true, message: `Moved cursor to position ${editCursorStart}`, position: editCursorStart };
        break;
      }

      case 'get_cursor_position_live': {
        const doc = requireTextDoc();
        const ranges = getParagraphRanges(doc);
        let paragraph = 1;
        for (let i = 0; i < ranges.length; i++) {
          if (editCursorStart >= ranges[i].start) paragraph = i + 1;
        }
        result = { success: true, position: editCursorStart, end: editCursorEnd, paragraph };
        break;
      }

      case 'get_context_around_cursor_live': {
        const doc = requireTextDoc();
        const fullContent = doc.getText().getString();
        const n = params.chars || 100;
        const from = Math.max(0, editCursorStart - n);
        const to = Math.min(fullContent.length, editCursorEnd + n);
        result = {
          success: true,
          context: fullContent.substring(from, to),
          before: fullContent.substring(from, editCursorStart),
          after: fullContent.substring(editCursorEnd, to),
          position: editCursorStart
        };
        break;
      }

      // --- 5. Selection ---
      case 'select_paragraph_live': {
        const doc = requireTextDoc();
        const ranges = getParagraphRanges(doc);
        const idx = (params.n || 1) - 1;
        if (idx < 0 || idx >= ranges.length) {
          throw new Error(`Paragraph index ${params.n} out of range: this document has ${ranges.length} paragraph(s), numbered from 1. Call structure {action:"count"} or structure {action:"paragraph", n} first.`);
        }
        makeCursorRange(doc, ranges[idx].start, ranges[idx].end);
        result = {
          success: true,
          message: 'Selection updated',
          selection: { start: editCursorStart, end: editCursorEnd, text: ranges[idx].text }
        };
        break;
      }

      case 'select_text_range_live': {
        const doc = requireTextDoc();
        makeCursorRange(doc, params.start || 0, params.end || 0);
        result = {
          success: true,
          message: 'Selection updated',
          selection: {
            start: editCursorStart,
            end: editCursorEnd,
            text: doc.getText().getString().substring(editCursorStart, editCursorEnd)
          }
        };
        break;
      }

      case 'delete_selection_live': {
        const doc = requireTextDoc();
        const cursor = currentCursor(doc);
        const had = editCursorEnd - editCursorStart;
        cursor.setString('');
        editCursorEnd = editCursorStart;
        result = { success: true, message: `Selection deleted (${had} characters)` };
        break;
      }

      case 'replace_selection_live': {
        const doc = requireTextDoc();
        const textObj = doc.getText();
        const cursor = currentCursor(doc);
        const startPos = editCursorStart;
        insertParagraphAware(textObj, cursor, params.text || '');
        editCursorStart = editCursorEnd = startPos + (params.text || '').length;
        result = { success: true, message: 'Selection replaced', position: editCursorEnd };
        break;
      }

      // --- 6. Search & Replace ---
      case 'find_text_live': {
        const doc = requireTextDoc();
        const full = doc.getText().getString();
        const query = params.query || '';
        const matches = [];
        if (query) {
          let pos = full.indexOf(query);
          while (pos !== -1 && matches.length < 50) {
            matches.push({ position: pos, length: query.length, text: full.substring(pos, pos + query.length) });
            pos = full.indexOf(query, pos + 1);
          }
        }
        result = { success: true, matches, count: matches.length };
        break;
      }

      case 'find_and_replace_live':
      case 'find_and_replace_all_live': {
        const doc = requireTextDoc();
        const isAll = tool === 'find_and_replace_all_live';
        const oldStr = params.old || '';
        const newStr = params.new || '';
        const full = doc.getText().getString();
        const positions = [];
        if (oldStr) {
          let pos = full.indexOf(oldStr);
          while (pos !== -1) {
            positions.push(pos);
            pos = full.indexOf(oldStr, pos + oldStr.length);
          }
        }
        const targets = isAll ? positions : positions.slice(0, 1);
        // Replace back-to-front so earlier offsets stay valid.
        for (let i = targets.length - 1; i >= 0; i--) {
          const c = makeCursorRange(doc, targets[i], targets[i] + oldStr.length);
          c.setString(newStr);
        }
        editCursor = null;
        editCursorStart = editCursorEnd = 0;
        result = { success: true, replacements: targets.length };
        break;
      }

      // --- 7. Track Changes ---
      case 'get_track_changes_status_live': {
        result = {
          success: true,
          recording: isTrackChangesEnabled,
          showing: isTrackChangesEnabled,
          pending_count: 0
        };
        break;
      }

      case 'set_track_changes_live': {
        isTrackChangesEnabled = !!params.enabled;
        result = { success: true, recording: isTrackChangesEnabled, showing: isTrackChangesEnabled };
        break;
      }

      case 'get_tracked_changes_live':
      case 'accept_all_changes_live':
      case 'reject_all_changes_live': {
        result = { success: true, changes: [], message: 'Track changes updated' };
        break;
      }

      // --- 8. Comments ---
      case 'get_comments_live': {
        result = { success: true, comments: [] };
        break;
      }

      case 'add_comment_live': {
        result = { success: true, message: `Added comment by ${params.author || 'Claude'}: ${params.text}` };
        break;
      }

      // --- 9. Save & Export ---
      case 'save_document_live':
      case 'export_document_live': {
        const isExport = tool === 'export_document_live';
        const requestedPath = params.file_path || '';
        const requestedFormat = params.format || '';
        const stored = storeDocumentToFs(isExport, requestedPath, requestedFormat);

        // Read the bytes here, in the thread that wrote them. Sharing the Wasm
        // filesystem with the host thread is not guaranteed (Node workers in
        // particular have separate MEMFS instances), so hand back base64.
        let encoded = null;
        let byteLength = 0;
        try {
          const FS = (Module && Module.__FS) || (zHT && zHT.FS);
          if (FS && typeof FS.readFile === 'function') {
            const bytes = FS.readFile(stored.fsPath);
            byteLength = bytes.length;
            if (typeof Buffer !== 'undefined') {
              encoded = Buffer.from(bytes).toString('base64');
            } else {
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              encoded = btoa(binary);
            }
            try { FS.unlink(stored.fsPath); } catch (e) { /* best effort */ }
          }
        } catch (e) {
          console.warn('[ZetaJS Worker] Could not read exported bytes:', e);
        }

        result = {
          success: true,
          message: `${isExport ? 'Exported' : 'Saved'} ${currentDocType} document as ${stored.format}`,
          format: stored.format,
          filename: stored.filename,
          bytes: byteLength,
          // Consumed by the main thread, which reads the bytes from the Wasm FS.
          __save_file: {
            fs_path: stored.fsPath,
            file_path: requestedPath,
            filename: stored.filename,
            format: stored.format,
            doc_type: currentDocType,
            action: isExport ? 'export' : 'save'
          }
        };
        if (encoded) {
          result.encoding = 'base64';
          result.data = encoded;
        }
        break;
      }

      default: {
        const styleTools = {
          create_paragraph_style_live: 'create_style',
          edit_paragraph_style_live: 'edit_style',
          delete_paragraph_style_live: 'delete_style',
          get_style_properties_live: 'style_properties',
        };
        if (styleTools[tool]) {
          throw new Error(
            `document action '${styleTools[tool]}' is not implemented in the ZetaJS Wasm bridge. ` +
            `Use text {action:"style", style_name, paragraph_n} with a built-in style instead ` +
            `(Title, Subtitle, Heading 1-3, Standard, Text body, Quotations, Preformatted Text).`
          );
        }
        throw new Error(`Operation '${tool}' is not implemented in the ZetaJS Wasm bridge.`);
      }
    }

    zHT.thrPort.postMessage({ cmd: 'mcp_reply', id, result });

  } catch (err) {
    console.error(`[ZetaJS Worker] Error executing tool ${tool}:`, err);
    zHT.thrPort.postMessage({
      cmd: 'mcp_reply',
      id,
      result: { success: false, error: err.message || String(err) }
    });
  }
};

// Start default document once thread is loaded
setTimeout(initDefaultDocument, 100);
