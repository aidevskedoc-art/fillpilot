// The SPDCL upload file: SPDCL's own blank template (spdcl-template.xlsx, no
// patient data) with its "Test" sheet filled. Everything else stays as the
// template has it: the "Heads" sheet, the Namelist name behind the
// Service_Type dropdown, the dropdowns, styles, widths and hidden column L.
const fs = require('fs');
const path = require('path');
const { openZip, writeZip, sharedStrings, escapeXml } = require('./xlsx');

const TEMPLATE = path.join(__dirname, 'spdcl-template.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';
const STRINGS = 'xl/sharedStrings.xml';
const CORE = 'docProps/core.xml';

// Styles of the template's cells (cellXfs in its styles.xml): what a filled row uses.
const STYLE = { code: 7, text: 8, rate: 9, qty: 10, amount: 1 };

let template = null;
function loadTemplate() {
  if (template) return template;
  const zip = openZip(fs.readFileSync(TEMPLATE));
  const sheet = zip.text(SHEET);
  const strings = sharedStrings(zip.text(STRINGS));
  // Row 1 (the headers) is copied as it is; column L's list (rows 2–33) is kept.
  const header = /<row r="1"[\s\S]*?<\/row>/.exec(sheet)?.[0];
  const listRefs = new Map();
  for (const m of sheet.matchAll(/<c r="L(\d+)"[^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/g)) {
    if (Number(m[1]) > 1) listRefs.set(Number(m[1]), Number(m[2]));
  }
  if (!header || !listRefs.size) throw new Error('spdcl-template.xlsx is not the SPDCL template');
  // Shared strings the Heads sheet points at, counted for the <sst count>.
  const otherRefs = zip.names
    .filter((n) => /^xl\/worksheets\/.+\.xml$/.test(n) && n !== SHEET)
    .reduce((count, n) => count + (zip.text(n).match(/t="s"/g) || []).length, 0);
  template = { zip, sheet, strings, header, listRefs, otherRefs };
  return template;
}

const num = (n) => String(Math.round(n * 1e6) / 1e6);

/**
 * sheet: buildSpdclSheet()'s result → the .xlsx as a Buffer. One row per sheet
 * row, from row 2: tariff type, "Service", head, code, name, date (text, as the
 * template expects dd/mm/yyyy), rate, quantity, =G*H, 0, =I-J.
 */
function writeSpdclWorkbook(sheet) {
  const t = loadTemplate();
  const strings = [...t.strings];
  const index = new Map();
  strings.forEach((s, i) => {
    if (!index.has(s)) index.set(s, i);
  });
  let refs = 0;
  const str = (value) => {
    if (!index.has(value)) {
      index.set(value, strings.length);
      strings.push(value);
    }
    refs++;
    return index.get(value);
  };
  const s = (ref, value, style) => `<c r="${ref}"${style != null ? ` s="${style}"` : ''} t="s"><v>${str(value)}</v></c>`;
  const empty = (ref, style) => `<c r="${ref}" s="${style}"/>`;

  const tariff = sheet.tariffType || 'EHS';
  const rows = sheet.rows;
  const last = Math.max(rows.length + 1, ...t.listRefs.keys());
  const xmlRows = [t.header];
  refs += (t.header.match(/t="s"/g) || []).length;
  for (let r = 2; r <= last; r++) {
    const row = rows[r - 2];
    const cells = [];
    if (row) {
      cells.push(
        s(`A${r}`, tariff),
        s(`B${r}`, 'Service'),
        s(`C${r}`, row.head),
        row.code ? s(`D${r}`, row.code, STYLE.code) : empty(`D${r}`, STYLE.code),
        s(`E${r}`, row.description, STYLE.text),
        row.date ? s(`F${r}`, row.date, STYLE.text) : empty(`F${r}`, STYLE.text),
        `<c r="G${r}" s="${STYLE.rate}"><v>${num(row.rate)}</v></c>`,
        `<c r="H${r}" s="${STYLE.qty}"><v>${num(row.qty)}</v></c>`,
        `<c r="I${r}" s="${STYLE.amount}"><f>G${r}*H${r}</f><v>${num(row.amount)}</v></c>`,
        `<c r="J${r}"><v>0</v></c>`,
        `<c r="K${r}" s="${STYLE.amount}"><f>I${r}-J${r}</f><v>${num(row.amount)}</v></c>`,
      );
    }
    if (t.listRefs.has(r)) {
      cells.push(`<c r="L${r}" t="s"><v>${t.listRefs.get(r)}</v></c>`);
      refs++;
    }
    xmlRows.push(`<row r="${r}">${cells.join('')}</row>`);
  }

  const lastDataRow = Math.max(2, rows.length + 1);
  const sheetXml = t.sheet
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:L${last}"/>`)
    .replace(/<selection [^>]*\/>/, '<selection activeCell="A2" sqref="A2"/>')
    // A function, so a "$" in a description is not read as a replacement pattern.
    .replace(/<sheetData>[\s\S]*<\/sheetData>/, () => `<sheetData>${xmlRows.join('')}</sheetData>`)
    // The Amount check covers the filled rows only, as in a sheet the team filled by hand.
    .replace(/(<dataValidation type="custom"[^>]*sqref=")[^"]*("><formula1>I2<\/formula1>)/, `$1I2:I${lastDataRow}$2`);

  const preserve = (v) => (/^\s|\s$|\s\s|\n/.test(v) ? ' xml:space="preserve"' : '');
  const stringsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${refs + t.otherRefs}" uniqueCount="${strings.length}">`
    + strings.map((v) => `<si><t${preserve(v)}>${escapeXml(v)}</t></si>`).join('')
    + '</sst>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = (t.zip.text(CORE) || '')
    .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>FillPilot</cp:lastModifiedBy>')
    .replace(/(<dcterms:modified[^>]*>)[\s\S]*?(<\/dcterms:modified>)/, `$1${now}$2`);

  const parts = t.zip.names.map((name) => {
    if (name === SHEET) return { name, data: sheetXml };
    if (name === STRINGS) return { name, data: stringsXml };
    if (name === CORE && core) return { name, data: core };
    return { name, data: t.zip.bytes(name) };
  });
  return writeZip(parts);
}

module.exports = { writeSpdclWorkbook };
