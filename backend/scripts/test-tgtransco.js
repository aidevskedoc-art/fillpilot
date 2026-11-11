// node scripts/test-tgtransco.js — HIS Excel exports → TG Transco's bill file.
// Synthetic bills shaped like the HIS exports and the team's file for IP 122609
// (no patient data): heads, package, codes, dates, the checks, and the file read back.
const { check, checkTrue, done } = require('./lib/check');
const { readFirstSheet, openZip } = require('../src/claims/xlsx');
const spdcl = require('../src/claims/spdcl');
const tgtransco = require('../src/claims/tgtransco');
const { writeTgTranscoWorkbook, templateLists } = require('../src/claims/tgtransco-workbook');

const { HEAD, PACKAGE, NON_PACKAGE, ROOM_TEXT } = tgtransco;
const cols = (n) => (...cells) => Array.from({ length: n }, (_, i) => cells[i] ?? null);
const F = cols(8); // final bill: A date, B code, C description, D order no, E count, F rate, G labels, H amount
const P = cols(9); // pharmacy bill: indent, date, item, batch, expiry, qty, price, value, C/F total
const sub = (amount) => F(null, null, null, null, null, null, 'Sub Total...', amount);

function finalRows({ ip = 900001, surgeryDate = null, extra = [], grand = 25339.05 } = {}) {
  return [
    F('TEST HOSPITAL'),
    F('Name: MR. TEST  PATIENT', null, null, null, null, null, 'IP No:', ip),
    F(null, 'Code', 'Description', null, 'Value', null, null, 'Charged Amount'),
    F('1. ROOM RENT'),
    F(null, null, 'ROOM RENT', null, '2 Day(s) X', 3000, null, 6000),
    sub(6000),
    F('2. BLOOD TRANSFUSION'),
    // No rate printed: 1 unit of the amount.
    F(null, '586/COMM', 'BLOOD COMPONENT TRANSFUSION CHARGES', null, '1 Unit(s) X', null, null, 713),
    sub(713),
    F('3. CARDIOLOGY'),
    F(null, '3056/NIMS', '2D ECHO', null, '', null, null, 750),
    F(null, '3055/NIMS', 'E C G', null, '', null, null, 75),
    F(null, '3055/NIMS', 'E C G', null, '', null, null, 75),
    sub(900),
    F('4. DOCTOR FEES'),
    F(null, null, 'DOCTOR ONE', null, '2 Visit(s) X', 350, null, 700),
    F(null, null, 'DR. DOCTOR TWO', null, '1 Visit(s) X', 350, null, 350),
    sub(1050),
    F('5. LABORATORY'),
    F(null, null, 'HAEMATOLOGY'),
    F('01/01/2026', '423A/NIMS', 'HAEMOGRAM', null, '', null, null, 225),
    F('04/01/2026', '13A/NIMS', 'UREA WITH BUN', null, '', null, null, 105),
    sub(330),
    F('6. PHARMACY'),
    F(null, null, 'PHARMACY', null, null, null, null, 354.05),
    sub(354.05),
    F('7. RADIOLOGY'),
    F('02/01/2026', 'R171+R171/NIM', 'RADIOGRAPH KNEE AP & LAT', null, '', null, null, 450),
    sub(450),
    F('8. SURGERY CHARGES'),
    F(surgeryDate, 'S5.1.17', 'ORIF RIGHT HIP', null, '', null, null, 12000),
    sub(12000),
    F('9. MEDICAL APPLIANCES'),
    F(null, null, 'COST OF IMPLANTS ', null, '', null, null, 3542),
    sub(3542),
    ...extra,
    F(null, null, null, null, null, null, 'Grand Total...', grand),
    F(null, null, null, null, null, null, 'Net Amount :', Math.round(grand)),
  ];
}

function pharmacyRows({ ip = 900001 } = {}) {
  return [
    P('TEST HOSPITAL'),
    P('PHARMACY DETAILS'),
    P('Name :', 'MR. TEST PATIENT', null, null, null, null, 'IP No:', ip),
    P('Indent No', 'Date', 'Item Description', 'Batch No', 'Expiry Date', 'Qty', 'Price', 'Value', 'C/F Total'),
    P('Item Issues >>>>>>'),
    P(5000001, '02/01/2026'),
    P(null, null, 'PROFUSE -100ML (PARACETAMOL 1%) IV', 'B1', '31/03/2028', 0.5, 411, 205.5),
    // The printed price is rounded: 34.64 × 3 = 103.92, the value 103.93.
    P(null, null, 'ECG ELECTRODES ADULT', 'B2', '29/02/2028', 3, 34.64, 103.93),
    P(null, null, null, null, null, null, null, null, 309.43),
    P(5000002, '03/01/2026'),
    P(null, null, 'SYRINGE 10ML', 'B3', '30/04/2031', 1, 44.62, 44.62),
    P(null, null, null, null, null, null, null, null, 44.62),
    P(null, null, null, null, null, null, null, 'TOTAL ISSUE AMOUNT: 354.05'),
    P(null, null, null, null, null, null, null, 'NET AMOUNT: 354.00'),
    P('Authorized Signatory'),
  ];
}

