// The TG Transco bill file: TG Transco's own blank template (tgtransco-template.xlsx,
// no patient data) with its "Test" sheet filled. Everything else stays as the
// template has it: the Instructions and Example Bill sheets, the dropdown lists
// (Test!M20001:O20013) and their validations, every cell's style, and the
// Amount formula (=+H*I) of the template's rows. Rows are filled from row 2 in the
// template's own cells; S.No. (column A) is the template's. The admission,
// discharge and surgery dates go in its box (N4:N6).
const fs = require('fs');
const path = require('path');
const { openZip, writeZip, sharedStrings, escapeXml } = require('./xlsx');

const TEMPLATE = path.join(__dirname, 'tgtransco-template.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';
const STRINGS = 'xl/sharedStrings.xml';
const WORKBOOK = 'xl/workbook.xml';
const CORE = 'docProps/core.xml';
const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

/** <c r="B2" s="6"/> and <c r="J2" s="42"><f>+H2*I2</f><v>0</v></c> → [{ col, row, style, inner, xml }] */
function cellsOf(rowXml) {
  return [...rowXml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((m) => ({
    col: m[1], row: Number(m[2]), style: /\ss="(\d+)"/.exec(m[3])?.[1] ?? null, inner: m[4] ?? '', xml: m[0],
  }));
}

let template = null;
function loadTemplate() {
  if (template) return template;
  const zip = openZip(fs.readFileSync(TEMPLATE));
  const sheet = zip.text(SHEET);
  const stringsXml = zip.text(STRINGS);
  const strings = sharedStrings(stringsXml);
  const body = /<sheetData>([\s\S]*)<\/sheetData>/.exec(sheet || '')?.[1];
  if (!body) throw new Error('tgtransco-template.xlsx is not the TG Transco template');
  const rows = new Map();
  for (const m of body.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) rows.set(Number(/\sr="(\d+)"/.exec(m[0])[1]), m[0]);
  const text = (cell) => (cell && /t="s"/.test(cell.xml) ? strings[Number(/<v>(\d+)<\/v>/.exec(cell.inner)?.[1])] : null);
  const header = cellsOf(rows.get(1) || '').map(text);
  if (header[3] !== 'Service_Type' || header[4] !== 'Tariff Code' || header[9] !== 'Amount') {
    throw new Error('tgtransco-template.xlsx is not the TG Transco template');
  }
  // The template's rows that carry the Amount formula; rows after the last are built like it.
  const formulaRows = [...rows].filter(([, xml]) => /<c r="J\d+"[^>]*>\s*<f\b/.test(xml)).map(([r]) => r);
  const lastFormulaRow = Math.max(...formulaRows);
  const pattern = new Map(cellsOf(rows.get(lastFormulaRow)).map((c) => [c.col, c.style]));
  // The dropdown lists, under "Dropdown list" (M19999): row 20000 heads them.
  const listHead = [...rows].find(([, xml]) => /<c r="M\d+"/.test(xml) && text(cellsOf(xml).find((c) => c.col === 'M')) === 'TARIFF TYPE')?.[0];
  if (!listHead) throw new Error('tgtransco-template.xlsx has no dropdown lists');
  const lists = { M: [], N: [], O: [] };
  for (let r = listHead + 1; rows.has(r); r++) {
    for (const c of cellsOf(rows.get(r))) if (lists[c.col] && text(c)) lists[c.col].push(text(c));
  }
  // Where the dates go: the cell right of "Date of Admission" / "Discharge" / "surgery".
  const dateCells = {};
  for (const [r, xml] of rows) {
    if (r > 20) break;
    for (const c of cellsOf(xml)) {
      const label = text(c);
      if (/^Date of Admission$/i.test(label || '')) dateCells.admission = r;
      if (/^Date of Discharge$/i.test(label || '')) dateCells.discharge = r;
      if (/^Date of surgery/i.test(label || '')) dateCells.surgery = r;
    }
  }
  if (Object.keys(dateCells).length !== 3) throw new Error('tgtransco-template.xlsx has no Date of Admission / Discharge / surgery box');
  // Text cells in the other sheets, counted for the <sst count>.
  const otherRefs = zip.names
    .filter((n) => /^xl\/worksheets\/.+\.xml$/.test(n) && n !== SHEET)
    .reduce((count, n) => count + (zip.text(n).match(/t="s"/g) || []).length, 0);
  template = {
    zip, sheet, stringsXml, strings, rows, lastFormulaRow, pattern, listHead, dateCells, otherRefs,
    lists: { tariffTypes: lists.M, packages: lists.N, serviceTypes: lists.O },
  };
  return template;
}

const num = (n) => String(Math.round(n * 1e6) / 1e6);
const preserve = (v) => (/^\s|\s$|\s\s|\n/.test(v) ? ' xml:space="preserve"' : '');

/**
 * sheet: buildTgTranscoSheet()'s result → the .xlsx as a Buffer. Row r (from 2):
 * S.No., tariff type, PACKAGE / NON PACKAGE, head, code, service details, date
 * (dd.mm.yyyy text, as the team writes it), rate, quantity, =+H*I.
 */
function writeTgTranscoWorkbook(sheet) {
  const t = loadTemplate();
  const strings = [...t.strings];
  const index = new Map();
  strings.forEach((s, i) => {
    if (!index.has(s)) index.set(s, i);
  });
  const fresh = [];
  const str = (value) => {
    if (!index.has(value)) {
      index.set(value, strings.length);
      strings.push(value);
      fresh.push(value);
    }
    return index.get(value);
  };
  const cell = (ref, style, body = '', type = null) => `<c r="${ref}"${style != null ? ` s="${style}"` : ''}${type ? ` t="${type}"` : ''}${body ? `>${body}</c>` : '/>'}`;
  const textCell = (ref, style, value) => cell(ref, style, `<v>${str(value)}</v>`, 's');

  const rows = new Map(t.rows);
  const lastRow = sheet.rows.length + 1;
  if (lastRow >= t.listHead - 1) throw new Error(`The bill has ${sheet.rows.length} rows — more than TG Transco's template has room for`);

  sheet.rows.forEach((data, i) => {
    const r = i + 2;
    const own = rows.get(r);
    const cells = new Map(cellsOf(own || '').map((c) => [c.col, c]));
    const style = (col) => (r <= t.lastFormulaRow ? cells.get(col)?.style : t.pattern.get(col)) ?? t.pattern.get(col) ?? null;
    // The template's own formula (often a shared one), or the same formula written out.
    const formula = /<f\b[^>]*\/>|<f\b[^>]*>[\s\S]*?<\/f>/.exec(cells.get('J')?.inner || '')?.[0] ?? `<f>+H${r}*I${r}</f>`;
    const code = data.code == null ? null : String(data.code);
    const out = [
      cell(`A${r}`, style('A'), `<v>${r - 1}</v>`),
      textCell(`B${r}`, style('B'), sheet.tariffType),
      textCell(`C${r}`, style('C'), data.packageType),
      textCell(`D${r}`, style('D'), data.head),
      // A code of digits only is a number, as the team's file has it (586, 3055); 415A, 84.4 stay text.
      code == null ? cell(`E${r}`, style('E')) : /^[1-9]\d{0,14}$/.test(code) ? cell(`E${r}`, style('E'), `<v>${code}</v>`) : textCell(`E${r}`, style('E'), code),
      textCell(`F${r}`, style('F'), data.description),
      data.date ? textCell(`G${r}`, style('G'), data.date) : cell(`G${r}`, style('G')),
      cell(`H${r}`, style('H'), `<v>${num(data.rate)}</v>`),
      cell(`I${r}`, style('I'), `<v>${num(data.qty)}</v>`),
      cell(`J${r}`, style('J'), `${formula}<v>${num(data.rate * data.qty)}</v>`),
      // Cells right of the table (the date box in rows 4–6) stay.
      ...[...cells.values()].filter((c) => !COLUMNS.includes(c.col)).map((c) => c.xml),
    ];
    const open = own ? /^<row\b[^>]*?(?=\/?>)/.exec(own)[0] : `<row r="${r}" spans="1:10"`;
    rows.set(r, `${open}>${out.join('')}</row>`);
  });

  // The date box: Date of Admission, Discharge, surgery/Procedure.
  const dates = { admission: sheet.admissionDate, discharge: sheet.dischargeDate, surgery: sheet.surgeryDate };
  for (const [key, r] of Object.entries(t.dateCells)) {
    if (!dates[key]) continue;
    const xml = rows.get(r);
    const n = cellsOf(xml).find((c) => c.col === 'N');
    const filled = textCell(`N${r}`, n?.style ?? null, dates[key]);
    rows.set(r, n ? xml.replace(n.xml, () => filled) : xml.replace(/<\/row>$/, `${filled}</row>`));
  }

  const sheetXml = t.sheet
    // A function, so a "$" in a description is not read as a replacement pattern.
    .replace(/<sheetData>[\s\S]*<\/sheetData>/, () => `<sheetData>${[...rows.keys()].sort((a, b) => a - b).map((r) => rows.get(r)).join('')}</sheetData>`)
    .replace(/<selection [^>]*\/>/, '<selection activeCell="A2" sqref="A2"/>')
    // Rows past the template's own: the Amount check covers them too.
    .replace(/(<dataValidation type="custom"[^>]*sqref=")([^"]*)("><formula1>J2<\/formula1>)/, (m, a, sqref, b) => (
      lastRow > t.lastFormulaRow ? `${a}${sqref} J${t.lastFormulaRow + 1}:J${lastRow}${b}` : m));

  const refs = (sheetXml.match(/t="s"/g) || []).length + t.otherRefs;
  const stringsXml = t.stringsXml
    .replace(/<sst\b[^>]*>/, (tag) => tag.replace(/\scount="\d+"/, '').replace(/\suniqueCount="\d+"/, '').replace(/>$/, ` count="${refs}" uniqueCount="${strings.length}">`))
    .replace(/<\/sst>\s*$/, () => `${fresh.map((v) => `<si><t${preserve(v)}>${escapeXml(v)}</t></si>`).join('')}</sst>`);

  const workbook = t.zip.text(WORKBOOK).replace(/(Test!\$A\$1:\$J\$)(\d+)/, (m, a, last) => (lastRow > Number(last) ? `${a}${lastRow}` : m));

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = (t.zip.text(CORE) || '')
    .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>FillPilot</cp:lastModifiedBy>')
    .replace(/(<dcterms:modified[^>]*>)[\s\S]*?(<\/dcterms:modified>)/, `$1${now}$2`);

  const parts = t.zip.names.map((name) => {
    if (name === SHEET) return { name, data: sheetXml };
    if (name === STRINGS) return { name, data: stringsXml };
    if (name === WORKBOOK) return { name, data: workbook };
    if (name === CORE && core) return { name, data: core };
    return { name, data: t.zip.bytes(name) };
  });
  return writeZip(parts);
}

/** The template's dropdown lists: { tariffTypes, packages, serviceTypes } — the values a row may hold. */
function templateLists() {
  return loadTemplate().lists;
}

module.exports = { writeTgTranscoWorkbook, templateLists };
