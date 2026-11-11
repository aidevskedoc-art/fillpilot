// The TGNPDCL Pharmacy tab's upload file: the site's own blank template
// (tgnpdcl-pharmacy-template.xlsx, from its "Download Template" button, no
// patient data) with its "Pharmacy" sheet filled. The header row stays as the
// template has it; then one row per item: Date of utilization (yyyy-mm-dd text,
// as the template's own sample row), the item's name, Amount per item, Qty.
const fs = require('fs');
const path = require('path');
const { openZip, writeZip, escapeXml } = require('./xlsx');

const TEMPLATE = path.join(__dirname, 'tgnpdcl-pharmacy-template.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';

let template = null;
function loadTemplate() {
  if (template) return template;
  const zip = openZip(fs.readFileSync(TEMPLATE));
  const sheet = zip.text(SHEET);
  const header = /<row r="1"[\s\S]*?<\/row>/.exec(sheet || '')?.[0];
  if (!header || !/Date of utilization/.test(header)) throw new Error('tgnpdcl-pharmacy-template.xlsx is not the TGNPDCL pharmacy template');
  template = { zip, sheet, header };
  return template;
}

const num = (n) => String(Math.round(n * 1e6) / 1e6);
/** A text cell written inline, as the template writes its own. */
const text = (ref, value) => `<c r="${ref}" t="inlineStr"><is><t${/^\s|\s$|\s\s/.test(value) ? ' xml:space="preserve"' : ''}>${escapeXml(value)}</t></is></c>`;

/** rows: the claim's Pharmacy tab rows ({ date, name, rate, qty }) → the .xlsx as a Buffer. */
function writeTgnpdclPharmacyWorkbook(rows) {
  const t = loadTemplate();
  const xmlRows = [
    t.header,
    ...rows.map((row, i) => {
      const r = i + 2;
      return `<row r="${r}">${row.date ? text(`A${r}`, row.date) : `<c r="A${r}"/>`}${text(`B${r}`, row.name)}`
        + `<c r="C${r}" t="n"><v>${num(row.rate)}</v></c><c r="D${r}" t="n"><v>${num(row.qty)}</v></c></row>`;
    }),
  ];
  const sheetXml = t.sheet
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:D${rows.length + 1}"/>`)
    // A function, so a "$" in an item's name is not read as a replacement pattern.
    .replace(/<sheetData>[\s\S]*<\/sheetData>/, () => `<sheetData>${xmlRows.join('')}</sheetData>`);
  return writeZip(t.zip.names.map((name) => ({ name, data: name === SHEET ? sheetXml : t.zip.bytes(name) })));
}

module.exports = { writeTgnpdclPharmacyWorkbook };