const build = (opts = {}) => tgtransco.buildTgTranscoSheet({
  final: spdcl.parseFinalBill(opts.final ?? finalRows()),
  pharmacy: opts.noPharmacy ? null : spdcl.parsePharmacyBill(opts.pharmacy ?? pharmacyRows()),
  admissionDate: opts.admissionDate ?? null,
  dischargeDate: 'dischargeDate' in opts ? opts.dischargeDate : '06/01/2026',
  surgeryDate: 'surgeryDate' in opts ? opts.surgeryDate : '03/01/2026',
  tariffType: opts.tariffType,
});
const by = (sheet, description) => sheet.rows.filter((r) => r.description === description);
const cells = (r) => [r.packageType, r.head, r.code, r.description, r.date, r.rate, r.qty];

// ── heads and codes ─────────────────────────────────────────────────────
check('sections → TG Transco heads', [
  'ROOM RENT', 'INTENSIVE CARE UNIT', 'DOCTOR FEES', 'CARDIOLOGY', 'LABORATORY', 'RADIOLOGY', 'SURGICAL PATHOLOGY', 'SURGERY CHARGES',
  'MEDICAL APPLIANCES', 'PHARMACY', 'BLOOD TRANSFUSION', 'CATHETERIZATION CHARGES', 'OXYGEN', 'DIETARY SERVICES',
].map((s) => tgtransco.headOf(s)), [
  { head: HEAD.room, known: true }, { head: HEAD.icu, known: true }, { head: HEAD.consultation, known: true },
  { head: HEAD.investigations, known: true }, { head: HEAD.investigations, known: true }, { head: HEAD.investigations, known: true },
  { head: HEAD.investigations, known: true }, { head: HEAD.surgery, known: true }, { head: HEAD.implants, known: true },
  { head: HEAD.pharmacy, known: true }, { head: HEAD.others, known: true }, { head: HEAD.others, known: true },
  { head: HEAD.others, known: true }, { head: HEAD.others, known: false },
]);
check('codes lose their tariff mark', ['3055/NIMS', '415A/NIMS', 'R171+R171/NIM', '586/COMM', '2251/COMM.', '327A+328A', 'S5.1.17', '84.4', ' 12C / NIMS ', null]
  .map(tgtransco.tariffCode), ['3055', '415A', 'R171+R171', '586', '2251', '327A+328A', 'S5.1.17', '84.4', '12C', null]);
const lists = templateLists();
checkTrue('every head, tariff type and package is in the template\'s dropdown lists',
  Object.values(HEAD).every((h) => lists.serviceTypes.includes(h)) && tgtransco.TARIFF_TYPES.every((t) => lists.tariffTypes.includes(t))
  && [PACKAGE, NON_PACKAGE].every((p) => lists.packages.includes(p)));

// ── the rows ────────────────────────────────────────────────────────────
const sheet = build();
check('dates: admission the earliest on the bills; discharge and surgery as typed, dd.mm.yyyy',
  [sheet.admissionDate, sheet.admissionAssumed, sheet.dischargeDate, sheet.surgeryDate, sheet.surgeryAssumed, sheet.tariffType],
  ['01.01.2026', true, '06.01.2026', '03.01.2026', false, 'EHS SUPERSPECIALITY']);
check('room rent: a row a day from admission, in the team\'s words', by(sheet, ROOM_TEXT).map(cells), [
  [NON_PACKAGE, HEAD.room, null, ROOM_TEXT, '01.01.2026', 3000, 1],
  [NON_PACKAGE, HEAD.room, null, ROOM_TEXT, '02.01.2026', 3000, 1],
]);
check('blood transfusion: OTHERS, code 586, no rate printed → one unit of the amount', by(sheet, 'BLOOD COMPONENT TRANSFUSION CHARGES').map(cells), [
  [NON_PACKAGE, HEAD.others, '586', 'BLOOD COMPONENT TRANSFUSION CHARGES', '01.01.2026', 713, 1],
]);
check('a test billed twice without a date: both on the admission day', by(sheet, 'E C G').map(cells), [
  [NON_PACKAGE, HEAD.investigations, '3055', 'E C G', '01.01.2026', 75, 1],
  [NON_PACKAGE, HEAD.investigations, '3055', 'E C G', '01.01.2026', 75, 1],
]);
check('doctors: "Dr." before the name, a row a visit from admission', sheet.rows.filter((r) => r.head === HEAD.consultation).map((r) => [r.description, r.date, r.qty]), [
  ['Dr.DOCTOR ONE', '01.01.2026', 1], ['Dr.DOCTOR ONE', '02.01.2026', 1], ['DR. DOCTOR TWO', '01.01.2026', 1],
]);
check('surgery and implants: PACKAGE, on the date of surgery', sheet.rows.filter((r) => r.head === HEAD.surgery || r.head === HEAD.implants).map(cells), [
  [PACKAGE, HEAD.surgery, 'S5.1.17', 'ORIF RIGHT HIP', '03.01.2026', 12000, 1],
  [PACKAGE, HEAD.implants, null, 'COST OF IMPLANTS', '03.01.2026', 3542, 1],
]);
check('a row dated on or after the date of surgery is PACKAGE too', [by(sheet, 'HAEMOGRAM')[0].packageType, by(sheet, 'UREA WITH BUN')[0].packageType, by(sheet, 'SYRINGE 10ML')[0].packageType],
  [NON_PACKAGE, PACKAGE, PACKAGE]);
