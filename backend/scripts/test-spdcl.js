// node scripts/test-spdcl.js — HIS Excel exports → the SPDCL upload file.
// Synthetic bills shaped like the HIS exports (no patient data), the dating
// rules, the checks, and the file itself read back.
const { check, checkTrue, done } = require('./lib/check');
const { readFirstSheet, writeZip, openZip, XlsxError } = require('../src/claims/xlsx');
const spdcl = require('../src/claims/spdcl');
const { writeSpdclWorkbook } = require('../src/claims/spdcl-workbook');

const { HEAD } = spdcl;
const cols = (n) => (...cells) => Array.from({ length: n }, (_, i) => cells[i] ?? null);
const F = cols(8); // final bill: A date, B code, C description, D order no, E count, F rate, G labels, H amount
const P = cols(9); // pharmacy bill: indent, date, item, batch, expiry, qty, price, value, C/F total
const sub = (amount) => F(null, null, null, null, null, null, 'Sub Total...', amount);

function finalRows({ ip = 900001, extra = [], pharmacy = 292.25, grand = 17252.25 } = {}) {
  return [
    F('TEST HOSPITAL'),
    F('Name: MR. TEST  PATIENT', null, null, null, null, null, 'IP No:', ip),
    F(null, 'Code', 'Description', null, 'Value', null, null, 'Charged Amount'),
    F('1. ROOM RENT'),
    F(null, null, 'ROOM RENT', null, '2 Day(s) X', 2000, null, 4000),
    sub(4000),
    F('2. INTENSIVE CARE UNIT'),
    F(null, null, 'ICU BED CHARGE', null, '2 Day(s) X', 5000, null, 10000),
    sub(10000),
    F('3. BED SIDE PROCEDURE CHARGES'),
    F(null, 'CC014', 'RYLES TUBE PLACEMENT', 111, null, null, null, 900),
    sub(900),
    F('4. CARDIOLOGY'),
    F(null, 'CI001', 'E C G', 112, null, null, null, 175),
    F(null, 'CI001', 'E C G', 113, null, null, null, 175),
    sub(350),
    F('5. DOCTOR FEES'),
    F(null, null, 'DOCTOR ONE', 114, '3 Visit(s) X', 350, null, 1050),
    sub(1050),
    F('6. LABORATORY'),
    F(null, null, 'HAEMATOLOGY'),
    F('02/01/2026', 'LB012', 'HAEMOGRAM  (CBP)', 115, null, null, null, 300),
    sub(300),
    F('7. PHARMACY'),
    F(null, null, 'PHARMACY', null, null, null, null, pharmacy),
    sub(pharmacy),
    F('8. RBS WITH GLUCOMETER'),
    F(null, 'LB055', 'RBS WITH GLUCOMETER', 116, '9 Time(s) X', 40, null, 360),
    sub(360),
    ...extra,
    F(null, null, null, null, null, null, 'Grand Total...', grand),
    F(null, null, null, null, null, null, 'Net Amount :', Math.round(grand)),
  ];
}

function pharmacyRows({ ip = 900001, returns = [] } = {}) {
  return [
    P('TEST HOSPITAL'),
    P('PHARMACY DETAILS'),
    P('Name :', 'MR. TEST PATIENT', null, null, null, null, 'IP No:', ip),
    P('Indent No', 'Date', 'Item Description', 'Batch No', 'Expiry Date', 'Qty', 'Price', 'Value', 'C/F Total'),
    P('Item Issues >>>>>>'),
    P(5000001, '01/01/2026'),
    P(null, null, 'SYRINGE 10ML (NIPRO)', 'B1', '31/05/2031', 3, 28.13, 84.39),
    P(null, null, null, null, null, null, null, null, 84.39),
    P(5000002, '05/01/2026'),
    // HIS charges 207.86: the printed price is rounded (34.6433…), so Rate × Qty is 207.84.
    P(null, null, 'ECG ELECTRODES  ADULT', 'B2', '31/12/2030', 6, 34.64, 207.86),
    P(null, null, null, null, null, null, null, null, 207.86),
    ...returns,
    P(null, null, null, null, null, null, null, 'TOTAL ISSUE AMOUNT: 292.25'),
    P(null, null, null, null, null, null, null, 'NET AMOUNT: 292.00'),
    P('Authorized Signatory'),
  ];
}

