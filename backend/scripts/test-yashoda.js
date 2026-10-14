// node scripts/test-yashoda.js — Yashoda bills (image PDFs → OCR) → structured
// data → TGNPDCL claim. Needs the real bills in test-fixtures/ (gitignored)
// and Windows OCR; the pure helpers are checked everywhere.
const fs = require('fs');
const path = require('path');
const { extractDocument } = require('../src/extraction/extract');
const { normalizeCode, parseAmount, parseQuantity, parseFinalBill } = require('../src/extraction/formats/yashoda');
const { buildTgnpdclClaim } = require('../src/claims/tgnpdcl');
const { buildPmjayClaim } = require('../src/claims/pmjay');
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

const FIXTURES = path.join(__dirname, '..', 'test-fixtures');
const finalPdf = path.join(FIXTURES, 'yashoda-final-bill.pdf');
const summaryPdf = path.join(FIXTURES, 'yashoda-summary-bill.pdf');

(async () => {
  if (!ocrAvailable() || !fs.existsSync(finalPdf) || !fs.existsSync(summaryPdf)) {
    console.log('SKIP  real-bill checks (need Windows OCR and test-fixtures/yashoda-*-bill.pdf)');
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
  const final2 = path.join(FIXTURES, 'yashoda-final-bill-2.pdf');
  const summary2 = path.join(FIXTURES, 'yashoda-summary-bill-2.pdf');
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
    console.log('SKIP  bill 2 checks (test-fixtures/yashoda-*-bill-2.pdf missing)');
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
  done('yashoda');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