check('pharmacy: every item under PHARMACY on its indent date; a rounded price becomes value ÷ qty to 3 decimals', sheet.rows.filter((r) => r.section === 'Pharmacy').map(cells), [
  [NON_PACKAGE, HEAD.pharmacy, null, 'PROFUSE -100ML (PARACETAMOL 1%) IV', '02.01.2026', 411, 0.5],
  [NON_PACKAGE, HEAD.pharmacy, null, 'ECG ELECTRODES ADULT', '02.01.2026', 34.643, 3],
  [PACKAGE, HEAD.pharmacy, null, 'SYRINGE 10ML', '03.01.2026', 44.62, 1],
]);
check('the final bill\'s pharmacy total is not a row', by(sheet, 'PHARMACY'), []);
check('totals: the bill to the paisa; the package part', [sheet.totals.excel, sheet.totals.hisBill, sheet.totals.difference, sheet.totals.package], [25339.05, 25339.05, 0, 15691.62]);
check('checks: admission assumed, joined codes, package by date — nothing to fix', sheet.checks.map((c) => c.level), ['info', 'info', 'info']);
checkTrue('… the joined code is named', sheet.checks.some((c) => /R171\+R171: more than one code/.test(c.message)));
checkTrue('… and the rows made PACKAGE by date are counted', sheet.checks.some((c) => /^2 row\(s\) dated on or after the date of surgery \(03\.01\.2026\)/.test(c.message)));

// ── dates the person has not given ──────────────────────────────────────
const bare = build({ dischargeDate: null, surgeryDate: null });
check('no surgery date: surgery and implant rows without a date, still PACKAGE; nothing else PACKAGE',
  [bare.surgeryDate, bare.rows.filter((r) => r.packageType === PACKAGE).map((r) => [r.head, r.date])], [null, [[HEAD.surgery, null], [HEAD.implants, null]]]);
checkTrue('… and both dates asked for', bare.checks.some((c) => c.level === 'warning' && /Enter the date of surgery/.test(c.message))
  && bare.checks.some((c) => c.level === 'warning' && /Enter the date of discharge/.test(c.message)));
const dated = build({ final: finalRows({ surgeryDate: '03/01/2026' }), surgeryDate: null });
check('surgery date taken from a dated surgery line, said so', [dated.surgeryDate, dated.surgeryAssumed, by(dated, 'COST OF IMPLANTS')[0].date], ['03.01.2026', true, '03.01.2026']);
checkTrue('… as an info line', dated.checks.some((c) => c.level === 'info' && /Date of surgery taken as 03\.01\.2026/.test(c.message)));
checkTrue('discharge before the last row is flagged', build({ dischargeDate: '02/01/2026' }).checks.some((c) => c.level === 'warning' && /run past the date of discharge \(02\.01\.2026\)/.test(c.message)));
checkTrue('surgery before admission is flagged', build({ admissionDate: '02/01/2026', surgeryDate: '01/01/2026' }).checks.some((c) => /before the admission date/.test(c.message)));

// ── checks shared with SPDCL ────────────────────────────────────────────
checkTrue('different IP numbers are an error', build({ pharmacy: pharmacyRows({ ip: 900002 }) }).checks.some((c) => c.level === 'error' && /different patients/.test(c.message)));
checkTrue('no pharmacy bill: an error naming TG Transco', build({ noPharmacy: true }).checks.some((c) => c.level === 'error' && /missing from the TG Transco Excel/.test(c.message)));
const fresh = build({ final: finalRows({ grand: 25439.05, extra: [F('10. DIETARY SERVICES'), F(null, null, 'DIET', null, null, null, null, 100), sub(100)] }) });
check('a section never seen goes under OTHERS, flagged', [by(fresh, 'DIET').map((r) => r.head), fresh.checks.some((c) => c.level === 'warning' && /DIETARY SERVICES.*OTHERS/.test(c.message))], [[HEAD.others], true]);
const uncoded = build({ final: finalRows({ grand: 25439.05, extra: [F('10. LABORATORY'), F('01/01/2026', null, 'CRP', null, '', null, null, 100), sub(100)] }) });
checkTrue('an investigation without a code is flagged', uncoded.checks.some((c) => c.level === 'warning' && /tariff code on every investigation — "CRP"/.test(c.message)));
check('the tariff type chosen is kept; one not in the list falls back', [build({ tariffType: 'NIMS 2015' }).tariffType, build({ tariffType: 'EHS' }).tariffType], ['NIMS 2015', 'EHS SUPERSPECIALITY']);