const build = (opts = {}) => spdcl.buildSpdclSheet({
  final: spdcl.parseFinalBill(opts.final ?? finalRows()),
  pharmacy: opts.noPharmacy ? null : spdcl.parsePharmacyBill(opts.pharmacy ?? pharmacyRows()),
  admissionDate: opts.admissionDate ?? null,
});
const pick = (sheet, test) => sheet.rows.filter(test);
const by = (sheet, description) => pick(sheet, (r) => r.description === description);

// ── recognising the files ───────────────────────────────────────────────
check('final bill recognised by "Charged Amount"', spdcl.isFinalBill({ sheetName: 'Sheet1', rows: finalRows() }), true);
check('pharmacy bill recognised by "PHARMACY DETAILS"', spdcl.isPharmacyBill({ sheetName: 'Sheet1', rows: pharmacyRows() }), true);
check('the pharmacy bill is not taken for a final bill', spdcl.isFinalBill({ sheetName: 'Pharmacy Bill', rows: pharmacyRows() }), false);

// ── reading them ────────────────────────────────────────────────────────
const final = spdcl.parseFinalBill(finalRows());
check('final bill: patient and IP', final.patient, { name: 'MR. TEST PATIENT', ipNo: '900001' });
check('final bill: sections in order', final.sections.map((s) => s.name), ['ROOM RENT', 'INTENSIVE CARE UNIT', 'BED SIDE PROCEDURE CHARGES', 'CARDIOLOGY', 'DOCTOR FEES', 'LABORATORY', 'PHARMACY', 'RBS WITH GLUCOMETER']);
check('final bill: count and rate read from "2 Day(s) X"', [final.sections[0].items[0].count, final.sections[0].items[0].unit, final.sections[0].items[0].rate], [2, 'day', 2000]);
check('final bill: description kept as printed (inner spaces)', final.sections[5].items[0].description, 'HAEMOGRAM  (CBP)');
check('final bill: totals, no issues', [final.grandTotal, final.netAmount, final.issues], [17252.25, 17252, []]);
const pharmacy = spdcl.parsePharmacyBill(pharmacyRows());
check('pharmacy bill: items with their indent date', pharmacy.items.map((i) => [spdcl.dateText(i.date), i.description, i.qty, i.price, i.value]), [
  ['01/01/2026', 'SYRINGE 10ML (NIPRO)', 3, 28.13, 84.39],
  ['05/01/2026', 'ECG ELECTRODES  ADULT', 6, 34.64, 207.86],
]);
check('pharmacy bill: total issue amount, IP', [pharmacy.issueTotal, pharmacy.patient.ipNo], [292.25, '900001']);

// ── the rows ────────────────────────────────────────────────────────────
const sheet = build();
check('admission = earliest date on the bills, said so', [sheet.admissionDate, sheet.admissionAssumed, sheet.lastDate, sheet.stayDays], ['01/01/2026', true, '05/01/2026', 4]);
check('ICU days first, from admission', by(sheet, 'ICU BED CHARGE').map((r) => [r.head, r.date, r.rate, r.qty]), [
  [HEAD.icu, '01/01/2026', 5000, 1], [HEAD.icu, '02/01/2026', 5000, 1],
]);
check('room rent after the ICU days', by(sheet, 'ROOM RENT').map((r) => [r.head, r.date, r.rate, r.qty]), [
  [HEAD.room, '03/01/2026', 2000, 1], [HEAD.room, '04/01/2026', 2000, 1],
]);
check('doctor visits: one row per doctor, Qty = the visits, dated from admission', by(sheet, 'DOCTOR ONE').map((r) => [r.head, r.date, r.rate, r.qty, r.amount, r.code]), [
  [HEAD.consultation, '01/01/2026', 350, 3, 1050, null],
]);
check('N Time(s) spread over the stay, remainder first (9 over 4 days)', by(sheet, 'RBS WITH GLUCOMETER').map((r) => [r.date, r.qty, r.amount]), [
  ['01/01/2026', 3, 120], ['02/01/2026', 2, 80], ['03/01/2026', 2, 80], ['04/01/2026', 2, 80],
]);
check('the same undated item again goes on the next day', by(sheet, 'E C G').map((r) => [r.head, r.code, r.date]), [
  [HEAD.investigations, 'CI001', '01/01/2026'], [HEAD.investigations, 'CI001', '02/01/2026'],
]);
check('bed side procedures go under "Emergency  " (two spaces, as SPDCL\'s list)', by(sheet, 'RYLES TUBE PLACEMENT').map((r) => [r.head, r.date, r.rate]), [['Emergency  ', '01/01/2026', 900]]);
check('a dated line keeps its date', by(sheet, 'HAEMOGRAM  (CBP)').map((r) => [r.date, r.rate, r.qty]), [['02/01/2026', 300, 1]]);
check('the final bill\'s pharmacy total is not a row', by(sheet, 'PHARMACY'), []);
check('pharmacy items last, on their indent date, Amount = Rate × Qty', sheet.rows.slice(-2).map((r) => [r.head, r.date, r.rate, r.qty, r.amount]), [
  [HEAD.pharmacy, '01/01/2026', 28.13, 3, 84.39],
  [HEAD.pharmacy, '05/01/2026', 34.64, 6, 207.84],
]);
check('rows follow the bill: room, ICU, bed side, cardiology, doctors, lab, RBS, pharmacy', [...new Set(sheet.rows.map((r) => r.section))],
  ['ROOM RENT', 'INTENSIVE CARE UNIT', 'BED SIDE PROCEDURE CHARGES', 'CARDIOLOGY', 'DOCTOR FEES', 'LABORATORY', 'RBS WITH GLUCOMETER', 'Pharmacy']);
