// Just enough of the .xlsx format for the HIS exports and the SPDCL upload
// file, with no dependency: an .xlsx is a zip of XML parts. Reads the first
// sheet of a workbook into a plain grid, and packs parts back into a zip.
//
// The HIS files are as plain as Excel files get: shared strings and numbers,
// no formulas or styles that matter. Cells a merge covers are simply empty here.
const zlib = require('zlib');

/** A file that is not a readable .xlsx. Its message is safe to show (no cell contents). */
class XlsxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XlsxError';
    this.status = 422;
  }
}

// One part may unpack to at most this much: a small upload must not become gigabytes in memory.
const MAX_PART_BYTES = 50 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 of a buffer: Node's own where it has one (20.15+), the table otherwise. */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** The zip's parts by name → { text(name), bytes(name), names }. Throws XlsxError. */
function openZip(buf) {
  const fail = (why) => {
    throw new XlsxError(why);
  };
  if (buf.length < 22) fail('Not an Excel (.xlsx) file');
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) fail('Not an Excel (.xlsx) file, or the file is damaged');
  const count = buf.readUInt16LE(end + 10);
  const dirOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) fail('This Excel file is too large to read');

  const parts = new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('The Excel file is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const skip = nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength);
    p += 46 + skip;
    if (name.endsWith('/')) continue;
    if (flags & 1) fail('The Excel file is password-protected — save it without a password and choose it again');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) fail('The Excel file is damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    parts.set(name.replace(/\\/g, '/'), { method, crc, size, raw: buf.subarray(start, start + packed) });
  }

  const find = (name) => {
    const want = name.replace(/^\//, '');
    if (parts.has(want)) return parts.get(want);
    const lower = want.toLowerCase();
    for (const [key, part] of parts) if (key.toLowerCase() === lower) return part;
    return null;
  };
  const bytes = (name) => {
    const part = find(name);
    if (!part) return null;
    if (part.size > MAX_PART_BYTES) fail('This Excel file is too large to read');
    let data;
    try {
      if (part.method === 0) data = part.raw;
      else if (part.method === 8) data = zlib.inflateRawSync(part.raw, { maxOutputLength: MAX_PART_BYTES });
      else fail('This Excel file uses a compression FillPilot cannot read — save it again in Excel as .xlsx');
    } catch (err) {
      if (err instanceof XlsxError) throw err;
      fail('The Excel file is damaged');
    }
    if (crc32(data) !== part.crc) fail('The Excel file is damaged');
    return data;
  };
  return {
    names: [...parts.keys()],
    bytes,
    text: (name) => {
      const data = bytes(name);
      return data ? data.toString('utf8') : null;
    },
  };
}

/** "&lt;" → "<", "&#8377;" → "₹", Excel's "_x000D_" → "\r". */
function decodeXml(s) {
  return s
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
      const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
      if (named) return named;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/_x([0-9a-f]{4})_/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Text safe inside an XML element or attribute (characters XML 1.0 forbids are dropped). */
function escapeXml(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** <tag a="1" r:id="x"> → { a: '1', 'r:id': 'x' } */
function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeXml(m[3] ?? m[4]);
  return out;
}

/** All text of an <si> or <is>: plain <t>, or the runs of rich text; phonetic hints (<rPh>) left out. */
function textOf(xml) {
  const plain = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  // The empty form first: "<t/>" would otherwise open a match that runs into the next element.
  for (const m of plain.matchAll(/<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => (m[1] ? textOf(m[1]) : ''));
}

/** "AB12" → column index 27 (0-based), row 11. */
function cellAddress(ref) {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref || '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/** 0 → "A", 26 → "AA". */
function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Where the workbook's first sheet is stored, and its name. */
function firstSheet(zip) {
  const workbook = zip.text('xl/workbook.xml');
  if (!workbook) throw new XlsxError('Not an Excel workbook (.xlsx)');
  const tag = /<sheet\b[^>]*>/.exec(workbook);
  if (!tag) throw new XlsxError('The Excel file has no sheet');
  const sheet = attributes(tag[0]);
  const relId = Object.entries(sheet).find(([key]) => /:id$/i.test(key))?.[1];
  let path = 'xl/worksheets/sheet1.xml';
  const rels = zip.text('xl/_rels/workbook.xml.rels');
  if (rels && relId) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const rel = attributes(m[0]);
      if (rel.Id !== relId || !rel.Target) continue;
      path = rel.Target.startsWith('/') ? rel.Target.slice(1) : `xl/${rel.Target}`;
      path = path.replace(/\/\.\//g, '/');
      while (/[^/]+\/\.\.\//.test(path)) path = path.replace(/[^/]+\/\.\.\//, '');
      break;
    }
  }
  return { name: sheet.name ?? null, path };
}

/**
 * The first sheet of an .xlsx → { sheetName, rows }: rows[r][c] is a string,
 * a number, a boolean or null (0-based; row 1 of Excel is rows[0]).
 * Formula cells give their saved result.
 */
function readFirstSheet(buffer) {
  const zip = openZip(buffer);
  const { name, path } = firstSheet(zip);
  const xml = zip.text(path);
  if (!xml) throw new XlsxError('The Excel file has no sheet');
  const strings = sharedStrings(zip.text('xl/sharedStrings.xml'));

  const rows = [];
  let rowIndex = -1;
  const body = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? '';
  for (const rowMatch of body.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttrs = attributes(rowMatch[1]);
    rowIndex = rowAttrs.r ? Number(rowAttrs.r) - 1 : rowIndex + 1;
    const cells = [];
    let colIndex = -1;
    for (const cell of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attributes(cell[1]);
      colIndex = cellAddress(attrs.r)?.col ?? colIndex + 1;
      const inner = cell[2] ?? '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = null;
      if (attrs.t === 's') value = v == null ? null : strings[Number(v)] ?? null;
      else if (attrs.t === 'inlineStr') value = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      else if (attrs.t === 'str') value = v == null ? null : decodeXml(v);
      else if (attrs.t === 'b') value = v == null ? null : v.trim() === '1';
      else if (attrs.t === 'e') value = null;
      else if (v != null && v.trim() !== '') {
        const n = Number(v);
        value = Number.isFinite(n) ? n : decodeXml(v);
      }
      if (value === '') value = null;
      cells[colIndex] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows[rowIndex] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return { sheetName: name, rows };
}

/** Parts → a zip (deflated). parts: [{ name, data: Buffer | string }] */
function writeZip(parts) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const part of parts) {
    const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const name = Buffer.from(part.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);

    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}

module.exports = {
  XlsxError, openZip, readFirstSheet, writeZip, sharedStrings, escapeXml, decodeXml, attributes, cellAddress, columnName, crc32,
};