// ── the file ────────────────────────────────────────────────────────────
const file = writeTgTranscoWorkbook(sheet);
const back = readFirstSheet(file);
check('file: first sheet "Test", the template\'s headers', [back.sheetName, back.rows[0].slice(0, 10)], ['Test', [
  'S.No.', 'TARIFF_TYPE', 'Package/Non-Package', 'Service_Type', 'Tariff Code', 'Service Details', 'Service Date (dd.mm.yyyy)', 'Unit Rate', 'Quantity', 'Amount',
]]);
const numeric = (code) => (code != null && /^[1-9]\d*$/.test(code) ? Number(code) : code);
check('file: every row as built — S.No., tariff, package, head, code (digits as a number), details, date, rate, qty, amount',
  back.rows.slice(1, sheet.rows.length + 1).map((r) => r.slice(0, 10)),
  sheet.rows.map((r, i) => [i + 1, 'EHS SUPERSPECIALITY', r.packageType, r.head, numeric(r.code), r.description, r.date, r.rate, r.qty, Math.round(r.rate * r.qty * 1e6) / 1e6]));
check('file: the date box', [3, 4, 5].map((r) => back.rows[r].slice(12, 14)), [
  ['Date of Admission', '01.01.2026'], ['Date of Discharge', '06.01.2026'], ['Date of surgery/Procedure', '03.01.2026'],
]);
check('file: after the last row, only the template\'s S.No. and empty Amounts', back.rows.slice(sheet.rows.length + 1, 566).every((r, i) => r[0] === sheet.rows.length + i + 1 && r.slice(1, 9).every((v) => v == null) && r[9] === 0), true);
check('file: the dropdown lists stay (Excel rows 20001–20013)', [back.rows[20000].slice(12, 15), back.rows[20012][14]], [['CGHS NABH', 'PACKAGE', 'CONSULTATION'], 'OTHERS']);
const zip = openZip(file);
const xml = zip.text('xl/worksheets/sheet1.xml');
// Row 2 the first room-rent day (3000), row 4 the blood transfusion (713, the template's shared formula).
checkTrue('file: Amount is the template\'s formula, its own value cached', xml.includes('<c r="J2" s="42"><f>+H2*I2</f><v>3000</v></c>') && /<c r="J4" s="42"><f t="shared" si="0"\/><v>713<\/v><\/c>/.test(xml));
checkTrue('file: the Instructions and Example Bill sheets are kept', zip.names.includes('xl/worksheets/sheet2.xml') && zip.names.includes('xl/worksheets/sheet3.xml')
  && /<sheet name="Instructions"/.test(zip.text('xl/workbook.xml')));
checkTrue('file: text with double spaces keeps them', writeTgTranscoWorkbook({ ...sheet, rows: [{ ...sheet.rows[0], description: 'HEPATITIS B SURFACE  ANTIGEN' }] }).length > 0
  && readFirstSheet(writeTgTranscoWorkbook({ ...sheet, rows: [{ ...sheet.rows[0], description: 'HEPATITIS B SURFACE  ANTIGEN' }] })).rows[1][5] === 'HEPATITIS B SURFACE  ANTIGEN');
const long = { ...sheet, rows: Array.from({ length: 600 }, (_, i) => sheet.rows[i % sheet.rows.length]) };
const longBack = readFirstSheet(writeTgTranscoWorkbook(long)).rows;
check('file: more rows than the template\'s 565 — built like its last, with the Amount formula', [longBack[600][0], longBack[600][3], longBack[600][9], longBack[601].slice(1, 10).every((v) => v == null)],
  [600, long.rows[599].head, Math.round(long.rows[599].rate * long.rows[599].qty * 1e6) / 1e6, true]);
checkTrue('file: … the print area and the Amount check grow with them', /Test!\$A\$1:\$J\$601/.test(openZip(writeTgTranscoWorkbook(long)).text('xl/workbook.xml'))
  && openZip(writeTgTranscoWorkbook(long)).text('xl/worksheets/sheet1.xml').includes('J118:J566 J567:J601'));

done('tgtransco');
