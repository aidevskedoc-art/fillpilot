// node scripts/test-yashoda.js — Yashoda bills (image PDFs → OCR) → structured
// data → TGNPDCL claim. Needs the real bills in test-fixtures/ (gitignored)
// and Windows OCR; the pure helpers are checked everywhere.
const fs = require('fs');
const path = require('path');
const { extractDocument } = require('../src/extraction/extract');
const {
  normalizeCode, codeFamily, parseAmount, parseQuantity, parseFinalBill, parseSummaryBill, repairInvoiceNo, repairNumber, repairName,
} = require('../src/extraction/formats/yashoda');
const { buildTgnpdclClaim } = require('../src/claims/tgnpdcl');
const { buildPmjayClaim } = require('../src/claims/pmjay');
const { buildCilClaim } = require('../src/claims/cil');
const { buildAliasIndex, seedAliases } = require('../src/alias-index');
const { ocrAvailable } = require('../src/ocr');
const { check, checkTrue, done } = require('./lib/check');

// OCR repairs (pure)
check('code 41A/NIMS', normalizeCode('41A/NIMS'), { code: '41A', tariff: 'NIMS', raw: '41A/NIMS', valid: true });
check('code IIA → 11A', normalizeCode('IIA/NIMS').code, '11A');
check('code RI 71 → R171', normalizeCode('RI 71/NIMS').code, 'R171');
check('code 75 IA → 751A', normalizeCode('75 IA/NIMS').code, '751A');
check('code NIMS/IIE → 11E', normalizeCode('NIMS/IIE').code, '11E');
check('COMM misreads', ['2121/COPN.', '586/corm.', '303/cou.', '586/conun.'].map((c) => normalizeCode(c).tariff), ['COMM', 'COMM', 'COMM', 'COMM']);
check('surgery code kept', normalizeCode('S5.1.17').code, 'S5.1.17');
check('PM-JAY codes: O/0 and I/1 repaired', ['CIOII', 'RIOOI', 'LBIOO', 'NIOOI', 'C1001', 'R1034'].map((c) => normalizeCode(c).code), ['CI011', 'RI001', 'LB100', 'NI001', 'CI001', 'RI034']);
check('PM-JAY codes read right are kept', ['LB025', 'CC003', 'NU116', 'EP092', 'GP009', 'PT004'].map((c) => normalizeCode(c).code), ['LB025', 'CC003', 'NU116', 'EP092', 'GP009', 'PT004']);
check('marked code keeps the NIMS repair only', [normalizeCode('N1003/NIMS').code, normalizeCode('HA006/NIMS').code], ['N1003', 'HA006']);
check('hospital\'s own code is valid as printed', normalizeCode('YSSH'), { code: 'YSSH', tariff: null, raw: 'YSSH', valid: true, own: true });
check('letters-only code that is not ours is still flagged', normalizeCode('IIA').valid, false);
check('invoice number: OCR zero → letter O', [repairInvoiceNo('IC06076856'), repairInvoiceNo('ICO6076856'), repairInvoiceNo('IC0607685')], ['ICO6076856', 'ICO6076856', 'IC0607685']);

// I ↔ 1 and O ↔ 0, both ways, by the place in each field (client report 2026-10-19: 78I/NIMS came out as 781).
check('tariff code: the letter I after the digits stays I, 781 kept as the other reading', normalizeCode('78I/NIMS'), { code: '78I', tariff: 'NIMS', raw: '78I/NIMS', valid: true, alternatives: ['781'] });
// Client report 2026-10-22: TSH 78I came out of OCR as a clean 781.
check('tariff code: a clean 1 after 2–3 digits is kept, with I as the other reading', ['781/NIMS', '2121/COMM', '1431/NIMS', '71/NIMS'].map((c) => [normalizeCode(c).code, normalizeCode(c).alternatives ?? null]),
  [['781', ['78I']], ['2121', ['212I']], ['1431', ['143I']], ['71', null]]);
check('tariff code: a clean 1 after a letter prefix or 4+ digits — no other reading', ['R171/NIMS', 'RI 71/NIMS', 'N1001/NIMS', '10031/NIMS', '780/NIMS'].map((c) => [normalizeCode(c).code, normalizeCode(c).alternatives ?? null]),
  [['R171', null], ['R171', null], ['N1001', null], ['10031', null], ['780', null]]);
check('tariff code: | ! l L there are a 1 or an I', ['78|/NIMS', '78!/NIMS', '78l/NIMS', '78L/NIMS'].map((c) => [normalizeCode(c).code, normalizeCode(c).alternatives]),
  [['781', ['78I']], ['781', ['78I']], ['781', ['78I']], ['781', ['78I']]]);
check('tariff code: a letter after the digits settles it — no other reading', ['41A/NIMS', 'IIA/NIMS', '75 IA/NIMS', 'NIMS/IIE', '61B /NIMS', '3057/NIMS', 'N1003/NIMS'].map((c) => normalizeCode(c).alternatives ?? null),
  [null, null, null, null, null, null, null]);
check('tariff code: O inside the digits is 0', ['4OA/NIMS', '1O96/COMM', 'HAOO6/NIMS', '2O1C/NIMS'].map((c) => normalizeCode(c).code), ['40A', '1096', 'HA006', '201C']);
check('tariff code: two-letter prefix kept', [normalizeCode('RH41/NIMS').code, normalizeCode('RH4I/NIMS').code], ['RH41', 'RH4I']);
check('tariff code: combined codes repaired part by part, no other reading', [normalizeCode('RI71+I71/NIMS').code, normalizeCode('NIOO3+I4A/NIMS').code, normalizeCode('R171+171/NIMS').alternatives ?? null],
  ['R171+171', 'N1003+14A', null]);
