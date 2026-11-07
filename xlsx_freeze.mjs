/**
 * Patch frozen panes into an exported xlsx.
 *
 * The headless Node runtime has no attached view, so LibreOffice's
 * XViewFreezable accepts freezeAtPosition() but the xlsx filter writes no
 * <pane>. This post-pass inserts the pane metadata into the already-exported
 * package. It is intentionally limited to view metadata; cell data is not
 * touched.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readZip(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory record)");
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("Bad ZIP central directory");
    const versionMade = buffer.readUInt16LE(pos + 4);
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const time = buffer.readUInt16LE(pos + 12);
    const date = buffer.readUInt16LE(pos + 14);
    const crc = buffer.readUInt32LE(pos + 16);
    const compSize = buffer.readUInt32LE(pos + 20);
    const uncompSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const externalAttr = buffer.readUInt32LE(pos + 38);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLen);
    const local = localOffset;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad ZIP local header for ${name}`);
    const localNameLen = buffer.readUInt16LE(local + 26);
    const localExtraLen = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLen + localExtraLen;
    entries.set(name, {
      name, versionMade, flags, method, time, date, crc, compSize, uncompSize,
      externalAttr, data: buffer.subarray(dataStart, dataStart + compSize),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, comment: buffer.subarray(eocd + 22) };
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function entryText(entry) {
  if (!entry) return "";
  const raw = entry.method === 0 ? entry.data : zlib.inflateRawSync(entry.data);
  return raw.toString("utf8");
}

function setEntryText(entry, text) {
  const raw = Buffer.from(text, "utf8");
  entry.data = zlib.deflateRawSync(raw, { level: 6 });
  entry.method = 8;
  entry.flags &= ~0x0008; // no data descriptor
  entry.crc = crc32(raw);
  entry.compSize = entry.data.length;
  entry.uncompSize = raw.length;
}

function parseAttrs(source) {
  const attrs = {};
  for (const m of source.matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

function xmlUnescape(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function resolveSheetTargets(entries) {
  const workbook = entryText(entries.get("xl/workbook.xml"));
  const rels = entryText(entries.get("xl/_rels/workbook.xml.rels"));
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = parseAttrs(m[1]);
    if (a.Id && a.Target) relMap.set(a.Id, a.Target);
  }
  const targets = new Map();
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = parseAttrs(m[1]);
    const rid = a["r:id"];
    const target = relMap.get(rid);
    if (!a.name || !target) continue;
    let normalized = target.replace(/^\/+/, "");
    if (!normalized.startsWith("xl/")) normalized = path.posix.normalize("xl/" + normalized);
    targets.set(xmlUnescape(a.name), normalized);
  }
  return targets;
}

function columnName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function insertPane(xml, columns, rows) {
  const cols = Math.max(0, Number(columns) || 0);
  const rws = Math.max(0, Number(rows) || 0);
  if (!cols && !rws) return xml;
  const xSplit = cols ? ` xSplit="${cols}"` : "";
  const ySplit = rws ? ` ySplit="${rws}"` : "";
  const topLeftCell = `${columnName(cols)}${rws + 1}`;
  const activePane = cols && rws ? "bottomRight" : rws ? "bottomLeft" : "topRight";
  const pane = `<pane${xSplit}${ySplit} topLeftCell="${topLeftCell}" activePane="${activePane}" state="frozen"/>`;
  const cleaned = xml.replace(/<pane\b[^>]*\/>/g, "");
  const m = /<sheetView\b([^>]*?)(\/?)>/.exec(cleaned);
  if (!m) return cleaned;
  if (m[2] === "/") {
    return cleaned.slice(0, m.index) + `<sheetView${m[1]}>${pane}</sheetView>` +
      cleaned.slice(m.index + m[0].length);
  }
  return cleaned.slice(0, m.index + m[0].length) + pane + cleaned.slice(m.index + m[0].length);
}

function buildZip(entries, comment) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries.values()) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags & ~0x0008, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.time, 10);
    local.writeUInt16LE(entry.date, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compSize, 18);
    local.writeUInt32LE(entry.uncompSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMade || 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags & ~0x0008, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.time, 12);
    central.writeUInt16LE(entry.date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compSize, 20);
    central.writeUInt32LE(entry.uncompSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.externalAttr || 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...localParts, central, eocd, comment]);
}

/**
 * @param {string} filePath exported .xlsx
 * @param {Record<string, {columns?: number, rows?: number}>} freezes sheet -> pane
 * @returns {{patched: string[], missing: string[]}}
 */
export function patchXlsxFreeze(filePath, freezes) {
  const buffer = fs.readFileSync(filePath);
  const { entries, comment } = readZip(buffer);
  const targets = resolveSheetTargets(entries);
  const patched = [];
  const missing = [];
  for (const [sheetName, spec] of Object.entries(freezes || {})) {
    const target = targets.get(sheetName);
    const entry = target ? entries.get(target) : null;
    if (!entry) { missing.push(sheetName); continue; }
    const xml = entryText(entry);
    const next = insertPane(xml, spec.columns, spec.rows);
    if (next === xml) { missing.push(sheetName); continue; }
    setEntryText(entry, next);
    patched.push(sheetName);
  }
  if (patched.length) fs.writeFileSync(filePath, buildZip(entries, comment));
  return { patched, missing };
}