check('totals: the rounding gap is explained, nothing else to check', [sheet.totals, sheet.checks.map((c) => c.level)], [
  { excel: 17252.23, hisBill: 17252.25, netAmount: 17252, pharmacyBill: 292.25, difference: 0.02 }, ['info', 'info'],
]);
checkTrue('the rounding note names the cause', sheet.checks.some((c) => /rounded to paise/.test(c.message)));
check('heads: rows and amount per head, first seen first', sheet.heads.map((h) => [h.head, h.rows, h.amount]), [
  [HEAD.room, 2, 4000], [HEAD.icu, 2, 10000], ['Emergency  ', 1, 900], [HEAD.investigations, 7, 1010], [HEAD.consultation, 1, 1050], [HEAD.pharmacy, 2, 292.23],
]);

// ── doctors: a row per doctor (the client, 2026-11-13) ─────────────────
const visits = build({ final: finalRows({ grand: 18802.25, extra: [
  F('9. CONSULTATION CHARGES'),
  F('03/01/2026', null, 'DOCTOR TWO', null, null, null, null, 350),
  F('02/01/2026', null, 'DOCTOR TWO', null, null, null, null, 350),
  F('04/01/2026', null, 'DOCTOR TWO', null, null, null, null, 500),
  F('05/01/2026', null, 'DOCTOR  ONE', null, null, null, null, 350),
  sub(1550),
] }) });
check('doctors: visits join per doctor and rate, dated the first visit, Amount = Rate × Qty', pick(visits, (r) => r.head === HEAD.consultation).map((r) => [r.description, r.date, r.rate, r.qty, r.amount]), [
  ['DOCTOR ONE', '01/01/2026', 350, 4, 1400],
  ['DOCTOR TWO', '02/01/2026', 350, 2, 700],
  ['DOCTOR TWO', '04/01/2026', 500, 1, 500],
]);
check('doctors: the Excel total still matches the bill', [visits.totals.excel, visits.totals.difference, visits.checks.map((c) => c.level)], [18802.23, 0.02, ['info', 'info']]);
check('doctors: the head counts the joined rows', visits.heads.find((h) => h.head === HEAD.consultation), { head: HEAD.consultation, rows: 3, amount: 2600 });
check('doctors: other heads keep a row a day', by(visits, 'E C G').length, 2);

// ── the person's admission date ─────────────────────────────────────────
const earlier = build({ admissionDate: '31/12/2025' });
check('an admission date typed moves the undated rows', [earlier.admissionAssumed, by(earlier, 'ICU BED CHARGE')[0].date, by(earlier, 'ROOM RENT')[0].date, by(earlier, 'E C G')[0].date],
  [false, '31/12/2025', '02/01/2026', '31/12/2025']);
checkTrue('an admission after the first bill date is flagged', build({ admissionDate: '05/01/2026' }).checks.some((c) => c.level === 'warning' && /after the earliest date/.test(c.message)));