check('this bill\'s codes (TSH 78I among them)', ['3057/NIMS', '41A/NIMS', '423A/NIMS', '40A/NIMS', '751A/NIMS', '415A/NIMS', '14A/NIMS', '12C/NIMS', '11A/NIMS', '52A/NIMS',
  '18A/NIMS', '24A/NIMS', '78I/NIMS', '61B /NIMS', '13A/NIMS', 'N1003/NIMS', '213A/NIMS', '239A/NIMS', '215A/NIMS', '250C/NIMS', '257B/NIMS', '1096/COMM', 'R171/NIMS', 'NIMS/11E']
  .map((c) => normalizeCode(c).code),
['3057', '41A', '423A', '40A', '751A', '415A', '14A', '12C', '11A', '52A', '18A', '24A', '78I', '61B', '13A', 'N1003', '213A', '239A', '215A', '250C', '257B', '1096', 'R171', '11E']);
check('unmarked code on a NIMS bill read as a tariff code: N1003 stays, not NI003', [normalizeCode('N1003', 'nims').code, normalizeCode('N1003').code, normalizeCode('78I', 'nims').code], ['N1003', 'NI003', '78I']);
check('unmarked code with two letters first on a NIMS bill read as a package (CGHS) code: CI001 not C1001', ['MG038', 'CI001', 'LBO12', 'CIOOI'].map((c) => normalizeCode(c, 'nims').code), ['MG038', 'CI001', 'LB012', 'CI001']);
check('surgery code on a NIMS bill: I and O in the digits', [normalizeCode('S5.I.I7', 'nims').code, normalizeCode('S5.1.17', 'nims').code], ['S5.1.17', 'S5.1.17']);
check('package code: letters and digits by place, both ways', ['CIOII', 'C1O11', 'LBO37', 'CCOO8', 'L8037'].map((c) => normalizeCode(c).code), ['CI011', 'CI011', 'LB037', 'CC008', 'L8037']);
check('package codes have no other reading', ['CI011', 'RI034', 'LB025'].map((c) => normalizeCode(c).alternatives ?? null), [null, null, null]);
check('bill kind from its codes', [codeFamily(['41A/NIMS', '78I/NIMS', 'S5.1.17', 'N1003']), codeFamily(['CIOII', 'LB025', 'YSSH', 'CC008/NIMS']), codeFamily([])], ['nims', 'package', 'package']);
check('numbers: look-alikes are digits', ['I31885', '13l885', '1318O5', '131885', '13188S'].map(repairNumber), ['131885', '131885', '131805', '131885', '13188S']);
check('names: a 1 or 0 next to a letter is I or O', ['MR. CHANDRA KANTHA RAO NET1', 'SAR1KI VEDA', 'DR. R0Y', 'A KUMAR 2', 'G V'].map(repairName),
  ['MR. CHANDRA KANTHA RAO NETI', 'SARIKI VEDA', 'DR. ROY', 'A KUMAR 2', 'G V']);
check('invoice number: letters and digits by place', ['1CO6077879', 'IC06077879', 'ICO6O77879', 'ICO6077I79', 'lCO6077879', 'ICO6077879'].map(repairInvoiceNo),
  ['ICO6077879', 'ICO6077879', 'ICO6077879', 'ICO6077179', 'ICO6077879', 'ICO6077879']);
