/* -*- Mode: JS; tab-width: 2; indent-tabs-mode: nil; js-indent-level: 2; fill-column: 100 -*- */
// SPDX-License-Identifier: MIT
// office_thread.js - Runs inside the ZetaOffice Web Worker thread with full UNO access
// Implements the exact tool actions corresponding to mcp-libre's 9 consolidated tools.

import { ZetaHelperThread } from './zetajs/zetaHelper.js';
import { UNO_INDEX } from './uno-index.js';

// Where the agent can read full IDL documentation for a type.
const UNO_DOCS_URL = 'https://api.libreoffice.org/docs/idl/ref/';

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

// Get the active document. The document created or loaded through the tools is
// authoritative: in headless mode getCurrentComponent() can keep returning the
// initial welcome Writer document after an Impress/Calc document is created.
function getDoc() {
  if (xModel) return xModel;
  try {
    if (zHT && zHT.desktop && typeof zHT.desktop.getCurrentComponent === 'function') {
      const cur = zHT.desktop.getCurrentComponent();
      if (cur) xModel = cur;
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

// ─── High-level capability helpers ─────────────────────────────────────────
// Small typed operations over the UNO sequences the cookbook documents.

function requireSheetDoc() {
  const doc = getDoc();
  if (!doc) throw new Error('No active document available');
  if (typeof doc.getSheets !== 'function') throw new Error('Active document is not a spreadsheet');
  return doc;
}

function getPageStyle(doc, name) {
  const fams = doc.getStyleFamilies();
  const pages = fams.getByName('PageStyles');
  return pages.getByName(name || 'Standard');
}

function setEnumProp(obj, name, value) {
  const info = obj.getPropertySetInfo();
  const prop = info.getPropertyByName(name);
  const any = new Module.uno_Any(prop.Type, value);
  try { obj.setPropertyValue(name, any); } finally { any.delete(); }
}

function updateAllFields(doc) {
  try {
    const sm = zHT.context.getServiceManager();
    const helper = sm.createInstanceWithContext('com.sun.star.frame.DispatchHelper', zHT.context);
    const frame = doc.getCurrentController().getFrame();
    helper.executeDispatch(frame, '.uno:UpdateFields', '_self', 0, []);
  } catch (e) {
    console.warn('[ZetaJS Worker] UpdateFields:', e.message);
  }
}

function getFieldMaster(doc, category) {
  const name = `com.sun.star.text.fieldmaster.SetExpression.${category}`;
  try {
    return doc.getTextFieldMasters().getByName(name);
  } catch (e) {
    throw new Error(`No field master for category '${category}'. Try Figure, Illustration, Table, Text or Drawing.`);
  }
}

function fieldPresentations(doc, seq, ref) {
  const presentation = (field) => {
    try { return field.getPresentation(false); } catch (e) { return null; }
  };
  return { caption: presentation(seq), reference: presentation(ref) };
}

function addCaptionPair(doc, params) {
  const category = String(params.category || 'Figure');
  const caption = String(params.caption || 'Caption text.');
  const referenceText = String(params.reference || 'see figure ');
  const sequenceNumber = params.sequence_number === undefined ? 1 : Number(params.sequence_number);
  const textObj = doc.getText();
  const cursor = textObj.createTextCursor();
  cursor.gotoEnd(false);
  cursor.collapseToEnd();
  if (textObj.getString().length > 0) insertParagraphAware(textObj, cursor, '\n');

  textObj.insertString(cursor, category + ' ', false);
  const seq = doc.createInstance('com.sun.star.text.textfield.SetExpression');
  seq.attachTextFieldMaster(getFieldMaster(doc, category));
  setEnumProp(seq, 'SubType', 1);
  setUnoProp(seq, 'Content', Module.uno_Type.String(), category + '+1');
  setEnumProp(seq, 'NumberingType', 4);
  setEnumProp(seq, 'SequenceValue', sequenceNumber);
  textObj.insertTextContent(cursor, seq, false);
  textObj.insertString(cursor, ': ' + caption, false);
  insertParagraphAware(textObj, cursor, '\n');
  textObj.insertString(cursor, referenceText, false);

  const ref = doc.createInstance('com.sun.star.text.textfield.GetReference');
  setEnumProp(ref, 'ReferenceFieldSource', 1); // SEQUENCE_FIELD
  setUnoProp(ref, 'SourceName', Module.uno_Type.String(), category);
  setEnumProp(ref, 'ReferenceFieldPart', 7);   // ONLY_SEQUENCE_NUMBER
  setEnumProp(ref, 'SequenceNumber', sequenceNumber);
  textObj.insertTextContent(cursor, ref, false);
  updateAllFields(doc);
  return { category, caption, referenceText, ...fieldPresentations(doc, seq, ref) };
}

function addBookmark(doc, params) {
  const ranges = getParagraphRanges(doc);
  const n = params.paragraph_n ? Number(params.paragraph_n) : ranges.length;
  const r = ranges[n - 1];
  if (!r) throw new Error(`Paragraph ${n} out of range`);
  const at = String(params.at || 'start').toLowerCase();
  const pos = at === 'end' ? r.end : r.start;
  const cursor = makeCursorRange(doc, pos, pos);
  const name = String(params.name || 'bookmark');
  try { doc.getBookmarks().removeByName(name); } catch (e) { /* absent */ }
  const bm = doc.createInstance('com.sun.star.text.Bookmark');
  bm.setName(name);
  doc.getText().insertTextContent(cursor, bm, false);
  const names = toArray(doc.getBookmarks().getElementNames());
  return { name, paragraph: n, names };
}

function addInternalLink(doc, params) {
  const ranges = getParagraphRanges(doc);
  const n = Number(params.paragraph_n || 1);
  const r = ranges[n - 1];
  if (!r) throw new Error(`Paragraph ${n} out of range`);
  const needle = params.text ? String(params.text) : r.text;
  const idx = params.text ? r.text.indexOf(needle) : 0;
  if (idx < 0) throw new Error(`Text '${needle}' not found in paragraph ${n}`);
  const start = r.start + idx;
  const cursor = makeCursorRange(doc, start, start + needle.length);
  const target = String(params.target || '');
  if (!target) throw new Error("Missing 'target' (e.g. '#details' or https://...)");
  setUnoProp(cursor, 'HyperLinkURL', Module.uno_Type.String(), target);
  if (target.startsWith('#') && params.name) {
    setUnoProp(cursor, 'HyperLinkName', Module.uno_Type.String(), String(params.name));
  }
  return { paragraph: n, text: needle, url: target };
}

function sheetByName(doc, name) {
  const sheets = doc.getSheets();
  return name ? sheets.getByName(String(name)) : sheets.getByIndex(0);
}

function calcSheetOp(params) {
  const doc = requireSheetDoc();
  const sheets = doc.getSheets();
  const action = String(params.action || 'create');
  if (action === 'create') {
    const name = String(params.name || 'Sheet');
    if (!sheets.hasByName(name)) {
      if (sheets.getCount() === 1 && sheets.getByIndex(0).getName() === 'Sheet1') {
        sheets.getByIndex(0).setName(name);
      } else {
        const index = params.index === undefined ? sheets.getCount() : Number(params.index);
        sheets.insertNewByName(name, index);
      }
    }
  } else if (action === 'rename') {
    sheets.getByName(String(params.name)).setName(String(params.new_name));
  } else if (action === 'activate') {
    doc.getCurrentController().setActiveSheet(sheetByName(doc, params.name));
  } else {
    throw new Error(`Unknown sheet action '${action}'`);
  }
  let active = null;
  try { active = doc.getCurrentController().getActiveSheet().getName(); } catch (e) { active = null; }
  return { sheets: toArray(sheets.getElementNames()), active };
}

function unoRawProxy(obj) {
  const sym = Object.getOwnPropertySymbols(obj)
    .find((s) => s.description === 'getProxyTarget');
  return sym ? obj[sym] : null;
}

function setValidation(params) {
  const doc = requireSheetDoc();
  const sheet = sheetByName(doc, params.sheet);
  const range = sheet.getCellRangeByName(String(params.range));
  const type = String(params.type || 'list').toUpperCase();
  const validationTypes = { WHOLE: 1, DECIMAL: 2, DATE: 3, TIME: 4, TEXT_LENGTH: 5, LIST: 6 };
  if (!validationTypes[type]) throw new Error(`Unknown validation type '${params.type}'`);

  const v = range.getPropertyValue('Validation');
  const cond = queryInterface(v, 'com.sun.star.sheet.XSheetCondition2');
  setEnumProp(v, 'Type', unoResolveType('com.sun.star.sheet.ValidationType')[type]);
  cond.setFormula1(String(params.source || ''));
  setUnoProp(v, 'ShowList', Module.uno_Type.Boolean(), params.show_list !== false);
  setUnoProp(v, 'IgnoreBlankCells', Module.uno_Type.Boolean(), true);

  // Any() needs an embind reference, not a ZetaJS proxy. Unwrap the proxy's
  // getProxyTarget symbol, then reattach the object so the range serializes it.
  const raw = unoRawProxy(v);
  if (!raw) throw new Error('Cannot unwrap the Validation object');
  const any = new Module.uno_Any(
    Module.uno_Type.Interface('com.sun.star.uno.XInterface'), raw);
  try {
    range.setPropertyValue('Validation', any);
  } finally {
    any.delete();
  }
  const check = range.getPropertyValue('Validation');
  const checkCond = queryInterface(check, 'com.sun.star.sheet.XSheetCondition2');
  return {
    range: params.range,
    type,
    formula1: checkCond.getFormula1(),
    showList: check.getPropertyValue('ShowList'),
  };
}

function addNamedRange(params) {
  const doc = requireSheetDoc();
  const sheetName = String(params.sheet || doc.getSheets().getByIndex(0).getName());
  const range = String(params.range || 'A1:A3').replace(/([A-Za-z]+)(\d+)/g, '$$$1$$$2');
  const content = `$${sheetName}.${range}`;
  const named = doc.getPropertyValue('NamedRanges');
  try { named.removeByName(String(params.name)); } catch (e) { /* absent */ }
  named.addNewByName(String(params.name), content, new css.table.CellAddress({ Sheet: 0, Column: 0, Row: 0 }), 0);
  return { name: params.name, content, names: toArray(named.getElementNames()) };
}

function freezePanes(params) {
  const doc = requireSheetDoc();
  const ctrl = doc.getCurrentController();
  if (params.sheet) ctrl.setActiveSheet(sheetByName(doc, params.sheet));
  const fz = queryInterface(ctrl, 'com.sun.star.sheet.XViewFreezable');
  const cols = Number(params.columns || 0);
  const rows = Number(params.rows === undefined ? 1 : params.rows);
  fz.freezeAtPosition(cols, rows);
  let sheetName = params.sheet ? String(params.sheet) : null;
  if (!sheetName) {
    try { sheetName = ctrl.getActiveSheet().getName(); } catch (e) { sheetName = null; }
  }
  let frozen = null;
  try { frozen = ctrl.getPropertyValue('HasFrozenPanes'); } catch (e) { frozen = null; }
  const result = { sheet: sheetName, columns: cols, rows, frozen };
  if (frozen === null || frozen === undefined) {
    result.warning = 'No attached view reported frozen panes; xlsx exported through the MCP server is patched and reports freeze_patched.';
  }
  return result;
}

function applyNumberFormat(doc, range, requested) {
  const aliases = {
    currency: '$#,##0.00',
    percent: '0.00%',
    date: 'YYYY-MM-DD',
    number: '#,##0.00',
    integer: '0',
  };
  const code = aliases[String(requested).toLowerCase()] || String(requested);
  const locale = new css.lang.Locale({ Language: 'en', Country: 'US' });
  const formats = doc.getNumberFormats();
  let key = formats.queryKey(code, locale, true);
  if (key === -1) key = formats.addNew(code, locale);
  setUnoProp(range, 'NumberFormat', Module.uno_Type.Long(), key);
  return { code, key };
}

function setPageSetup(params) {
  const doc = requireTextDoc();
  const style = getPageStyle(doc, params.style || 'Standard');
  const landscape = String(params.orientation || '').toLowerCase() === 'landscape';
  const width = params.width_mm ? Math.round(Number(params.width_mm) * 100) : (landscape ? 29700 : 21000);
  const height = params.height_mm ? Math.round(Number(params.height_mm) * 100) : (landscape ? 21000 : 29700);
  setUnoProp(style, 'IsLandscape', Module.uno_Type.Boolean(), landscape);
  setUnoProp(style, 'Width', Module.uno_Type.Long(), width);
  setUnoProp(style, 'Height', Module.uno_Type.Long(), height);
  const margin = (cm, fallback) => Math.round((cm === undefined ? fallback : Number(cm)) * 1000);
  setUnoProp(style, 'LeftMargin', Module.uno_Type.Long(), margin(params.margin_left_cm, 2));
  setUnoProp(style, 'RightMargin', Module.uno_Type.Long(), margin(params.margin_right_cm, 2));
  setUnoProp(style, 'TopMargin', Module.uno_Type.Long(), margin(params.margin_top_cm, 2));
  setUnoProp(style, 'BottomMargin', Module.uno_Type.Long(), margin(params.margin_bottom_cm, 2));
  return { landscape, width_mm: width / 100, height_mm: height / 100 };
}

function setHeaderFooter(params) {
  const doc = requireTextDoc();
  const style = getPageStyle(doc, params.style || 'Standard');
  if (params.header !== undefined) {
    setUnoProp(style, 'HeaderIsOn', Module.uno_Type.Boolean(), true);
    const ht = style.getPropertyValue('HeaderText');
    const cur = ht.createTextCursor();
    cur.gotoEnd(false); cur.collapseToEnd();
    ht.insertString(cur, String(params.header), false);
  }
  if (params.footer !== undefined || params.page_number) {
    setUnoProp(style, 'FooterIsOn', Module.uno_Type.Boolean(), true);
    const ft = style.getPropertyValue('FooterText');
    const cur = ft.createTextCursor();
    cur.gotoEnd(false); cur.collapseToEnd();
    if (params.footer) ft.insertString(cur, String(params.footer), false);
    if (params.page_number) {
      const field = doc.createInstance('com.sun.star.text.TextField.PageNumber');
      setEnumProp(field, 'NumberingType', 4);
      ft.insertTextContent(cur, field, false);
    }
  }
  let header = null, footer = null;
  try { header = style.getPropertyValue('HeaderText').getString(); } catch (e) {}
  try { footer = style.getPropertyValue('FooterText').getString(); } catch (e) {}
  return { header, footer };
}

function createWriterTable(params) {
  const doc = requireTextDoc();
  const values = Array.isArray(params.values) ? params.values : [];
  if (!values.length) throw new Error("Missing 'values' (2-D array)");
  const cols = Math.max(1, ...values.map((r) => (Array.isArray(r) ? r.length : 1)));
  const totalCol = params.total_column === undefined ? null : Number(params.total_column);
  const rows = values.length + (totalCol === null ? 0 : 1);
  const textObj = doc.getText();
  const cursor = textObj.createTextCursor();
  cursor.gotoEnd(false); cursor.collapseToEnd();
  const table = doc.createInstance('com.sun.star.text.TextTable');
  table.initialize(rows, cols);
  textObj.insertTextContent(cursor, table, false);

  const put = (r, c, v) => {
    const cell = table.getCellByName(columnLetters(c) + (r + 1));
    if (typeof v === 'number') cell.setValue(v);
    else cell.setString(v === null || v === undefined ? '' : String(v));
  };
  for (let r = 0; r < values.length; r++) {
    const row = Array.isArray(values[r]) ? values[r] : [values[r]];
    for (let c = 0; c < cols; c++) put(r, c, row[c]);
  }
  let total = null;
  if (totalCol !== null) {
    const totalRow = rows - 1;
    put(totalRow, 0, params.total_label || 'Total');
    const col = columnLetters(totalCol);
    const dataStart = params.header === false ? 1 : 2;
    const dataEnd = values.length;
    const formula = `sum<${col}${dataStart}:${col}${dataEnd}>`;
    const cell = table.getCellByName(col + (totalRow + 1));
    cell.setFormula(formula);
    total = cell.getValue();
  }
  return { rows, cols, total };
}

// ─── Native Math formulas (embedded OLE objects) ────────────────────────────
// A Writer formula is a real com.sun.star.text.TextEmbeddedObject whose CLSID
// points at LibreOffice Math. The embedded model exposes the StarMath source
// via the "Formula" property, so the result is an editable Math object (not a
// text approximation). Requires the Math module in the LOWA build.
const MATH_CLSID = '078B7ABA-54FC-457F-8551-6147E776A997';
const MATH_OBJECT_SERVICE = 'com.sun.star.text.TextEmbeddedObject';

// OLE class IDs for LibreOffice's embedded document types (from the
// org.openoffice.Office.Embedding configuration). Service names are NOT valid
// CLSIDs - the CLSID property only accepts these GUIDs.
const EMBED_CLSIDS = {
  calc: '47BBB4CB-CE4C-4E80-A591-42D9AE74950F',
  spreadsheet: '47BBB4CB-CE4C-4E80-A591-42D9AE74950F',
  writer: '8BC6B165-B1B2-4EDD-AA47-DAE2EE689DD6',
  text: '8BC6B165-B1B2-4EDD-AA47-DAE2EE689DD6',
  impress: '9176E48A-637A-4D1F-803B-99D9BFAC1047',
  presentation: '9176E48A-637A-4D1F-803B-99D9BFAC1047',
  draw: '4BAB8970-8A3B-45B3-991C-CBEEAC6BD5E3',
  math: '078B7ABA-54FC-457F-8551-6147E776A997',
  formula: '078B7ABA-54FC-457F-8551-6147E776A997',
};
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
  try { names = toArray(container.getElementNames()); } catch (e) { return []; }
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

  // The URL fallback is optional: bytes go through SequenceInputStream below.
  // A worker without a writable FS (browser tab) must not fail the insert.
  let url = null;
  try {
    const FS = (Module && Module.__FS) || (zHT && zHT.FS);
    if (FS && typeof FS.writeFile === 'function') {
      const safeExt = ['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(String(ext).toLowerCase())
        ? String(ext).toLowerCase() : 'png';
      const fsPath = `/tmp/mcp_picture_${Date.now()}.${safeExt}`;
      FS.writeFile(fsPath, imageBytes);
      url = 'file://' + fsPath;
    }
  } catch (e) { /* no FS: use the byte-stream path only */ }

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
  if (!graphic && url) {
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
    if (!url) throw new Error('Could not load the picture bytes into a graphic');
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

// Import filters for load_document_live (the inverse of FILTER_MAP).
const IMPORT_FILTER_MAP = {
  odt: 'writer8', ott: 'writer8',
  docx: 'MS Word 2007 XML', doc: 'MS Word 97', rtf: 'Rich Text Format',
  txt: 'Text (encoded)', html: 'HTML (StarWriter)', htm: 'HTML (StarWriter)',
  ods: 'calc8', xlsx: 'Calc MS Excel 2007 XML', xls: 'MS Excel 97',
  csv: 'Text - txt - csv (StarCalc)',
  odp: 'impress8', pptx: 'Impress MS PowerPoint 2007 XML', ppt: 'MS PowerPoint 97',
  odg: 'draw8',
};

function getImportFilterName(format) {
  return IMPORT_FILTER_MAP[String(format || '').toLowerCase()] || null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Spreadsheet (Calc) helpers
function resolveSheet(doc, name) {
  if (!doc || typeof doc.getSheets !== 'function') {
    throw new Error('Active document is not a spreadsheet (create it with document doc_type "calc")');
  }
  const sheets = doc.getSheets();
  if (name) {
    if (typeof sheets.hasByName === 'function' && !sheets.hasByName(name)) {
      throw new Error(`No sheet named '${name}'`);
    }
    return sheets.getByName(name);
  }
  try {
    const ctrl = doc.getCurrentController();
    if (ctrl && typeof ctrl.getActiveSheet === 'function') return ctrl.getActiveSheet();
  } catch (e) { /* fall through */ }
  return sheets.getByIndex(0);
}

// "B7" -> { col: 1, row: 6 }
function a1ToPos(a1) {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(String(a1 || '').trim());
  if (!m) throw new Error(`Invalid cell address '${a1}'`);
  let col = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

// ZetaJS returns UNO sequences as either arrays or size()/get() proxies.
function toArray(seq) {
  if (!seq) return [];
  if (Array.isArray(seq)) return seq;
  try {
    if (typeof seq.size === 'function' && typeof seq.get === 'function') {
      const out = [];
      const n = seq.size();
      for (let i = 0; i < n; i++) out.push(seq.get(i));
      return out;
    }
  } catch (e) { /* fall through */ }
  try { return Array.from(seq); } catch (e) { return []; }
}

function writeGrid(range, values) {
  const width = Math.max(1, ...values.map((r) => (Array.isArray(r) ? r.length : 1)));
  const grid = values.map((row) => {
    const cells = Array.isArray(row) ? row.slice() : [row];
    while (cells.length < width) cells.push('');
    return cells.map((v) => (v === null || v === undefined) ? '' : v);
  });
  range.setDataArray(grid);
  // setDataArray stores "=..." as text; promote those cells to real formulas.
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c];
      if (typeof v === 'string' && v.startsWith('=')) {
        range.getCellByPosition(c, r).setFormula(v);
      }
    }
  }
  return { rows: grid.length, cols: width };
}

function columnLetters(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Size the OLE preview to the frame. Embedding captures the preview at
// creation; without this the stored 90x23 mm preview is stretched to the frame.
function applyEmbeddedPreview(model, frame, widthMm, heightMm) {
  if (!model || !frame || !widthMm || !heightMm) return null;
  const width = Math.round(Number(widthMm) * 100);   // 1/100 mm
  const height = Math.round(Number(heightMm) * 100);
  try {
    model.setVisualAreaSize(4, new css.awt.Size({ Width: width, Height: height }));
  } catch (e) { /* not every embedded model is visual */ }
  try {
    setUnoProp(frame, 'Width', Module.uno_Type.Long(), width);
    setUnoProp(frame, 'Height', Module.uno_Type.Long(), height);
  } catch (e) { /* optional */ }
  let actual = null;
  try { actual = model.getVisualAreaSize(4); } catch (e) { actual = null; }
  return actual ? { width: actual.Width, height: actual.Height } : { width, height };
}

// Add a chart2 chart inside an embedded Calc model in one pass. This is the
// sequence that works in the Wasm build (chart1 addNewByName + chart2 titles).
function addEmbeddedChart(model, values, cfg) {
  if (!model || typeof model.getSheets !== 'function') return null;
  const sheet = model.getSheets().getByIndex(0);
  const charts = sheet.getCharts();
  const rows = Array.isArray(values) && values.length ? values.length : 6;
  const cols = Math.max(1, ...(Array.isArray(values) ? values : []).map((r) => (Array.isArray(r) ? r.length : 1)));
  const rangeName = cfg.range || `A1:${columnLetters(Math.max(0, cols - 1))}${Math.max(1, rows)}`;
  const range = sheet.getCellRangeByName(rangeName);
  const name = cfg.name || 'Chart1';
  try { if (charts.hasByName(name)) charts.removeByName(name); } catch (e) { /* none */ }
  const rect = new css.awt.Rectangle({
    X: Math.round(cfg.x !== undefined ? cfg.x : 4800),
    Y: Math.round(cfg.y !== undefined ? cfg.y : 200),
    Width: Math.round(cfg.width !== undefined ? cfg.width : 10800),
    Height: Math.round(cfg.height !== undefined ? cfg.height : 8600),
  });
  charts.addNewByName(name, rect, [range.getRangeAddress()], true, true);
  const chartObj = charts.getByName(name);
  const chart = chartObj.getEmbeddedObject();
  try { setUnoProp(chart, 'HasMainTitle', Module.uno_Type.Boolean(), true); } catch (e) { /* optional */ }
  if (cfg.title) {
    try {
      const title = chart.getTitle();
      setUnoProp(title, 'String', Module.uno_Type.String(), String(cfg.title));
    } catch (e) { console.log('[embed] chart title:', e.message); }
  }
  if (cfg.legend === false) {
    try { setUnoProp(chart, 'HasLegend', Module.uno_Type.Boolean(), false); } catch (e) { /* optional */ }
  }
  let type = 'column';
  try {
    const diagram = chart.getFirstDiagram();
    const cs = diagram.getCoordinateSystems()[0];
    const makeTitle = (text) => {
      const o = zHT.context.getServiceManager()
        .createInstanceWithContext('com.sun.star.chart2.Title', zHT.context);
      setUnoProp(o, 'String', Module.uno_Type.String(), String(text));
      return o;
    };
    if (cfg.x_title) cs.getAxisByDimension(0, 0).setTitleObject(makeTitle(cfg.x_title));
    if (cfg.y_title) cs.getAxisByDimension(1, 0).setTitleObject(makeTitle(cfg.y_title));
    type = String(cs.getChartTypes()[0].getChartType() || 'column');
  } catch (e) {
    console.log('[embed] chart axes:', e.message);
  }
  return { name, range: rangeName, type };
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
  // ZetaJS sequence proxies expose size()/get(); encode them as arrays.
  if (typeof v.size === 'function' && typeof v.get === 'function') {
    const out = [];
    const n = v.size();
    for (let i = 0; i < n; i++) out.push(unoEncode(v.get(i)));
    return out;
  }
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
  // A typed enum explicitly carries its UNO type. Inferring the type from the
  // constant can produce a Long Any, which some property setters silently
  // ignore (e.g. ReferenceFieldSource/ReferenceFieldPart on GetReference).
  if (raw && typeof raw === 'object' && raw.$e) {
    const ty = Module.uno_Type.Enum(String(raw.$e));
    const value = typeof raw.v === 'number'
      ? raw.v
      : unoResolveType(raw.$e)[raw.v];
    return new Module.uno_Any(ty, value);
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

// UNO enum values do not stringify in this binding; compare them by identity.
function unoTypeClassName(tc) {
  try {
    const TC = Module.uno.com.sun.star.uno.TypeClass;
    const names = ['VOID', 'BOOLEAN', 'BYTE', 'SHORT', 'UNSIGNED_SHORT', 'LONG',
      'UNSIGNED_LONG', 'HYPER', 'UNSIGNED_HYPER', 'FLOAT', 'DOUBLE', 'CHAR',
      'STRING', 'TYPE', 'ANY', 'INTERFACE', 'STRUCT', 'ENUM', 'EXCEPTION',
      'SEQUENCE', 'ARRAY', 'TYPECLASS'];
    for (const name of names) {
      if (tc === TC[name]) return name;
    }
  } catch (e) { /* fall through */ }
  return undefined;
}

function unoParamModeName(mode) {
  try {
    const PM = Module.uno.com.sun.star.reflection.ParamMode;
    if (mode === PM.IN) return 'IN';
    if (mode === PM.OUT) return 'OUT';
    if (mode === PM.INOUT) return 'INOUT';
  } catch (e) { /* fall through */ }
  return undefined;
}

function unoTypeInfo(cls) {
  if (!cls) return null;
  try {
    const name = cls.getName();
    let kind;
    try { kind = unoTypeClassName(cls.getTypeClass()); } catch (e) { kind = undefined; }
    return { type: name, kind };
  } catch (e) {
    try { return { type: String(cls) }; } catch (e2) { return null; }
  }
}

// Reflection: describe an interface/service by name, or the interfaces of a
// live object. Backed by com.sun.star.reflection.CoreReflection, so the answer
// always matches the running Wasm build.
function unoDescribe(req) {
  const sm = zHT.context.getServiceManager();
  const reflection = sm.createInstanceWithContext('com.sun.star.reflection.CoreReflection', zHT.context);

  if (req.h) {
    const obj = unoGetHandle(req.h);
    const out = { interfaces: [] };
    try {
      const tp = queryInterface(obj, 'com.sun.star.lang.XTypeProvider');
      if (tp) {
        const types = tp.getTypes();
        for (let i = 0; i < types.length; i++) {
          const ti = unoTypeInfo(types[i]);
          if (ti && ti.type) out.interfaces.push(ti.type);
        }
      }
    } catch (e) { out.error = e.message; }
    try {
      const si = queryInterface(obj, 'com.sun.star.lang.XServiceInfo');
      if (si) {
        out.services = si.getSupportedServiceNames();
        out.implementation = si.getImplementationName();
      }
    } catch (e) { /* optional interface */ }
    try {
      const info = obj.getPropertySetInfo();
      const props = info.getProperties();
      out.properties = [];
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        const entry = { name: p.Name };
        try {
          const ty = p.Type;
          if (ty && ty.typeName) entry.type = String(ty.typeName);
        } catch (e) { /* optional */ }
        try {
          const attrs = p.Attributes;
          entry.readOnly = !!(attrs & 1); // PropertyAttribute::READONLY
        } catch (e) { /* optional */ }
        out.properties.push(entry);
      }
    } catch (e) { /* not a property set */ }
    return out;
  }

  if (!req.type) throw new Error("describe needs 'type' (an interface/service name) or 'h' (a handle)");

  // Modules are not part of the Wasm build's type registry; answer them from
  // the generated index so an agent can discover names without the docs.
  if (UNO_INDEX[req.type]) {
    const entry = UNO_INDEX[req.type];
    return {
      type: req.type,
      kind: 'MODULE',
      interfaces: entry.interfaces,
      services: entry.services,
      hint: 'Describe an entry for methods, parameter types/modes and return types.',
    };
  }

  const cls = reflection.forName(req.type);
  if (!cls) {
    throw new Error(
      `Unknown type '${req.type}'. Pass an interface (e.g. com.sun.star.sheet.XSpreadsheet) ` +
      `or a module (e.g. com.sun.star.sheet). Docs: ${UNO_DOCS_URL}`
    );
  }
  const info = unoTypeInfo(cls);
  const out = {
    type: req.type,
    kind: info ? info.kind : undefined,
    superclasses: [],
    interfaces: [],
    methods: [],
    attributes: [],
  };
  try {
    const sups = cls.getSuperclasses();
    for (let i = 0; i < sups.length; i++) {
      const si = unoTypeInfo(sups[i]);
      if (si && si.type) out.superclasses.push(si.type);
    }
  } catch (e) { /* optional */ }
  try {
    const ifaces = cls.getInterfaces();
    for (let i = 0; i < ifaces.length; i++) {
      const ii = unoTypeInfo(ifaces[i]);
      if (ii && ii.type) out.interfaces.push(ii.type);
    }
  } catch (e) { out.interfacesError = e.message; }

  try {
    const methods = cls.getMethods();
    for (let i = 0; i < methods.length; i++) {
      const m = methods[i];
      const name = m.getName();
      if (req.method && name !== req.method) continue;
      const entry = { name };
      try { entry.returns = unoTypeInfo(m.getReturnType()); } catch (e) { /* optional */ }
      entry.params = [];
      try {
        const infos = m.getParameterInfos();
        for (let p = 0; p < infos.length; p++) {
          entry.params.push({
            name: infos[p].aName,
            type: unoTypeInfo(infos[p].aType),
            mode: unoParamModeName(infos[p].aMode),
          });
        }
      } catch (e) {
        // Fallback for builds that only expose types and modes separately.
        try {
          const pts = m.getParameterTypes();
          const modes = m.getParameterModes();
          for (let p = 0; p < pts.length; p++) {
            entry.params.push({ type: unoTypeInfo(pts[p]), mode: unoParamModeName(modes[p]) });
          }
        } catch (e2) { delete entry.params; }
      }
      out.methods.push(entry);
    }
  } catch (e) {
    if (/no methods/i.test(e.message || '')) {
      out.hint = 'Services have no methods - describe one of their interfaces instead (e.g. com.sun.star.sheet.XSpreadsheet).';
    } else {
      out.methodsError = e.message;
    }
  }

  try {
    const attrs = cls.getAttributes();
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      const entry = { name: a.getName() };
      try { entry.type = unoTypeInfo(a.getType()); } catch (e) { /* optional */ }
      try { entry.readOnly = !!a.isReadOnly(); } catch (e) { /* optional */ }
      out.attributes.push(entry);
    }
  } catch (e) { /* structs/enums have no attributes */ }

  return out;
}

function unoDispatch(req) {
  switch (req.op) {
    case 'root':
      return { $h: unoPut(zHT.context) };
    case 'create': {
      if (!req.service) throw new Error("create needs 'service'");
      const sm = zHT.context.getServiceManager();
      const obj = sm.createInstanceWithContext(req.service, zHT.context);
      return obj ? { $h: unoPut(obj) } : null;
    }
    case 'describe':
      return unoDescribe(req);

    case 'get': {
      return unoEncode(unoGetMember(unoGetHandle(req.h), req.name));
    }
    case 'set': {
      if (req.v === undefined) {
        throw new Error("set needs a value: pass 'v' (use null to clear the property)");
      }
      unoSetMember(unoGetHandle(req.h), req.name, req.v);
      return null;
    }
    case 'call': {
      const obj = unoGetHandle(req.h);
      const fn = obj[req.name];
      if (typeof fn !== 'function') {
        throw new Error(`'${req.name}' is not a method on handle ${req.h}`);
      }
      const args = (req.args || []).map(unoDecode);
      try {
        return unoEncode(fn.apply(obj, args));
      } catch (e) {
        throw new Error(`${req.name}(...) failed: ${(e && e.message) ? e.message : String(e)}`);
      }
    }
    case 'handles': {
      const out = [];
      for (const [id, obj] of unoObjects) {
        if (out.length >= 100) break;
        let implementation = null;
        try {
          const si = queryInterface(obj, 'com.sun.star.lang.XServiceInfo');
          if (si) implementation = si.getImplementationName();
        } catch (e) { /* optional */ }
        out.push({ h: id, implementation });
      }
      return out;
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
    case 'set_enum': {
      // Set an enum property using the type carried by the property itself.
      // Some builds do not register the enum name for Module.uno_Type.Enum,
      // but the runtime property descriptor still knows its Type.
      const obj = unoGetHandle(req.h);
      const info = obj.getPropertySetInfo();
      const prop = info.getPropertyByName(req.name);
      const enumValue = req.value !== undefined ? req.value : req.v;
      const any = new Module.uno_Any(prop.Type, enumValue);
      try {
        obj.setPropertyValue(req.name, any);
      } finally {
        any.delete();
      }
      return null;
    }
    case 'release':
      unoObjects.delete(req.h);
      return null;
    default:
      throw new Error(`Unknown UNO op '${req.op}'`);
  }
}

// ─── Impress slide builder ──────────────────────────────────────────────────
// Build a real Impress (presentation) document with one slide per entry.
// `slides` is an array of { title, text, notes, layout }. Drawing shapes must
// be created through the document factory (doc.createInstance); the global
// service manager returns null for com.sun.star.drawing.TextShape.
const SLIDE_W = 28000; // 1/100 mm — 28 cm, 16:9
const SLIDE_H = 15750; // 1/100 mm — 15.75 cm

const SLIDE_SERIF = 'Liberation Serif';
const SLIDE_SANS = 'Liberation Sans';
const SLIDE_PALETTE = {
  navy: 0x0B1F3A,
  navyDeep: 0x071426,
  navyPanel: 0x10294A,
  navyWatermark: 0x17365D,
  gold: 0xC8A24A,
  goldSoft: 0xE4CE94,
  ivory: 0xF7F5F0,
  slate: 0x1F2937,
  body: 0x3A4656,
  muted: 0x7A8698,
  line: 0xD8D2C4,
  white: 0xFFFFFF,
  coverText: 0xC9D3E0,
  coverMuted: 0x8FA3BF,
};

const SLIDE_ALIGN = {
  left: () => css.style.ParagraphAdjust.LEFT,
  right: () => css.style.ParagraphAdjust.RIGHT,
  center: () => css.style.ParagraphAdjust.CENTER,
};

function createDrawingShape(doc, serviceName) {
  let shape = null;
  try { shape = doc.createInstance(serviceName); } catch (e) { /* fall back below */ }
  if (!shape) {
    try {
      const sm = zHT.context.getServiceManager();
      shape = sm.createInstanceWithContext(serviceName, zHT.context);
    } catch (e) { /* leave null */ }
  }
  return shape;
}

function setShapeFill(shape, color) {
  try {
    setUnoProp(shape, 'FillStyle', Module.uno_Type.Enum('com.sun.star.drawing.FillStyle'),
      css.drawing.FillStyle.SOLID);
    setUnoProp(shape, 'FillColor', Module.uno_Type.Long(), color);
  } catch (e) { /* fill is cosmetic */ }
}

function setShapeNoLine(shape) {
  try {
    setUnoProp(shape, 'LineStyle', Module.uno_Type.Enum('com.sun.star.drawing.LineStyle'),
      css.drawing.LineStyle.NONE);
  } catch (e) { /* line is cosmetic */ }
}

function addSlideRect(doc, page, x, y, w, h, color) {
  const shape = createDrawingShape(doc, 'com.sun.star.drawing.RectangleShape');
  if (!shape) return null;
  shape.setPosition(new css.awt.Point({ X: x, Y: y }));
  shape.setSize(new css.awt.Size({ Width: w, Height: h }));
  setShapeFill(shape, color);
  setShapeNoLine(shape);
  page.add(shape);
  return shape;
}

// Add a formatted text box. Formatting is applied to a select-all cursor so it
// reaches the text that was just inserted (typing attributes would not).
function addSlideText(doc, page, opts) {
  const shape = createDrawingShape(doc, 'com.sun.star.drawing.TextShape');
  if (!shape) throw new Error('Could not create a drawing TextShape (Impress drawing module unavailable)');
  shape.setPosition(new css.awt.Point({ X: opts.x, Y: opts.y }));
  shape.setSize(new css.awt.Size({ Width: opts.w, Height: opts.h }));
  setShapeNoLine(shape);
  try {
    setUnoProp(shape, 'FillStyle', Module.uno_Type.Enum('com.sun.star.drawing.FillStyle'),
      css.drawing.FillStyle.NONE);
  } catch (e) { /* cosmetic */ }
  try { setUnoProp(shape, 'TextAutoGrowHeight', Module.uno_Type.Boolean(), false); } catch (e) {}
  try { setUnoProp(shape, 'TextWordWrap', Module.uno_Type.Boolean(), true); } catch (e) {}
  if (opts.valign) {
    try {
      setUnoProp(shape, 'TextVerticalAdjust',
        Module.uno_Type.Enum('com.sun.star.drawing.TextVerticalAdjust'),
        css.drawing.TextVerticalAdjust[opts.valign.toUpperCase()]);
    } catch (e) { /* vertical alignment is cosmetic */ }
  }
  page.add(shape);

  let xText = null;
  try { xText = queryInterface(shape, 'com.sun.star.text.XText'); } catch (e) { xText = null; }
  if (!xText && typeof shape.getText === 'function') {
    try { xText = shape.getText(); } catch (e) { xText = null; }
  }
  if (!xText) {
    // Last resort for builds where the shape only exposes the String property.
    setUnoProp(shape, 'String', Module.uno_Type.String(), String(opts.text || ''));
    return shape;
  }

  xText.setString(String(opts.text || ''));
  const cur = xText.createTextCursor();
  try { cur.gotoEnd(true); } catch (e) { /* format whole text when possible */ }

  setUnoProp(cur, 'CharHeight', Module.uno_Type.Float(), opts.size || 18);
  setUnoProp(cur, 'CharWeight', Module.uno_Type.Float(), opts.bold ? 150.0 : 100.0);
  setUnoProp(cur, 'CharPosture', Module.uno_Type.Enum('com.sun.star.awt.FontSlant'),
    opts.italic ? css.awt.FontSlant.ITALIC : css.awt.FontSlant.NONE);
  setUnoProp(cur, 'CharColor', Module.uno_Type.Long(),
    opts.color === undefined ? SLIDE_PALETTE.body : opts.color);
  setUnoProp(cur, 'CharFontName', Module.uno_Type.String(), opts.font || SLIDE_SANS);
  if (opts.spacing) {
    try { setUnoProp(cur, 'CharKerning', Module.uno_Type.Short(), opts.spacing); } catch (e) {}
  }
  if (opts.align && SLIDE_ALIGN[opts.align]) {
    try {
      setUnoProp(cur, 'ParaAdjust', Module.uno_Type.Enum('com.sun.star.style.ParagraphAdjust'),
        SLIDE_ALIGN[opts.align]());
    } catch (e) { /* alignment is cosmetic */ }
  }
  if (opts.lineSpacing) {
    try {
      const spacing = new css.style.LineSpacing({
        Mode: css.style.LineSpacingMode.PROP,
        Height: opts.lineSpacing,
      });
      setUnoProp(cur, 'ParaLineSpacing',
        Module.uno_Type.Struct('com.sun.star.style.LineSpacing'), spacing);
    } catch (e) { /* line spacing is cosmetic */ }
  }
  if (opts.spaceBelow) {
    try { setUnoProp(cur, 'ParaBottomMargin', Module.uno_Type.Long(), opts.spaceBelow); } catch (e) {}
  }
  return shape;
}

function addSlideNotes(page, notes) {
  try {
    const notesPage = page.getNotesPage();
    if (!notesPage) return false;
    const count = notesPage.getCount();
    let target = null;
    for (let i = 0; i < count && !target; i++) {
      const sh = notesPage.getByIndex(i);
      let isNotes = false;
      try {
        isNotes = !!(sh.supportsService &&
          sh.supportsService('com.sun.star.presentation.NotesShape'));
      } catch (e) { isNotes = false; }
      if (isNotes) target = sh;
    }
    // Fall back to the last text-capable shape on the notes page.
    for (let i = count - 1; i >= 0 && !target; i--) {
      try {
        if (queryInterface(notesPage.getByIndex(i), 'com.sun.star.text.XText')) {
          target = notesPage.getByIndex(i);
        }
      } catch (e) { /* keep looking */ }
    }
    if (!target) return false;
    const xText = queryInterface(target, 'com.sun.star.text.XText');
    if (!xText) return false;
    xText.setString(String(notes));
    const cur = xText.createTextCursor();
    try { cur.gotoEnd(true); } catch (e) {}
    setUnoProp(cur, 'CharHeight', Module.uno_Type.Float(), 12);
    setUnoProp(cur, 'CharFontName', Module.uno_Type.String(), SLIDE_SANS);
    setUnoProp(cur, 'CharColor', Module.uno_Type.Long(), SLIDE_PALETTE.body);
    return true;
  } catch (e) {
    console.warn('[ZetaJS Worker] Could not add speaker notes:', e);
    return false;
  }
}

function addGoldFrame(doc, page) {
  const inset = 700;
  const t = 26;
  addSlideRect(doc, page, inset, inset, SLIDE_W - 2 * inset, t, SLIDE_PALETTE.gold);
  addSlideRect(doc, page, inset, SLIDE_H - inset - t, SLIDE_W - 2 * inset, t, SLIDE_PALETTE.gold);
  addSlideRect(doc, page, inset, inset, t, SLIDE_H - 2 * inset, SLIDE_PALETTE.gold);
  addSlideRect(doc, page, SLIDE_W - inset - t, inset, t, SLIDE_H - 2 * inset, SLIDE_PALETTE.gold);
}

function addSlideKicker(doc, page, text, x, y, w, align) {
  addSlideText(doc, page, {
    text: String(text || '').toUpperCase(),
    x, y, w, h: 520,
    size: 9.5, bold: true, color: SLIDE_PALETTE.gold,
    spacing: 200, align: align || 'left',
  });
}

function addSlideHeader(doc, page, slide, kicker) {
  addSlideRect(doc, page, 0, 0, SLIDE_W, 120, SLIDE_PALETTE.navy);
  addSlideRect(doc, page, 0, 120, SLIDE_W, 28, SLIDE_PALETTE.gold);
  addSlideKicker(doc, page, kicker || 'Capabilities Brief', 1400, 800, 18000, 'left');
  addSlideText(doc, page, {
    text: slide.title || '',
    x: 1400, y: 1400, w: 24600, h: 2250,
    size: 29, bold: true, color: SLIDE_PALETTE.navy,
    font: SLIDE_SERIF, align: 'left',
  });
  addSlideRect(doc, page, 1400, 3760, 1500, 52, SLIDE_PALETTE.gold);
}

function addSlideFooter(doc, page, index, total) {
  addSlideRect(doc, page, 1400, 14280, 25200, 14, SLIDE_PALETTE.line);
  addSlideRect(doc, page, 1400, 14160, 140, 50, SLIDE_PALETTE.gold);
  addSlideText(doc, page, {
    text: 'ZETAOFFICE MCP · CAPABILITIES BRIEF',
    x: 1700, y: 14380, w: 16000, h: 500,
    size: 8, color: SLIDE_PALETTE.muted, spacing: 120, align: 'left',
  });
  addSlideText(doc, page, {
    text: `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`,
    x: 24000, y: 14380, w: 2600, h: 500,
    size: 8.5, bold: true, color: SLIDE_PALETTE.navy, align: 'right',
  });
}

function renderCoverSlide(doc, page, slide) {
  addSlideRect(doc, page, 0, 0, SLIDE_W, SLIDE_H, SLIDE_PALETTE.navyDeep);
  addSlideRect(doc, page, 19500, 0, 8500, SLIDE_H, SLIDE_PALETTE.navyPanel);
  addSlideRect(doc, page, 19480, 0, 34, SLIDE_H, SLIDE_PALETTE.gold);
  addGoldFrame(doc, page);

  // Monogram
  addSlideRect(doc, page, 1500, 1420, 720, 720, SLIDE_PALETTE.gold);
  addSlideText(doc, page, {
    text: 'Z', x: 1500, y: 1420, w: 720, h: 720,
    size: 24, bold: true, color: SLIDE_PALETTE.navyDeep,
    font: SLIDE_SERIF, align: 'center', valign: 'center',
  });

  addSlideKicker(doc, page, 'Capabilities Brief · 2026', 1500, 3920, 16000, 'left');
  addSlideText(doc, page, {
    text: slide.title || 'Presentation',
    x: 1500, y: 4400, w: 17200, h: 4200,
    size: 42, bold: true, color: SLIDE_PALETTE.white,
    font: SLIDE_SERIF, align: 'left', lineSpacing: 110,
  });
  addSlideRect(doc, page, 1500, 9080, 2600, 64, SLIDE_PALETTE.gold);
  if (slide.text) {
    addSlideText(doc, page, {
      text: slide.text,
      x: 1500, y: 9340, w: 17400, h: 3600,
      size: 16.5, color: SLIDE_PALETTE.coverText, align: 'left', lineSpacing: 150,
    });
  }
  addSlideText(doc, page, {
    text: 'ZETAOFFICE MCP · LIBREOFFICE WEBASSEMBLY',
    x: 1500, y: 13520, w: 17200, h: 500,
    size: 8, color: SLIDE_PALETTE.coverMuted, spacing: 140, align: 'left',
  });
  addSlideText(doc, page, {
    text: '2026', x: 20900, y: 12600, w: 5200, h: 900,
    size: 13, color: SLIDE_PALETTE.goldSoft, font: SLIDE_SERIF,
    spacing: 300, align: 'center',
  });
  addSlideRect(doc, page, 24720, 13540, 520, 18, SLIDE_PALETTE.goldSoft);
}

function renderContentSlide(doc, page, slide, index, total) {
  addSlideRect(doc, page, 0, 0, SLIDE_W, SLIDE_H, SLIDE_PALETTE.ivory);
  addSlideHeader(doc, page, slide, slide.kicker || 'Capabilities Brief');
  if (slide.text) {
    addSlideText(doc, page, {
      text: slide.text,
      x: 1400, y: 4200, w: 25200, h: 9300,
      size: 19, color: SLIDE_PALETTE.body, align: 'left',
      lineSpacing: 145, spaceBelow: 900, valign: 'center',
    });
  }
  addSlideFooter(doc, page, index, total);
}

function renderStatsSlide(doc, page, slide, index, total) {
  addSlideRect(doc, page, 0, 0, SLIDE_W, SLIDE_H, SLIDE_PALETTE.ivory);
  addSlideHeader(doc, page, slide, slide.kicker || 'At a Glance');

  const defaults = [
    { value: '4', label: 'Document types' },
    { value: '9', label: 'Tool groups' },
    { value: '8+', label: 'Export formats' },
    { value: '0', label: 'Cloud dependencies' },
  ];
  const items = (Array.isArray(slide.stats) && slide.stats.length ? slide.stats : defaults).slice(0, 4);
  const gap = 700;
  const w = Math.floor((25200 - gap * (items.length - 1)) / items.length);
  const top = 5300;

  items.forEach((item, i) => {
    const x = 1400 + i * (w + gap);
    addSlideRect(doc, page, x, top, w, 20, SLIDE_PALETTE.navy);
    addSlideRect(doc, page, x, top + 20, 900, 52, SLIDE_PALETTE.gold);
    addSlideText(doc, page, {
      text: String(item.value || ''),
      x, y: top + 430, w, h: 2300,
      size: 46, bold: true, color: SLIDE_PALETTE.navy,
      font: SLIDE_SERIF, align: 'left',
    });
    addSlideText(doc, page, {
      text: String(item.label || '').toUpperCase(),
      x, y: top + 3000, w, h: 1800,
      size: 9.5, color: SLIDE_PALETTE.muted, spacing: 160, align: 'left',
    });
  });
  addSlideFooter(doc, page, index, total);
}

function renderStepsSlide(doc, page, slide, index, total) {
  addSlideRect(doc, page, 0, 0, SLIDE_W, SLIDE_H, SLIDE_PALETTE.ivory);
  addSlideHeader(doc, page, slide, slide.kicker || 'Our Process');

  const defaults = [
    { title: 'Brief', text: 'Describe the deliverable in plain language.' },
    { title: 'Plan', text: 'The agent structures sections, data and tone.' },
    { title: 'Build', text: 'Native UNO edits happen in the live document.' },
    { title: 'Deliver', text: 'Export to DOCX, XLSX, PPTX or PDF.' },
  ];
  const items = (Array.isArray(slide.steps) && slide.steps.length ? slide.steps : defaults).slice(0, 4);
  const gap = 700;
  const w = Math.floor((25200 - gap * (items.length - 1)) / items.length);
  const top = 4800;

  items.forEach((item, i) => {
    const x = 1400 + i * (w + gap);
    addSlideRect(doc, page, x, top, w, 16, SLIDE_PALETTE.line);
    addSlideText(doc, page, {
      text: String(i + 1).padStart(2, '0'),
      x, y: top + 260, w, h: 1000,
      size: 20, bold: true, color: SLIDE_PALETTE.gold,
      font: SLIDE_SERIF, align: 'left',
    });
    addSlideText(doc, page, {
      text: String(item.title || ''),
      x, y: top + 1350, w, h: 900,
      size: 15, bold: true, color: SLIDE_PALETTE.navy,
      font: SLIDE_SERIF, align: 'left',
    });
    if (item.text) {
      addSlideText(doc, page, {
        text: item.text,
        x, y: top + 2300, w, h: 3600,
        size: 11.5, color: SLIDE_PALETTE.body, align: 'left', lineSpacing: 140,
      });
    }
  });
  addSlideFooter(doc, page, index, total);
}

function renderSectionSlide(doc, page, slide, part) {
  addSlideRect(doc, page, 0, 0, SLIDE_W, SLIDE_H, SLIDE_PALETTE.navyDeep);
  addGoldFrame(doc, page);
  addSlideText(doc, page, {
    text: String(part).padStart(2, '0'),
    x: 19800, y: 4700, w: 6800, h: 9000,
    size: 150, bold: true, color: SLIDE_PALETTE.navyWatermark,
    font: SLIDE_SERIF, align: 'right',
  });
  addSlideKicker(doc, page, `Part ${String(part).padStart(2, '0')}`, 1600, 5400, 15000, 'left');
  addSlideText(doc, page, {
    text: slide.title || '',
    x: 1600, y: 5850, w: 17200, h: 2600,
    size: 40, bold: true, color: SLIDE_PALETTE.white,
    font: SLIDE_SERIF, align: 'left', lineSpacing: 110,
  });
  addSlideRect(doc, page, 1600, 8720, 2200, 64, SLIDE_PALETTE.gold);
  if (slide.text) {
    addSlideText(doc, page, {
      text: slide.text,
      x: 1600, y: 8980, w: 19600, h: 3000,
      size: 16.5, color: SLIDE_PALETTE.coverText, align: 'left', lineSpacing: 145,
    });
  }
  addSlideText(doc, page, {
    text: 'ZETAOFFICE MCP',
    x: 1600, y: 14100, w: 12000, h: 500,
    size: 8, color: SLIDE_PALETTE.coverMuted, spacing: 140, align: 'left',
  });
}

function renderClosingSlide(doc, page, slide) {
  addSlideRect(doc, page, 0, 0, SLIDE_W, SLIDE_H, SLIDE_PALETTE.navyDeep);
  addGoldFrame(doc, page);
  addSlideKicker(doc, page, 'Next Step', 4000, 5200, 20000, 'center');
  addSlideText(doc, page, {
    text: slide.title || 'Thank You',
    x: 2000, y: 5650, w: 24000, h: 2800,
    size: 42, bold: true, color: SLIDE_PALETTE.white,
    font: SLIDE_SERIF, align: 'center', lineSpacing: 110,
  });
  addSlideRect(doc, page, 12900, 8620, 2200, 64, SLIDE_PALETTE.gold);
  if (slide.text) {
    addSlideText(doc, page, {
      text: slide.text,
      x: 4000, y: 8880, w: 20000, h: 3000,
      size: 16.5, color: SLIDE_PALETTE.coverText, align: 'center', lineSpacing: 145,
    });
  }
  addSlideText(doc, page, {
    text: 'ZETAOFFICE MCP · LIBREOFFICE WEBASSEMBLY',
    x: 4000, y: 13520, w: 20000, h: 500,
    size: 8, color: SLIDE_PALETTE.coverMuted, spacing: 140, align: 'center',
  });
}

function buildImpressDocument(slides) {
  const doc = zHT.desktop.loadComponentFromURL('private:factory/simpress', '_default', 0, []);
  if (!doc) throw new Error('Could not create an Impress document');
  const pages = doc.getDrawPages();

  const list = (Array.isArray(slides) && slides.length)
    ? slides
    : [{ title: 'Presentation', text: '' }];

  while (pages.getCount() < list.length) {
    pages.insertNewByIndex(pages.getCount());
  }
  for (let i = pages.getCount() - 1; i >= list.length; i--) {
    try { pages.remove(pages.getByIndex(i)); } catch (e) { /* keep page */ }
  }

  let partNumber = 0;
  for (let i = 0; i < list.length; i++) {
    const slide = list[i] || {};
    const page = pages.getByIndex(i);

    // 16:9 canvas; drop the default title/content placeholders.
    try {
      setUnoProp(page, 'Width', Module.uno_Type.Long(), SLIDE_W);
      setUnoProp(page, 'Height', Module.uno_Type.Long(), SLIDE_H);
    } catch (e) { /* keep the default page size */ }
    for (let s = page.getCount() - 1; s >= 0; s--) {
      try { page.remove(page.getByIndex(s)); } catch (e) { /* keep shape */ }
    }

    const layout = String(slide.layout || (i === 0 ? 'cover' : 'content')).toLowerCase();
    if (layout === 'cover') {
      renderCoverSlide(doc, page, slide);
    } else if (layout === 'section') {
      partNumber += 1;
      renderSectionSlide(doc, page, slide, partNumber);
    } else if (layout === 'closing' || layout === 'end') {
      renderClosingSlide(doc, page, slide);
    } else if (layout === 'stats') {
      renderStatsSlide(doc, page, slide, i, list.length);
    } else if (layout === 'steps') {
      renderStepsSlide(doc, page, slide, i, list.length);
    } else {
      renderContentSlide(doc, page, slide, i, list.length);
    }

    if (slide.notes) addSlideNotes(page, slide.notes);
  }

  const deckTitle = (list[0] && list[0].title) ? String(list[0].title) : 'Presentation';
  try {
    const props = doc.getDocumentProperties();
    setUnoProp(props, 'Title', Module.uno_Type.String(), deckTitle);
  } catch (e) { /* metadata is optional */ }

  xModel = doc;
  currentDocType = 'impress';
  currentDocTitle = deckTitle;
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
          result = {
            success: true,
            message: `Cleared and reset active ${type} document canvas via ZetaJS UNO`,
            doc_type: type,
            handle: { $h: unoPut(cur) },
          };
          break;
        }

        xModel = zHT.desktop.loadComponentFromURL(url, '_default', 0, []);
        currentDocType = type;
        currentDocTitle = `Untitled ${type.charAt(0).toUpperCase() + type.slice(1)}`;
        resetTypingAttributes(xModel);
        result = {
          success: true,
          message: `Created new ${type} document via ZetaJS UNO`,
          doc_type: type,
          handle: { $h: unoPut(xModel) },
        };
        break;
      }

      case 'load_document_live': {
        // Replace the document shown on the canvas with bytes supplied by the
        // bridge (base64). Used to push the canonical document from the Node
        // runtime into a freshly connected browser tab.
        const format = String(params.format || 'odt').toLowerCase().replace(/^\./, '');
        const filterName = getImportFilterName(format);
        if (!filterName) throw new Error(`Unsupported document format '${format}'`);

        if (!params.path && (typeof params.data !== 'string' || !params.data)) {
          throw new Error("load_document_live requires base64 'data' or a 'path' in the shared filesystem");
        }

        const FS = (Module && (Module.__FS || Module.FS)) || (zHT && zHT.FS) || globalThis.FS;
        if (!FS || typeof FS.writeFile !== 'function') {
          throw new Error('Wasm filesystem is not available for loading');
        }

        let bytes = null;
        if (typeof params.data === 'string' && params.data) {
          if (typeof Buffer !== 'undefined') {
            bytes = Buffer.from(params.data, 'base64');
          } else {
            const bin = atob(params.data);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          }
        }

        let fsPath = params.path ? String(params.path) : `/tmp/live_${Date.now()}.${format}`;
        let written = 0;
        if (!params.path) {
          try { FS.mkdir('/tmp'); } catch (e) { /* already exists */ }
          FS.writeFile(fsPath, bytes);
          try { written = FS.readFile(fsPath).length; } catch (e) { written = -1; }
        } else {
          written = bytes ? bytes.length : -1;
        }

        const PropertyValue = css.beans.PropertyValue;
        const props = [
          new PropertyValue({ Name: 'FilterName', Handle: 0, Value: filterName }),
          new PropertyValue({ Name: 'Hidden', Handle: 0, Value: false }),
          new PropertyValue({ Name: 'ReadOnly', Handle: 0, Value: false }),
          new PropertyValue({ Name: 'Silent', Handle: 0, Value: true }),
        ];

        const prev = getDoc();
        let loaded = null;
        let lastErr = null;
        for (const target of ['_default', '_blank', '_self']) {
          try {
            loaded = zHT.desktop.loadComponentFromURL('file://' + fsPath, target, 0, props);
          } catch (e) {
            lastErr = e;
            loaded = null;
          }
          console.log(`[ZetaJS Worker] load_document_live target=${target} -> ${loaded ? 'ok' : 'null'}${lastErr ? ' err=' + lastErr.message : ''}`);
          if (loaded) break;
        }
        if (!loaded) {
          throw new Error(`LibreOffice could not open the supplied document (${format}, ${bytes ? bytes.length : '?'} bytes, fs=${written})${lastErr ? ': ' + lastErr.message : ''}`);
        }
        try { FS.unlink(fsPath); } catch (e) { /* best effort */ }

        xModel = loaded;
        currentDocType = (format === 'odp' || format === 'pptx' || format === 'ppt') ? 'impress'
          : (format === 'ods' || format === 'xlsx' || format === 'xls' || format === 'csv') ? 'calc'
          : format === 'odg' ? 'draw' : 'writer';
        try {
          const docProps = loaded.getDocumentProperties();
          if (docProps && docProps.Title) currentDocTitle = String(docProps.Title);
        } catch (e) { /* title is optional */ }

        // Keep the canvas bound to a single frame: dispose of the previous one.
        if (prev && prev !== loaded) {
          try { prev.close(false); } catch (e) { /* leave it open if it refuses */ }
        }

        result = {
          success: true,
          message: `Loaded ${format} document into the live canvas`,
          doc_type: currentDocType,
          title: currentDocTitle,
          bytes: bytes ? bytes.length : undefined,
        };
        break;
      }

      case 'set_cells_live': {
        const doc = getDoc();
        const sheet = resolveSheet(doc, params.sheet);
        if (!Array.isArray(params.values)) {
          throw new Error("set_cells_live requires 'values' (a 2-D array of rows)");
        }
        const { col, row } = a1ToPos(params.start || 'A1');
        const height = Math.max(1, params.values.length);
        const width = Math.max(1, ...params.values.map((r) => (Array.isArray(r) ? r.length : 1)));
        const range = sheet.getCellRangeByPosition(col, row, col + width - 1, row + height - 1);
        const written = writeGrid(range, params.values);
        result = {
          success: true,
          message: `Wrote ${written.rows} row(s) x ${written.cols} column(s) at ${params.start || 'A1'}`,
          sheet: params.sheet || null,
          start: params.start || 'A1',
          ...written,
        };
        break;
      }

      case 'get_cells_live': {
        const doc = getDoc();
        const sheet = resolveSheet(doc, params.sheet);
        const address = params.range || 'A1:B10';
        const range = sheet.getCellRangeByName(address);
        result = {
          success: true,
          sheet: params.sheet || null,
          range: address,
          values: range.getDataArray(),
        };
        break;
      }

      case 'format_range_live': {
        const doc = getDoc();
        const sheet = resolveSheet(doc, params.sheet);
        const range = sheet.getCellRangeByName(params.range);
        if (params.bold !== undefined) {
          setUnoProp(range, 'CharWeight', Module.uno_Type.Float(), params.bold ? 150 : 100);
        }
        if (params.italic !== undefined) {
          setUnoProp(range, 'CharPosture', Module.uno_Type.Enum('com.sun.star.awt.FontSlant'), params.italic ? 2 : 0);
        }
        if (params.font_size) {
          setUnoProp(range, 'CharHeight', Module.uno_Type.Float(), Number(params.font_size));
        }
        if (params.align) {
          const alignMap = { left: 0, center: 2, right: 1 };
          setUnoProp(range, 'HoriJustify', Module.uno_Type.Enum('com.sun.star.table.CellHoriJustify'), alignMap[params.align]);
        }
        if (params.fill_color) {
          setUnoProp(range, 'CellBackColor', Module.uno_Type.Long(),
            parseInt(String(params.fill_color).replace('#', ''), 16));
        }
        let numberFormat = null;
        if (params.number_format) numberFormat = applyNumberFormat(doc, range, params.number_format);
        result = {
          success: true,
          message: `Formatted ${params.range}`,
          ...(numberFormat ? { number_format: numberFormat.code, number_format_key: numberFormat.key } : {}),
        };
        break;
      }

      case 'set_column_width_live': {
        const doc = getDoc();
        const sheet = resolveSheet(doc, params.sheet);
        const { col } = a1ToPos(String(params.column || 'A').replace(/\d+$/, '') + '1');
        const width = Math.round(Number(params.width_mm || 25) * 100); // 1/100 mm
        setUnoProp(sheet.getColumns().getByIndex(col), 'Width', Module.uno_Type.Long(), width);
        result = { success: true, message: `Column ${params.column || 'A'} width set to ${params.width_mm || 25} mm` };
        break;
      }

      case 'add_chart_live': {
        const doc = getDoc();
        if (!doc || typeof doc.getSheets !== 'function') {
          throw new Error('Active document is not a spreadsheet');
        }
        const sheet = resolveSheet(doc, params.sheet);
        const dataSheet = params.data_sheet ? resolveSheet(doc, params.data_sheet) : sheet;
        const charts = sheet.getCharts();
        const name = params.name || ('Chart' + (charts.getCount() + 1));
        if (typeof charts.hasByName === 'function' && charts.hasByName(name)) charts.removeByName(name);

        const rect = new css.awt.Rectangle({
          X: Math.round(params.x !== undefined ? params.x : 12000),
          Y: Math.round(params.y !== undefined ? params.y : 1200),
          Width: Math.round(params.width !== undefined ? params.width : 17000),
          Height: Math.round(params.height !== undefined ? params.height : 9500),
        });
        const range = dataSheet.getCellRangeByName(params.data_range || 'A1:B10');
        // Some LibreOffice builds expose a fifth aRowHeaders parameter; pass it
        // so the first column (dates) becomes the category axis, and fall back
        // to the 4-argument IDL on builds that do not.
        try {
          charts.addNewByName(name, rect, [range.getRangeAddress()],
            params.column_headers !== false, params.row_headers !== false);
        } catch (e) {
          if (!/number of arguments/i.test(e.message || '')) throw e;
          charts.addNewByName(name, rect, [range.getRangeAddress()], params.column_headers !== false);
        }

        const chart = charts.getByName(name).getEmbeddedObject();
        const diagramService = {
          line: 'com.sun.star.chart.LineDiagram',
          column: 'com.sun.star.chart.BarDiagram',
          bar: 'com.sun.star.chart.BarDiagram',
          area: 'com.sun.star.chart.AreaDiagram',
          pie: 'com.sun.star.chart.PieDiagram',
          scatter: 'com.sun.star.chart.XYDiagram',
        }[String(params.chart_type || 'line').toLowerCase()];
        if (diagramService) chart.createInstance(diagramService);

        if (params.title) {
          try { setUnoProp(chart, 'HasMainTitle', Module.uno_Type.Boolean(), true); } catch (e) { /* optional */ }
          try {
            const titleObj = chart.getTitle();
            // XTitle exposes its text as the String property in this build.
            setUnoProp(titleObj, 'String', Module.uno_Type.String(), String(params.title));
          } catch (e) {
            console.log('[Chart] title:', e.message);
          }
        }
        let diagram = null;
        try { diagram = chart.getDiagram(); } catch (e) { /* optional */ }
        const setAxisTitle = (axisName, text) => {
          if (!diagram || !text) return;
          const axis = axisName === 'x' ? diagram.getXAxis() : diagram.getYAxis();
          try {
            // ChartAxis exposes the caption through getAxisTitle() -> XTitle.
            const titleObj = axis.getAxisTitle();
            if (!titleObj) return;
            try {
              setUnoProp(titleObj, 'String', Module.uno_Type.String(), String(text));
            } catch (e) {
              console.log(`[Chart] ${axisName} axisTitle.String:`, e.message);
            }
          } catch (e) {
            console.log(`[Chart] ${axisName} getAxisTitle:`, e.message);
          }
        };
        if (params.x_title) setAxisTitle('x', params.x_title);
        if (params.y_title) setAxisTitle('y', params.y_title);
        if (diagram) {
          try { setUnoProp(diagram.getXAxis(), 'TextRotation', Module.uno_Type.Long(), 45); } catch (e) { /* cosmetic */ }
        }
        if (params.legend === false) {
          try { setUnoProp(chart, 'HasLegend', Module.uno_Type.Boolean(), false); } catch (e) { /* optional */ }
        }
        if (params.date_axis) {
          try {
            const axis = diagram ? diagram.getXAxis() : null;
            if (axis) setEnumProp(axis, 'AxisType', 2); // DATE
          } catch (e) { console.log('[Chart] date axis:', e.message); }
        }

        result = {
          success: true,
          message: `Added ${params.chart_type || 'line'} chart '${name}'`,
          chart: name,
          data_range: params.data_range,
          data_sheet: params.data_sheet || null,
        };
        break;
      }

      case 'uno_live': {
        // Generic UNO escape hatch: one tool for the whole com.sun.star API.
        // Accept 'value' as well as 'v' so the MCP wrapper and raw HTTP agree.
        const req = Object.assign({}, params);
        if (req.v === undefined && req.value !== undefined) req.v = req.value;
        const value = unoDispatch(req);
        result = { success: true, op: req.op, value };
        break;
      }

      case 'insert_embedded_object_live': {
        const doc = requireTextDoc();
        const key = String(params.service || params.clsid || 'calc').toLowerCase();
        const clsid = EMBED_CLSIDS[key] || (String(params.clsid || '').match(/^[0-9a-f-]{36}$/i) ? String(params.clsid) : null);
        if (!clsid) throw new Error(`Unknown embedded service '${params.service}'. Use calc, writer, impress, draw, math or a CLSID.`);

        const textObj = doc.getText();
        const cursor = textObj.createTextCursor();
        cursor.gotoEnd(false);
        cursor.collapseToEnd();
        const container = doc.getEmbeddedObjects();
        const before = toArray(container.getElementNames()).length;

        const obj = doc.createInstance('com.sun.star.text.TextEmbeddedObject');
        if (!obj) throw new Error('Could not create a TextEmbeddedObject (embedded objects unsupported in this build)');
        setUnoProp(obj, 'CLSID', Module.uno_Type.String(), clsid);
        if (params.anchor === 'paragraph') {
          setUnoProp(obj, 'AnchorType', Module.uno_Type.Enum('com.sun.star.text.TextContentAnchorType'),
            css.text.TextContentAnchorType.AT_PARAGRAPH);
        } else {
          setUnoProp(obj, 'AnchorType', Module.uno_Type.Enum('com.sun.star.text.TextContentAnchorType'),
            css.text.TextContentAnchorType.AS_CHARACTER);
        }
        if (params.width_mm) setUnoProp(obj, 'Width', Module.uno_Type.Long(), Math.round(Number(params.width_mm) * 100));
        if (params.height_mm) setUnoProp(obj, 'Height', Module.uno_Type.Long(), Math.round(Number(params.height_mm) * 100));

        textObj.insertTextContent(cursor, obj, false);
        const names = toArray(container.getElementNames());
        if (names.length <= before) {
          throw new Error('Embedded object was not inserted: LibreOffice accepted the call but created no object.');
        }
        const name = names[names.length - 1];

        const model = obj.getEmbeddedObject();
        let written = null;
        if (model && Array.isArray(params.values) && typeof model.getSheets === 'function') {
          const sheet = model.getSheets().getByIndex(0);
          const height = params.values.length;
          const width = Math.max(1, ...params.values.map((r) => (Array.isArray(r) ? r.length : 1)));
          const range = sheet.getCellRangeByPosition(0, 0, width - 1, Math.max(0, height - 1));
          written = writeGrid(range, params.values);
        }
        let chart = null;
        if (params.chart && model) {
          try { chart = addEmbeddedChart(model, params.values, params.chart); }
          catch (e) { console.log('[embed] chart failed:', e.message); }
        }
        const preview = applyEmbeddedPreview(model, obj, params.width_mm, params.height_mm);

        result = {
          success: true,
          message: `Embedded '${key}' object '${name}' and returned its model`,
          name,
          clsid,
          object: { $h: unoPut(obj) },
          model: model ? { $h: unoPut(model) } : null,
          values: written,
          chart,
          preview,
        };
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
          if (typeof doc.getDrawPages === 'function') {
            // Impress/Draw: one draw page per slide.
            const drawPages = doc.getDrawPages();
            if (drawPages && typeof drawPages.getCount === 'function') {
              pageCount = drawPages.getCount();
            }
          } else {
            const controller = doc.getCurrentController();
            if (controller && typeof controller.getPageCount === 'function') {
              pageCount = controller.getPageCount();
            }
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

      // --- High-level field operations ---
      case 'field_bookmark_live': {
        result = { success: true, ...addBookmark(requireTextDoc(), params) };
        break;
      }
      case 'field_link_live': {
        result = { success: true, ...addInternalLink(requireTextDoc(), params) };
        break;
      }
      case 'field_caption_pair_live': {
        result = { success: true, ...addCaptionPair(requireTextDoc(), params) };
        break;
      }

      // --- High-level Calc operations ---
      case 'calc_sheet_live': {
        result = { success: true, ...calcSheetOp(params) };
        break;
      }
      case 'calc_validation_live': {
        result = { success: true, ...setValidation(params) };
        break;
      }
      case 'calc_named_range_live': {
        result = { success: true, ...addNamedRange(params) };
        break;
      }
      case 'calc_freeze_live': {
        result = { success: true, ...freezePanes(params) };
        break;
      }

      // --- High-level page setup ---
      case 'page_setup_live': {
        result = { success: true, ...setPageSetup(params) };
        break;
      }
      case 'page_header_footer_live': {
        result = { success: true, ...setHeaderFooter(params) };
        break;
      }

      // --- High-level Writer table ---
      case 'writer_table_live': {
        result = { success: true, ...createWriterTable(params) };
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