// ── checks ──────────────────────────────────────────────────────────────
checkTrue('different IP numbers are an error', build({ pharmacy: pharmacyRows({ ip: 900002 }) }).checks.some((c) => c.level === 'error' && /different patients/.test(c.message)));
checkTrue('no pharmacy bill: its total missing is an error', build({ noPharmacy: true }).checks.some((c) => c.level === 'error' && /no pharmacy bill was chosen/.test(c.message)));
checkTrue('pharmacy bill not matching the final bill is an error', build({ final: finalRows({ pharmacy: 300, grand: 17260 }) }).checks.some((c) => c.level === 'error' && /pharmacy bill comes to 292.25/.test(c.message)));

const newSection = build({ final: finalRows({ grand: 17352.25, extra: [F('9. DIETARY SERVICES'), F(null, null, 'DIET', null, null, null, null, 100), sub(100)] }) });
check('a section never seen goes under Investigations', by(newSection, 'DIET').map((r) => [r.head, r.date]), [[HEAD.investigations, '01/01/2026']]);
checkTrue('… and is flagged', newSection.checks.some((c) => c.level === 'warning' && /DIETARY SERVICES/.test(c.message)));

const odd = build({ final: finalRows({ grand: 17752.25, extra: [F('9. OXYGEN'), F(null, 'CC002', 'OXYGEN', null, '2 Day(s) X', 300, null, 500), sub(500)] }) });
check('count × rate ≠ amount: one row of the amount', by(odd, 'OXYGEN').map((r) => [r.date, r.rate, r.qty]), [['01/01/2026', 500, 1]]);
checkTrue('… with a warning', odd.checks.some((c) => c.level === 'warning' && /is not the charged 500/.test(c.message)));

const subTotal = spdcl.parseFinalBill(finalRows().map((r) => (r[6] === 'Sub Total...' && r[7] === 900 ? sub(950) : r)));
checkTrue('a Sub Total that is not its lines is flagged', subTotal.issues.some((i) => /BED SIDE PROCEDURE CHARGES/.test(i.message)));

const withReturns = build({
  final: finalRows({ pharmacy: 262.25, grand: 17222.25 }),
  pharmacy: pharmacyRows({ returns: [P('Item Returns >>>>>>'), P(5000003, '03/01/2026'), P(null, null, 'NS 100ML', 'B3', '01/01/2030', 1, 30, 30)] }),
});
check('returns go under Pharmacy/Drugs/Medicine Returns', by(withReturns, 'NS 100ML').map((r) => [r.head, r.date, r.amount]), [[HEAD.pharmacyReturns, '03/01/2026', 30]]);
checkTrue('… flagged, and netted against the final bill\'s pharmacy', withReturns.checks.some((c) => /has returns/.test(c.message)) && !withReturns.checks.some((c) => c.level === 'error'));

// ── dates ───────────────────────────────────────────────────────────────
check('dates: dd/mm/yyyy, impossible dates, Excel serials', [spdcl.dayOf('31/02/2026'), spdcl.dateText(spdcl.dayOf('1/2/2026')), spdcl.dateText(spdcl.dayOf(46023))], [null, '01/02/2026', '01/01/2026']);

// ── the file ────────────────────────────────────────────────────────────
const file = writeSpdclWorkbook(sheet);
const back = readFirstSheet(file);
check('file: first sheet is "Test", headers as SPDCL\'s template', [back.sheetName, back.rows[0].slice(0, 12)], ['Test', [
  'TARIFF_TYPE', 'Bill Type', 'Service_Type', 'Tariff Code/Hopsital Code', 'Package/Service Name', 'Date (dd/mm/yyyy)',
  'Rate', 'Quntity', 'Amount', 'Discount', 'Total Amount', 'Accomodation',
]]);
check('file: every row as built — tariff, Service, head, code, name, text date, rate, qty, amount, 0, total',
  back.rows.slice(1, sheet.rows.length + 1).map((r) => r.slice(0, 11)),
  sheet.rows.map((r) => ['EHS', 'Service', r.head, r.code, r.description, r.date, r.rate, r.qty, r.amount, 0, r.amount]));