check('amount Indian grouping', parseAmount('2,01,742.72'), 201742.72);
check('amount OCR i → 1', parseAmount('i, 575.00'), 1575);
check('amount unreadable', parseAmount('1,5?5.0'), null);
check('quantity', parseQuantity('15 Time(s) x 45.00'), { qty: 15, unit: 'Time', rate: 45 });
check('quantity OCR-spoilt is not parsed (the bill reader then uses amount ÷ rate)', parseQuantity('2O Time(s) X 40.00').qty ?? null, null);
{
  // A final-bill page built by hand: the count "20" read as "2O" — the units must not quietly become 1.
  const L = (y, ...segs) => ({ y, h: 8, text: segs.map((s) => s[1]).join(' | '), segments: segs.map(([x0, text]) => ({ x0, x1: x0 + 50, text })) });
  const page = (valueText) => [{ page: 1, width: 600, lines: [
    L(800, [10, 'Name : MR. TEST'], [480, 'IP No: 1']),
    L(760, [10, '1. RBS WITH GLUCOMETER']),
    L(740, [50, 'RBS WITH GLUCOMETER'], [300, valueText], [420, 'LB055'], [510, '800.00']),
    L(720, [370, 'Sub Total...'], [510, '800.00']),
    L(700, [370, 'Grand Total...'], [510, '800.00']),
  ] }];
  const spoilt = parseFinalBill(page('2O Time(s) X 40.00')).sections[0].groups[0].items[0];
  check('quantity OCR-spoilt: count = amount ÷ rate, flagged', [spoilt.qty, spoilt.issues.some((m) => /amount ÷ rate = 20/.test(m))], [20, true]);
  const unreadable = parseFinalBill(page('2O Time(s) X 4?.00')).sections[0].groups[0].items[0];
  check('quantity unreadable, no rate: 1 assumed, flagged', [unreadable.qty, unreadable.issues.some((m) => /1 assumed/.test(m))], [1, true]);

  const ownLine = [{ page: 1, width: 600, lines: [
    L(800, [10, 'Name : MR. TEST'], [480, 'IP No: 1']),
    L(760, [10, '1. LABORATORY']),
    L(740, [50, 'BLOOD IRRADIATION (1 UNIT)'], [420, 'YSSH'], [510, '1,000.00']),
    L(720, [370, 'Sub Total...'], [510, '1,000.00']),
    L(700, [370, 'Grand Total...'], [510, '1,000.00']),
  ] }];
  const own = parseFinalBill(ownLine);
  check('own code: kept, marked, not reported as misread', [own.sections[0].groups[0].items[0].ownCode, own.issues.filter((i) => /misread/.test(i.message)).length], [true, 0]);

  // A bill the company pays in full: no PAID AMOUNT line, so nothing was paid — not "unreadable".
  const credited = parseSummaryBill([{ page: 1, width: 600, lines: [
    L(800, [100, 'BILL OF SUPPLY / INVOICE NO: IC06076856']),
    L(780, [50, 'IP NO: 1']),
    L(760, [50, 'Description of Healthcare Services']),
    L(740, [50, 'ROOM RENT'], [500, '1,500.00']),
    L(720, [300, 'TOTAL AMOUNT:'], [500, '1,500.00']),
    L(700, [300, 'TOTAL AMOUNT :'], [500, '1,500.00']),
    L(680, [200, 'CREDIT FROM COAL INDIA LTD:'], [500, '1,500.00']),
    L(660, [300, 'TOTAL:'], [500, '1,500.00']),
  ] }]);
  check('fully credited summary: invoice repaired, paid 0, no note', [credited.invoiceNo, credited.totals.paid, credited.totals.credit, credited.issues], ['ICO6076856', 0, { from: 'COAL INDIA LTD', amount: 1500 }, []]);

  // The client's bill (2026-10-19) by hand, as OCR may read it: I and 1, O and 0 swapped in every field.
  const nimsBill = parseFinalBill([{ page: 1, width: 600, lines: [
    L(800, [10, 'Name : MR. CHANDRA KANTHA RAO NET1'], [480, 'IP No: I31885']),
    L(760, [10, '1. LABORATORY']),
    L(740, [50, 'THYROID STIMULATING HORMONE (TSH)'], [420, '78I/NIMS'], [510, '300.00']),
    L(730, [50, 'VBG ELECTROLYTES'], [420, 'N1003'], [510, '450.00']),
    L(720, [50, 'CREATININE - SERUM'], [420, '14A/NIMS'], [510, '1O5.00']),
    L(710, [370, 'Sub Total...'], [510, '855.00']),
    L(700, [10, '2. DOCTOR FEES']),
    L(690, [50, 'SAR1KI VEDA SAI MAHESWARI'], [300, '1 Visit(s) X 350.00'], [510, '350.00']),
    L(680, [370, 'Sub Total...'], [510, '350.00']),
    L(670, [370, 'Grand Total...'], [510, '1,2O5.00']),
  ] }]);
  const nimsItems = nimsBill.sections.flatMap((s) => s.groups.flatMap((g) => g.items));
  check('final by hand: IP, patient name, doctor name', [nimsBill.patient, nimsItems[3].description], [{ name: 'MR. CHANDRA KANTHA RAO NETI', ipNo: '131885' }, 'SARIKI VEDA SAI MAHESWARI']);
  check('final by hand: 78I kept (781 the other reading), unmarked N1003 read as a NIMS code', nimsItems.map((i) => [i.code, i.codeAlternatives ?? null]),
    [['78I', ['781']], ['N1003', null], ['14A', null], [null, null]]);
  check('final by hand: amounts add up, no errors', [nimsBill.totals.grandTotal, nimsBill.issues.filter((i) => i.level === 'error')], [1205, []]);
  const nimsClaim = buildTgnpdclClaim({ final: nimsBill });
  check('claim by hand: 78I goes to the site with 781 as the other reading', nimsClaim.tabs.investigations.items.map((r) => [r.code, r.alternatives ?? null]),
    [['78I', ['781']], ['N1003', null], ['14A', null]]);

  const summaryRead = parseSummaryBill([{ page: 1, width: 600, lines: [
    L(800, [100, 'BILL OF SUPPLY / INVOICE NO: 1CO6O77879']),
    L(780, [50, 'NAME: MR. CHANDRA KANTHA RAO NET1'], [400, 'AGE / SEX: 5O Y / M']),
    L(770, [50, 'IP NO: I31885'], [400, 'YH NO: 4OOO29O24']),
    L(760, [50, 'CONSULTANT: Dr. SUBBA1AH CHOWDHARY G V (NEUROLOGY)'], [400, 'D.O.A: 1O-1O-2026 01:36']),
    L(750, [400, 'D.0.D: I2-1O-2026 17:36']),
    L(740, [50, 'Description of Healthcare Services']),
    L(730, [50, 'ROOM RENT'], [500, '1,500.00']),
    L(720, [300, 'TOTAL AMOUNT:'], [500, '1,500.00']),
  ] }]);
  check('summary by hand: invoice, IP, YH, age, names, dates', [summaryRead.invoiceNo, summaryRead.patient], ['ICO6077879', {
    name: 'MR. CHANDRA KANTHA RAO NETI', age: 50, gender: 'Male', ipNo: '131885', yhNo: '400029024', consultant: 'SUBBAIAH CHOWDHARY G V', consultantSpeciality: 'NEUROLOGY',
    admission: { date: '2026-10-10', time: '01:36' }, discharge: { date: '2026-10-12', time: '17:36' },
  }]);
}

// Claim rules on hand-made bills (pure — no PDFs, no OCR, no patient data)
const item = (description, qty, rate, amount) => ({ description, qty, unit: null, rate, code: null, tariff: null, codeRaw: null, amount, page: 1, issues: [] });
const section = (name, groups) => ({ no: null, name, groups: groups.map(([g, items, subTotal]) => ({ name: g, items, subTotal })) });
const finalBill = (sections, grandTotal) => ({ patient: { ipNo: '1' }, sections, doctors: [], totals: { grandTotal, netAmount: null }, issues: [] });
const summaryBill = (categories, gross) => ({ invoiceNo: 'T1', patient: { ipNo: '1' }, categories, totals: { gross, paid: 0 }, issues: [] });
const errorsOf = (claim) => claim.checks.filter((c) => c.level === 'error').map((c) => c.message);

const consult = buildTgnpdclClaim({ final: finalBill([
  section('DOCTOR VISIT CHARGES', [['DOCTOR VISIT CHARGES', [item('DR. A KUMAR', 2, 500, 1000)], 1000]]),
  section('CROSS CONSULTATION CHARGES', [['CROSS CONSULTATION CHARGES', [item('DR. B RAO', 1, 800, 800)], 800]]),
], 1800) });
check('claim: doctors from every doctor/consultation section', consult.tabs.room.doctors.map((d) => [d.name, d.days]), [['A KUMAR', 2], ['B RAO', 1]]);
check('claim: consultation rows not lost to investigations', consult.tabs.investigations.items.length, 0);

