// node scripts/test-yashoda.js — Yashoda bills (image PDFs → OCR) → structured
// data → TGNPDCL claim. Needs the real bills in test-fixtures/ (gitignored)
// and Windows OCR; the pure helpers are checked everywhere.
const fs = require('fs');
const path = require('path');
const { extractDocument } = require('../src/extraction/extract');
const { normalizeCode, parseAmount, parseQuantity } = require('../src/extraction/formats/yashoda');
const { buildTgnpdclClaim } = require('../src/claims/tgnpdcl');
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
check('amount Indian grouping', parseAmount('2,01,742.72'), 201742.72);
check('amount OCR i → 1', parseAmount('i, 575.00'), 1575);
check('amount unreadable', parseAmount('1,5?5.0'), null);
check('quantity', parseQuantity('15 Time(s) x 45.00'), { qty: 15, unit: 'Time', rate: 45 });

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
  done('yashoda');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