check('file: nothing after the last row but column L\'s list', back.rows.slice(sheet.rows.length + 1).every((r) => r.slice(0, 11).every((v) => v == null)), true);
check('file: column L keeps the template\'s list (L2:L33)', [back.rows[1][11], back.rows[32][11], back.rows.length], ['Assistant Surgeon Fee', 'Ward Pharmacy', 33]);

const zip = openZip(file);
const xml = zip.text('xl/worksheets/sheet1.xml');
checkTrue('file: Namelist and the Heads sheet are kept', /<definedName name="Namelist">Heads!\$B\$4:\$B\$18<\/definedName>/.test(zip.text('xl/workbook.xml')) && zip.names.includes('xl/worksheets/sheet2.xml'));
checkTrue('file: dropdowns kept; the Amount check covers the filled rows', xml.includes('<formula1>Namelist</formula1>') && xml.includes('&quot;Package,Service&quot;') && xml.includes(`sqref="I2:I${sheet.rows.length + 1}"`));
checkTrue('file: column L hidden', /<col min="12" max="12"[^>]*hidden="1"/.test(xml));
checkTrue('file: Amount and Total are formulas', xml.includes('<f>G2*H2</f>') && xml.includes('<f>I2-J2</f>'));
checkTrue('file: "Emergency  " keeps its spaces', zip.text('xl/sharedStrings.xml').includes('<t xml:space="preserve">Emergency  </t>'));
// With "Test" taken out of the sheet list, the reader opens "Heads": its strings still point at the right entries.
const headsOnly = writeZip(zip.names.map((name) => ({
  name,
  data: name === 'xl/workbook.xml' ? zip.text(name).replace(/<sheet name="Test"[^>]*\/>/, '') : zip.bytes(name),
})));
check('file: the Heads sheet still finds its strings', readFirstSheet(headsOnly).rows.slice(3, 20).map((r) => r[1]), [
  'Emergency  ', 'Hospital Services', HEAD.pharmacy, HEAD.pharmacyReturns, HEAD.icu, HEAD.room, HEAD.investigations,
  'Invasive/Non-Invasive Procedures', 'Surgery Charges', 'Procedure Charges', 'Packages', HEAD.bloodBank, 'Disposables',
  HEAD.consultation, 'Implants / Medical Appliances', 'Medical Equipment', 'Other Hospital Services',
]);
const tariff = readFirstSheet(writeSpdclWorkbook({ ...sheet, tariffType: 'CGHS' })).rows[1][0];
check('file: the tariff type chosen goes in column A', tariff, 'CGHS');

// ── the reader on its own ───────────────────────────────────────────────
const tiny = writeZip([
  { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S &amp; 1" sheetId="1" r:id="rId9"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Target="/xl/worksheets/data.xml" Id="rId9"/></Relationships>' },
  { name: 'xl/sharedStrings.xml', data: '<sst><si/><si><t xml:space="preserve"> a &lt;b&gt; </t></si><si><r><t>rich</t></r><r><t xml:space="preserve"> text</t></r><rPh><t>x</t></rPh></si></sst>' },
  { name: 'xl/worksheets/data.xml', data: '<worksheet><sheetData><row r="2"><c r="B2" t="s"><v>1</v></c><c t="s"><v>2</v></c><c r="E2" t="inlineStr"><is><t>in&#8377;line_x000D_</t></is></c></row><row><c r="A3"><v>12.5</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="str"><f>A3</f><v>formula</v></c><c r="D3" t="s"><v>0</v></c></row></sheetData></worksheet>' },
]);
const read = readFirstSheet(tiny);
check('reader: sheet found through the relationship, entities decoded', read.sheetName, 'S & 1');
check('reader: shared, rich and inline strings; cells without r; numbers, booleans, formula results', read.rows, [
  [],
  [null, ' a <b> ', 'rich text', null, 'in₹line\r'],
  [12.5, true, 'formula', null],
]);
// A byte changed inside a part the reader needs (workbook.xml's packed data follows its name).
const damaged = Buffer.from(file);
damaged[file.indexOf('xl/workbook.xml') + 'xl/workbook.xml'.length + 4] ^= 0xff;
const threw = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof XlsxError ? 'XlsxError' : String(err);
  }
};
check('reader: a damaged file is refused as such', threw(() => readFirstSheet(damaged)), 'XlsxError');
check('reader: not a zip is refused as such', threw(() => readFirstSheet(Buffer.from('not an excel file at all'))), 'XlsxError');

done('spdcl');