const ward = buildTgnpdclClaim({ final: finalBill([section('ROOM RENT', [['ROOM RENT', [item('GENERAL WARD', 3, null, 6000)], 6000]])], 6000) });
check('claim: ward rate = amount ÷ days when no rate is read', ward.tabs.room.wards.map((w) => [w.ratePerDay, w.days]), [[2000, 3]]);
checkTrue('claim: derived ward rate flagged', ward.checks.some((c) => /rate per day not readable/.test(c.message)));

const split = buildTgnpdclClaim({
  final: finalBill([
    section('PHARMACY', [['PHARMACY', [item('ISSUES 1', 1, null, 100)], 100], [null, [item('ISSUES 2', 1, null, 50)], 50]]),
    section('INVESTIGATIONS', [['HAEMATOLOGY', [item('CBP', 1, null, 100)], 100], ['BIOCHEMISTRY', [item('LFT', 1, null, 200)], 200]]),
  ], 450),
  summary: summaryBill([{ name: 'PHARMACY', amount: 150 }, { name: 'INVESTIGATIONS', amount: 300 }], 450),
});
check('claim: summary line vs all groups of that name / section', errorsOf(split), []);
checkTrue('claim: section-level summary line found', !split.checks.some((c) => /INVESTIGATIONS.*not found/.test(c.message)));

// PM-JAY Treatment Plan: one row per code, units = times charged; the rest is manual.
const coded = (description, code, qty, amount) => ({ ...item(description, qty, null, amount), code });

// IP 129009 (2026-10-27): the summary prints CARDIOLOGY twice, once per group; PTCA carries the CGHS code CP001.
const twice = buildTgnpdclClaim({
  final: finalBill([section('CARDIOLOGY', [['CARDIOLOGY', [{ ...coded('E C G', '3055', 1, 75), tariff: 'NIMS' }], 75], [null, [coded('P T C A', 'CP001', 1, 111550)], 111550]])], 111625),
  summary: summaryBill([{ name: 'CARDIOLOGY', amount: 75 }, { name: 'CARDIOLOGY', amount: 111550 }], 111625),
});
check('claim: a name printed twice on the summary is compared added up', errorsOf(twice), []);
check('claim: CP001 among NIMS codes goes to CGHS', twice.tabs.investigations.items.map((r) => [r.code, r.tariff]), [['3055', 'NIMS'], ['CP001', 'CGHS']]);
const pmjay = buildPmjayClaim({ final: finalBill([
  section('LABORATORY', [['HAEMATOLOGY', [coded('HAEMOGRAM', 'LB012', 1, 300), coded('HAEMOGRAM', 'LB012', 1, 300), coded('COMPLETE HAEMOGRAM', 'LB012', 1, 300)], 900]]),
  section('RBS WITH GLUCOMETER', [['RBS WITH GLUCOMETER', [coded('RBS WITH GLUCOMETER', 'LB055', 20, 800), coded('RBS WITH GLUCOMETER', 'LB055', 5, 200)], 1000]]),
  section('DOCTOR FEES', [['DOCTOR FEES', [item('A KUMAR', 1, 350, 350), item('A KUMAR', 1, 350, 350)], 700]]),
  section('RADIOLOGY', [['RADIOGRAPH', [coded('RADIOGRAPH RT HIP', 'R171+171', 1, 450)], 450]]),
], 3050) });
check('pmjay: one row per code, units = times charged', pmjay.procedures.map((p) => [p.code, p.units, p.lines]), [['LB012', 3, 3], ['LB055', 25, 2]]);
check('pmjay: same code, other wording noted', pmjay.procedures[0].notes, ['Same code on the bill for: HAEMOGRAM; COMPLETE HAEMOGRAM']);
check('pmjay: uncoded and combined lines left for the person', pmjay.manual.map((m) => [m.description, m.count, m.amount, m.reason]),
  [['A KUMAR', 2, 700, 'No code on the bill'], ['RADIOGRAPH RT HIP', 1, 450, 'Combined code R171+171']]);

// Coal India Bill Details: a row per service with a CIL code, own codes as Unlisted Procedures.
const ownCoded = (description, qty, amount) => ({ ...coded(description, 'YSSH', qty, amount), ownCode: true });
// The client's Coal India example bill (IP 130708, 2026-10-19), line for line.
const cil = buildCilClaim({
  final: finalBill([
    section('ROOM RENT', [['ROOM RENT', [item('ROOM RENT', 1, 1500, 1500)], 1500]]),
    section('SDP TRANSFUSSION', [['SDP TRANSFUSSION', [coded('SDP TRANSFUSION', 'CC008', 1, 3000)], 3000]]),
    section('BLOOD TRANSFUSION', [['BLOOD TRANSFUSION', [coded('BLOOD COMPONENT TRANSFUSION', 'CC008', 1, 3500)], 3500]]),
    section('DOCTOR FEES', [['DOCTOR FEES', [item('A KUMAR', 1, 350, 350)], 350]]),
    section('LABORATORY', [['TRANSFUSION MEDICINE', [
      coded('BLOOD ISSUE', 'LB037', 1, 200), ownCoded('BLOOD IRRADIATION (1 UNIT)', 1, 1000), ownCoded('BLOOD IRRADIATION (1 UNIT)', 1, 1000), coded('LDPRBC', 'BC002', 1, 2550),
      coded('SINGLE DONOR PLATELETS IN PLATELET ADDITIVE SOLUTION', 'BC006', 1, 11000),
    ], 15750]]),
    section('PHARMACY', [['PHARMACY', [item('PHARMACY', 1, null, 2688.65)], 2688.65]]),
  ], 26788.65),
  summary: { invoiceNo: 'ICO1', patient: { ipNo: '1', company: 'COAL INDIA LTD', discharge: { date: '2026-10-01', time: '19:35' } }, categories: [], totals: { gross: 26788.65, paid: 0 }, issues: [] },
});
check('cil: one CGHS row per code — CC008 for two services is quantity 2', cil.cghs.map((r) => [r.code, r.qty, r.rate, r.amount]), [['CC008', 2, 3250, 6500], ['LB037', 1, 200, 200]]);
check('cil: the services of a code go in Remarks', cil.cghs[0].description, 'SDP TRANSFUSION; BLOOD COMPONENT TRANSFUSION');
check('cil: Unlisted rows — room rent, identical own-code lines as one row, BC002, BC006', cil.unlisted.map((r) => [r.code, r.description, r.qty, r.rate, r.amount]), [
  ['ROOM RENT', 'ROOM RENT', 1, 1500, 1500],
  ['YSSH', 'BLOOD IRRADIATION (1 UNIT)', 2, 1000, 2000],
  ['BC002', 'LDPRBC', 1, 2550, 2550],
  ['BC006', 'SINGLE DONOR PLATELETS IN PLATELET ADDITIVE SOLUTION', 1, 11000, 11000],
]);
check('cil: room rent still reminded for Room Details; doctor fees left for the person', [cil.room, cil.manual.map((m) => [m.description, m.amount]), cil.totals.manual], [{ days: 1, amount: 1500 }, [['A KUMAR', 350]], 350]);
check('cil: no Unlisted row has Remarks empty (the site does not take it) — room rent ROOM RENT, the others their name', cil.unlisted.map((r) => [r.code, r.remarks ?? null]), [
  ['ROOM RENT', 'ROOM RENT'],
  ['YSSH', 'BLOOD IRRADIATION (1 UNIT)'],
  ['BC002', 'LDPRBC'],
  ['BC006', 'SINGLE DONOR PLATELETS IN PLATELET ADDITIVE SOLUTION'],
]);
check('cil: CGHS + Unlisted + left for the person + pharmacy = the bill, nothing twice', [cil.totals.cghs, cil.totals.unlisted, cil.totals.manual, cil.pharmacy,
  Math.round((cil.totals.cghs + cil.totals.unlisted + cil.totals.manual + cil.pharmacy) * 100) / 100], [6700, 17050, 350, 2688.65, 26788.65]);
{
  // BC006 like BC002, the same BC code twice is one row; room rent over several days at its rate per day.
  const more = buildCilClaim({ final: finalBill([
    section('ROOM RENT', [['ROOM RENT', [item('GENERAL WARD', 3, 1500, 4500)], 4500]]),
    section('BLOOD TRANSFUSION', [['BLOOD TRANSFUSION', [coded('SDP', 'BC006', 1, 11000), coded('SDP', 'BC006', 1, 11000), coded('PLATELETS', 'BC003', 1, 900)], 22900]]),
  ], 27400) });
  check('cil: BC006 to Unlisted (two lines, one row), BC003 not on the list stays CGHS, room days × rate',
    [more.unlisted.map((r) => [r.code, r.description, r.qty, r.rate, r.amount]), more.cghs.map((r) => r.code), more.manual.length],
    [[['ROOM RENT', 'GENERAL WARD', 3, 1500, 4500], ['BC006', 'SDP', 2, 11000, 22000]], ['BC003'], 0]);

  // The client's example bill (2026-10-19): room rent 2 days × 4,500 and two YSSH lines to Unlisted; ICU and doctors stay manual.
  const example = buildCilClaim({ final: finalBill([
    section('ROOM RENT', [['ROOM RENT', [item('ROOM RENT', 2, 4500, 9000)], 9000]]),
    section('INTENSIVE CARE UNIT', [['INTENSIVE CARE UNIT', [item('ICCU-II-22 BED CHARGE', 1, 6000, 6000)], 6000]]),
    section('WARD CHARGES', [['WARD CHARGES', [item('ICU BED CHARGES', 1, 6000, 6000)], 6000]]),
    section('BED SIDE PROCEDURE CHARGES', [['BED SIDE PROCEDURE CHARGES', [ownCoded('MID LINE CATHETERIZATION (INCL. PROFESSIONAL CHARGES)', 1, 15000)], 15000]]),
    section('CARDIOLOGY', [['CARDIOLOGY', [ownCoded('I V U S', 1, 60000)], 60000]]),
    section('DOCTOR FEES', [['DOCTOR FEES', [item('GOPI KRISHNA RAYIDI', 4, 350, 1400)], 1400]]),
  ], 97400) });
  check('cil example: room rent and YSSH lines are Unlisted rows', example.unlisted.map((r) => [r.code, r.description, r.qty, r.rate, r.amount]), [
    ['ROOM RENT', 'ROOM RENT', 2, 4500, 9000],
    ['YSSH', 'MID LINE CATHETERIZATION (INCL. PROFESSIONAL CHARGES)', 1, 15000, 15000],
    ['YSSH', 'I V U S', 1, 60000, 60000],
  ]);
  check('cil example: ICU (however it is worded) and doctor fees left for the person', [example.manual.map((m) => [m.description, m.amount, m.reason]), example.room], [[
    ['ICCU-II-22 BED CHARGE', 6000, 'ICU — enter it on the site yourself'],
    ['ICU BED CHARGES', 6000, 'ICU — enter it on the site yourself'],
    ['GOPI KRISHNA RAYIDI', 1400, 'Doctor fees have no code — enter them on the site yourself'],
  ], { days: 2, amount: 9000 }]);
}
check('cil: bill number, bill date = discharge, pharmacy', [cil.hospitalBillNumber, cil.billDate, cil.pharmacy], ['ICO1', '01-10-2026', 2688.65]);
check('cil: no problems on a matching pair', cil.checks, []);
// TGNPDCL: the hospital's own code is in no tariff list — kept apart, one row per item.
const ownTg = buildTgnpdclClaim({ final: finalBill([
  section('BED SIDE PROCEDURE CHARGES', [['BED SIDE PROCEDURE CHARGES', [ownCoded('MID LINE CATHETERIZATION', 1, 15000), coded('ARTERIAL LINE PROCEDURE', '584', 1, 833)], 15833]]),
  section('CARDIOLOGY', [['CARDIOLOGY', [ownCoded('I V U S', 1, 60000)], 60000]]),
], 75833) });
check('tgnpdcl: own codes kept apart, one row per item', ownTg.tabs.investigations.ownItems.map((r) => [r.code, r.description, r.qty, r.rate, r.amountClaimed]),
  [['YSSH', 'MID LINE CATHETERIZATION', 1, 15000, 15000], ['YSSH', 'I V U S', 1, 60000, 60000]]);
check('tgnpdcl: own codes are not tariff rows', ownTg.tabs.investigations.items.map((r) => r.code), ['584']);
// 781 and 78I both printed on one bill: two items, so neither is the other's alternative reading.
const bothReadings = buildTgnpdclClaim({ final: finalBill([section('LABORATORY', [['BIOCHEMISTRY', [
  { ...coded('TSH', '78I', 1, 300), tariff: 'NIMS', codeAlternatives: ['781'] },
  { ...coded('OTHER TEST', '781', 1, 450), tariff: 'NIMS', codeAlternatives: ['78I'] },
  { ...coded('CHEST X-RAY', 'R171', 1, 225), tariff: 'NIMS', codeAlternatives: ['R17I'] },
], 975]])], 975) });
check('tgnpdcl: a reading that is another line\'s code is dropped', bothReadings.tabs.investigations.items.map((r) => [r.code, r.alternatives ?? null]),
  [['78I', null], ['781', null], ['R171', ['R17I']]]);
// A CGHS code among NIMS codes (MG038 on IP 126175, 2026-10-27): marked CGHS for the site's "CGHS(2025)-Tier I".
// A mark printed on the bill wins; an unmarked code that is not CGHS gets no mark.
const cghsTg = buildTgnpdclClaim({ final: finalBill([section('PROCEDURE CHARGES', [['PROCEDURE CHARGES', [
  coded('EMBOLIZATION-PERIPHERAL (COMPLEX)', 'MG038', 1, 49450),
  { ...coded('HAEMOGRAM', '423A', 1, 225), tariff: 'NIMS' },
  { ...coded('BLOOD COMPONENT TRANSFUSION', 'CC008', 1, 3500), tariff: 'NIMS' },
  coded('VBG ELECTROLYTES', 'N1003', 1, 450),
], 53625]])], 53625) });
check('tgnpdcl: unmarked CGHS code marked CGHS, printed marks kept', cghsTg.tabs.investigations.items.map((r) => [r.code, r.tariff, r.manual]),
  [['MG038', 'CGHS', false], ['423A', 'NIMS', false], ['CC008', 'NIMS', false], ['N1003', null, false]]);

checkTrue('cil: other company flagged', buildCilClaim({ final: finalBill([], 0), summary: { invoiceNo: 'X', patient: { company: 'NORTHERN POWER' }, categories: [], totals: { gross: 0 }, issues: [] } })
  .checks.some((c) => /not Coal India/.test(c.message)));

const FIXTURES = path.join(__dirname, '..', 'test-fixtures');
const finalPdf = path.join(FIXTURES, 'bills', 'case-01', 'yashoda-final-bill.pdf');
const summaryPdf = path.join(FIXTURES, 'bills', 'case-01', 'yashoda-summary-bill.pdf');

(async () => {
  if (!ocrAvailable() || !fs.existsSync(finalPdf) || !fs.existsSync(summaryPdf)) {
    console.log('SKIP  real-bill checks (need Windows OCR and test-fixtures/bills/case-01/yashoda-*-bill.pdf)');
    return done('yashoda');
  }
  const aliasIndex = buildAliasIndex(seedAliases());
  const finalDoc = await extractDocument(fs.readFileSync(finalPdf), aliasIndex);
  const summaryDoc = await extractDocument(fs.readFileSync(summaryPdf), aliasIndex);
  const f = finalDoc.structured;
  const s = summaryDoc.structured;

  check('final: detected', finalDoc.docType, 'yashoda-final-bill');
  check('final: patient', f.patient, { name: 'MR. JEEVAN REDDY PODDUTURI', ipNo: '125681' });
  check('final: 11 sections', f.sections.length, 11);
  const items = f.sections.flatMap((x) => x.groups.flatMap((g) => g.items));
  check('final: 35 items', items.length, 35);
  const find = (re) => items.find((i) => re.test(i.description));
  check('final: blood grouping code', [find(/BLOOD GROUPING/).code, find(/BLOOD GROUPING/).amount], ['751A', 90]);
  check('final: glucose random code', find(/GLUCOSE RANDOM/).code, '11A');
  check('final: chest x-ray code', find(/CHEST PA/).code, 'R171');
  check('final: RBS qty × rate', [find(/^RBS/).qty, find(/^RBS/).rate, find(/^RBS/).code, find(/^RBS/).amount], [15, 45, '11E', 675]);
  check('final: alpha bed', [find(/ALPHA BED/).code, find(/ALPHA BED/).tariff, find(/ALPHA BED/).amount], ['2121', 'COMM', 1575]);
  check('final: multi-line description', find(/THROMOBOPLASTIN/).description, 'ACTIVATED PARTIAL THROMOBOPLASTIN TIME (APTT)');
  check('final: surgery', [find(/ORIF/).code, find(/ORIF/).amount], ['S5.1.17', 62000]);
  check('final: doctors', f.doctors.map((d) => [d.name, d.visits]), [
    ['BHARATH VIJAY PUROHIT', 1], ['HARISH C. R.', 2], ['RAJASEKARA CHAKRAVARTHI', 2], ['SUBBAIAH CHOWDHARY G V', 2], ['SUDARSHAN REDDY L', 2],
  ]);
  check('final: totals', [f.totals.grandTotal, f.totals.netAmount], [201742.72, 201743]);
  check('final: no errors', f.issues.filter((i) => i.level === 'error'), []);

  check('summary: detected', summaryDoc.docType, 'yashoda-summary-bill');
  check('summary: invoice', s.invoiceNo, 'ICO6073794');
  check('summary: patient', [s.patient.ipNo, s.patient.age, s.patient.gender, s.patient.consultant, s.patient.consultantSpeciality], ['125681', 77, 'Male', 'HARISH C. R.', 'ORTHOPAEDIC SURGERY']);
  check('summary: company (two lines)', s.patient.company, 'NORTHERN POWER DISTRIBUTION COMPANY OF T.G. LTD');
  check('summary: stay', [s.patient.admission, s.patient.discharge], [{ date: '2026-08-25', time: '22:49' }, { date: '2026-08-29', time: '12:22' }]);
  check('summary: 19 charge lines', s.categories.length, 19);
  check('summary: totals', [s.totals.gross, s.totals.rounded, s.totals.credit.amount, s.totals.paid, s.totals.total], [201742.72, 201743, 131743, 70000, 201743]);
  check('summary: no errors', s.issues.filter((i) => i.level === 'error'), []);

  const claim = buildTgnpdclClaim({ final: f, summary: s });
  check('claim: wards', claim.tabs.room.wards.map((w) => [w.ratePerDay, w.days]), [[3000, 1]]);
  check('claim: 5 doctors', claim.tabs.room.numberOfDoctors, 5);
  check('claim: consultant gets speciality', claim.tabs.room.doctors[1].name, 'HARISH C. R. (ORTHOPAEDIC SURGERY)');
  check('claim: 27 investigation rows', claim.tabs.investigations.items.length, 27);
  check('claim: implants total', claim.tabs.investigations.implants.amount, 109069);
  check('claim: pharmacy total', claim.tabs.pharmacy.total, 6432.72);
  check('claim: summary tab', claim.tabs.summary, { employeePaid: 70000, concession: 0, hospitalBillNumber: 'ICO6073794' });
  check('claim: bills agree (no errors)', claim.checks.filter((c) => c.level === 'error'), []);
  checkTrue('claim: room days vs stay flagged', claim.checks.some((c) => /stay was 4 day/.test(c.message)), JSON.stringify(claim.checks));
  check('claim: totals', [claim.totals.billTotal, claim.totals.filledByExtension + claim.totals.leftForManualEntry], [201742.72, 201742.72]);

  // Bill 2: 9 pages, stamp on every page, ICU, many repeated tests, combined codes.
  const final2 = path.join(FIXTURES, 'bills', 'case-02', 'yashoda-final-bill-2.pdf');
  const summary2 = path.join(FIXTURES, 'bills', 'case-02', 'yashoda-summary-bill-2.pdf');
  if (fs.existsSync(final2) && fs.existsSync(summary2)) {
    const f2 = (await extractDocument(fs.readFileSync(final2), aliasIndex)).structured;
    const s2 = (await extractDocument(fs.readFileSync(summary2), aliasIndex)).structured;
    const groups2 = f2.sections.flatMap((x) => x.groups);
    const items2 = groups2.flatMap((g) => g.items);
    check('bill 2: patient', f2.patient, { name: 'MR. RAGHUPATHI SIDDAM', ipNo: '126175' });
    check('bill 2: 17 sections', f2.sections.length, 17);
    check('bill 2: every group adds up', groups2.filter((g) => Math.abs(g.items.reduce((a, i) => a + i.amount, 0) - g.subTotal) > 0.011).map((g) => g.name), []);
    check('bill 2: totals', [f2.totals.grandTotal, f2.totals.netAmount], [661743.84, 661744]);
    check('bill 2: final no errors', f2.issues.filter((i) => i.level === 'error'), []);
    check('bill 2: stamp kept out of descriptions', items2.filter((i) => /YASHODA/.test(i.description)).length, 0);
    check('bill 2: bracket continuation', items2.find((i) => i.code === '12C').description, 'ELECTROLYTES SERUM (SODIUM, POTASSIUM, CHLORIDE)');
    check('bill 2: summary', [s2.invoiceNo, s2.patient.ipNo, s2.patient.company, s2.totals.credit.amount, s2.totals.paid, s2.totals.total],
      ['ICO6075292', '126175', 'NORTHERN POWER DISTRIBUTION COMPANY OF T.G. LTD', 630900, 30844, 661744]);
    check('bill 2: summary no errors', s2.issues.filter((i) => i.level === 'error'), []);

    const c2 = buildTgnpdclClaim({ final: f2, summary: s2 });
    const row = (code) => c2.tabs.investigations.items.find((r) => r.code === code);
    check('bill 2: ICU + ward', [c2.tabs.room.icuDays, c2.tabs.room.wards.map((w) => [w.ratePerDay, w.days])], [9, [[2000, 8]]]);
    check('bill 2: room days exclude ICU', c2.tabs.room.roomDays, 8);
    check('bill 2: 8 doctors', c2.tabs.room.doctors.map((d) => d.name).filter((n) => /NIKHIL|NAVEEN/.test(n)), ['NIKHIL H R', 'NAVEEN POLAVARAPU (GASTROENTEROLOGY)']);
    check('bill 2: repeated tests merged', [row('423A').qty, row('423A').amountClaimed, row('245').qty, row('245').amountClaimed], [18, 4050, 20, 10060]);
    check('bill 2: manual rows', c2.tabs.investigations.items.filter((r) => r.manual).map((r) => r.code), [null, 'N1003+14A', '73A+14A', '50PERHOUR']);
    check('bill 2: summary tab', c2.tabs.summary, { employeePaid: 30844, concession: 0, hospitalBillNumber: 'ICO6075292' });
    check('bill 2: claim has no errors', c2.checks.filter((x) => x.level === 'error'), []);
    check('bill 2: stay = room + ICU (no warning)', c2.checks.some((x) => /stay was/.test(x.message)), false);
  } else {
    console.log('SKIP  bill 2 checks (test-fixtures/bills/case-02/yashoda-*-bill-2.pdf missing)');
  }

  // Bill 3: a PM-JAY patient — unmarked package codes (CI011, RI034), header read as "Name ." by OCR.
  const final3 = path.join(FIXTURES, 'bills', 'case-03-pmjay', 'final-bill.pdf');
  if (fs.existsSync(final3)) {
    const f3 = (await extractDocument(fs.readFileSync(final3), aliasIndex)).structured;
    const items3 = f3.sections.flatMap((x) => x.groups.flatMap((g) => g.items));
    const p3 = buildPmjayClaim({ final: f3 });
    const units = (code) => p3.procedures.find((p) => p.code === code)?.units;
    check('bill 3: IP from an OCR\'d "Name ." header', f3.patient.ipNo, '119719');
    check('bill 3: header kept out of descriptions', items3.filter((i) => /\bName\s*[:.;]/i.test(i.description)).length, 0);
    check('bill 3: 55 procedure rows', p3.procedures.length, 55);
    check('bill 3: codes repaired', ['CI011', 'RI001', 'CI001', 'LB100', 'LB001', 'NI001', 'RI034'].every((c) => units(c) != null), true);
    check('bill 3: units', ['LB012', 'LB120', 'LB055', 'CC003', 'RI034', 'CI011'].map(units), [16, 26, 204, 15, 20, 2]);
  } else {
    console.log('SKIP  bill 3 checks (test-fixtures/bills/case-03-pmjay/final-bill.pdf missing)');
  }

  // Bill 4: a Coal India patient — CIL codes, the hospital's own code YSSH, paid in full by the company.
  const final4 = path.join(FIXTURES, 'bills', 'case-04-cil', 'final-bill.pdf');
  const summary4 = path.join(FIXTURES, 'bills', 'case-04-cil', 'summary-bill.pdf');
  if (fs.existsSync(final4) && fs.existsSync(summary4)) {
    const f4 = (await extractDocument(fs.readFileSync(final4), aliasIndex)).structured;
    const s4 = (await extractDocument(fs.readFileSync(summary4), aliasIndex)).structured;
    const c4 = buildCilClaim({ final: f4, summary: s4 });
    check('bill 4: totals', [f4.totals.grandTotal, f4.totals.netAmount], [26788.65, 26789]);
    check('bill 4: summary', [s4.invoiceNo, s4.totals.credit?.amount, s4.totals.paid], ['ICO6076856', 26789, 0]);
    check('bill 4: CGHS rows', c4.cghs.map((r) => [r.code, r.qty, r.amount]), [['CC008', 2, 6500], ['LB037', 1, 200]]);
    check('bill 4: Unlisted rows', c4.unlisted.map((r) => [r.code, r.amount]).sort(), [['BC002', 2550], ['BC006', 11000], ['ROOM RENT', 1500], ['YSSH', 2000]]);
    check('bill 4: left for the person', c4.manual.map((m) => m.amount), [350]);
    check('bill 4: bill date, pharmacy', [c4.billDate, c4.pharmacy], ['01-10-2026', 2688.65]);
    check('bill 4: claim has no errors', c4.checks.filter((x) => x.level === 'error'), []);
  } else {
    console.log('SKIP  bill 4 checks (test-fixtures/bills/case-04-cil/*-bill.pdf missing)');
  }

  // Bill 5: a TGNPDCL patient with the hospital's own code YSSH, paid in full by the company.
  const final5 = path.join(FIXTURES, 'bills', 'case-05-tgnpdcl-yssh', 'final-bill.pdf');
  const summary5 = path.join(FIXTURES, 'bills', 'case-05-tgnpdcl-yssh', 'summary-bill.pdf');
  if (fs.existsSync(final5) && fs.existsSync(summary5)) {
    const f5 = (await extractDocument(fs.readFileSync(final5), aliasIndex)).structured;
    const s5 = (await extractDocument(fs.readFileSync(summary5), aliasIndex)).structured;
    const c5 = buildTgnpdclClaim({ final: f5, summary: s5 });
    check('bill 5: totals', [f5.totals.grandTotal, f5.totals.netAmount], [299874.99, 299875]);
    check('bill 5: summary (no paid line → paid 0)', [s5.invoiceNo, s5.totals.paid, c5.tabs.summary.employeePaid], ['ICO6076230', 0, 0]);
    // This bill's code column starts at 0.656 of the page width — left of where the others put it.
    const row5 = (code) => c5.tabs.investigations.items.find((r) => r.code === code);
    check('bill 5: codes read', ['584', '2251', '3057', '3055', '82A', '11E', '751A'].map((c) => Boolean(row5(c))), [true, true, true, true, true, true, true]);
    check('bill 5: tariff marks and merged ECGs', [row5('584').tariff, row5('3057').tariff, row5('3055').qty, row5('3055').amountClaimed], ['COMM', 'NIMS', 4, 300]);
    check('bill 5: no quantity mistaken for a code', f5.sections.flatMap((s) => s.groups.flatMap((g) => g.items)).filter((i) => i.issues.some((m) => /could not be read — 1 assumed/.test(m))).map((i) => i.description), []);
    check('bill 5: own-code rows', c5.tabs.investigations.ownItems.map((r) => [r.code, r.qty, r.amountClaimed]), [['YSSH', 1, 15000], ['YSSH', 1, 60000]]);
    check('bill 5: no YSSH among the tariff rows', c5.tabs.investigations.items.filter((r) => r.code === 'YSSH').length, 0);
  } else {
    console.log('SKIP  bill 5 checks (test-fixtures/bills/case-05-tgnpdcl-yssh/*-bill.pdf missing)');
  }
  done('yashoda');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
