// node scripts/bill-accuracy.js [draft [case] | case-filter]
//
// How well the Yashoda bills are read — measured on real bill pairs, value by
// value. Each case is a folder in test-fixtures/bills/ (gitignored: patient
// data) with one patient's final bill and summary bill PDFs (any file names)
// and expected.json: what the bills say, checked by a person against the paper.
//
//   draft [case]   reads the PDFs and writes expected.draft.json — what the tool
//                  read, in the same shape. Check every value against the bill,
//                  correct the wrong ones, add what it missed, then rename it to
//                  expected.json. Without a case: every case that has no
//                  expected.json yet.
//   (no argument)  reads every case that has an expected.json and reports how
//                  many values came out right, per case and overall.
//
// Read exactly as POST /api/claims/tgnpdcl reads them, so the figure is what
// the panel shows. Needs OCR (Windows), about 15 s per pair.
const fs = require('fs');
const path = require('path');
const { extractDocument } = require('../src/extraction/extract');
const { buildTgnpdclClaim } = require('../src/claims/tgnpdcl');
const { ocrAvailable } = require('../src/ocr');
const { normLabel } = require('../src/text/labels');

const BILLS = path.join(__dirname, '..', 'test-fixtures', 'bills');
const DRAFT_NOTE = 'What FillPilot read from these bills. Check EVERY value against the paper bill: fix the wrong ones, add rows it missed, '
  + 'delete rows that are not on the bill. Then rename this file to expected.json. ("description" only names a row for you — it is compared only for rows without a code.)';

async function readCase(dir) {
  const read = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f))) {
    try {
      const { docType, structured } = await extractDocument(fs.readFileSync(path.join(dir, file)));
      read.push({ file, docType, structured });
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
  }
  const finals = read.filter((r) => r.docType === 'yashoda-final-bill');
  const summaries = read.filter((r) => r.docType === 'yashoda-summary-bill');
  if (finals.length !== 1 || summaries.length > 1) {
    const found = read.map((r) => `${r.file}: ${r.docType || 'not a Yashoda bill'}`).join(', ') || 'no PDF';
    throw new Error(`needs one final bill and at most one summary bill (found ${found})`);
  }
  return buildTgnpdclClaim({ final: finals[0].structured, summary: summaries[0]?.structured });
}

/** The claim as the values a person can check on the paper bill. */
function snapshot(claim) {
  const { room, investigations, pharmacy, summary } = claim.tabs;
  return {
    patient: { ipNo: claim.patient.ipNo ?? null, name: claim.patient.name ?? null, billNumber: claim.hospitalBillNumber ?? null },
    billTotal: claim.totals.billTotal ?? null,
    employeePaid: summary.employeePaid ?? null,
    pharmacyTotal: pharmacy.total ?? null,
    implantsTotal: investigations.implants?.amount ?? null,
    icuDays: room.icuDays,
    wards: room.wards.map((w) => ({ ratePerDay: w.ratePerDay, days: w.days })),
    doctors: room.doctors.map((d) => ({ name: d.name, days: d.days })),
    // The hospital's own codes (YSSH) are bill lines too — counted with the tariff rows.
    investigations: [...investigations.items, ...(investigations.ownItems || [])]
      .map((i) => ({ code: i.code ?? null, tariff: i.tariff ?? null, qty: i.qty, amount: i.amountClaimed ?? null, description: i.description })),
  };
}

const text = (v) => String(v).replace(/\s+/g, ' ').trim();
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.011;
  return text(a) === text(b);
}

/** expected vs read → { checks: [{ area, what, want, got, outcome }], extras: [{ area, what }] } */
function compare(want, got) {
  const checks = [];
  const extras = [];
  const check = (area, what, w, g) => checks.push({ area, what, want: w, got: g, outcome: same(w, g) ? 'ok' : g == null ? 'missing' : 'wrong' });

  for (const key of ['ipNo', 'name', 'billNumber']) check('patient', key, want.patient?.[key] ?? null, got.patient[key]);
  for (const key of ['billTotal', 'employeePaid', 'pharmacyTotal', 'implantsTotal']) check('totals', key, want[key] ?? null, got[key]);
  check('room', 'ICU days', want.icuDays ?? 0, got.icuDays);
  const wards = want.wards || [];
  wards.forEach((w, i) => {
    check('room', `ward ${i + 1} rate/day`, w.ratePerDay, got.wards[i]?.ratePerDay ?? null);
    check('room', `ward ${i + 1} days`, w.days, got.wards[i]?.days ?? null);
  });
  got.wards.slice(wards.length).forEach((w, i) => extras.push({ area: 'room', what: `ward ${wards.length + i + 1} (${w.ratePerDay}/day x ${w.days})` }));

  // Rows are matched by what identifies them on the site; each expected row
  // counts once for being found and once per value.
  const rows = (area, wantRows, gotRows, keyOf, nameOf, fields) => {
    const left = new Map();
    for (const g of gotRows) left.set(keyOf(g), [...(left.get(keyOf(g)) || []), g]);
    for (const w of wantRows) {
      const g = left.get(keyOf(w))?.shift() ?? null;
      check(area, nameOf(w), 'found', g ? 'found' : null);
      for (const f of fields) check(area, `${nameOf(w)} ${f}`, w[f] ?? null, g ? g[f] ?? null : null);
    }
    for (const rest of left.values()) for (const g of rest) extras.push({ area, what: nameOf(g) });
  };
  rows('doctors', want.doctors || [], got.doctors, (d) => normLabel(d.name), (d) => `doctor ${d.name}`, ['days']);
  // The hospital's own code (YSSH, no digits) names many items — those rows are matched by description too.
  rows('investigations', want.investigations || [], got.investigations,
    (i) => (!i.code ? `-${normLabel(i.description)}` : /\d/.test(i.code) ? `${i.code}|${i.tariff || ''}` : `${i.code}|${normLabel(i.description)}`),
    (i) => (i.code ? `${i.code}${i.tariff ? `/${i.tariff}` : ''} (${i.description})` : `"${i.description}"`),
    ['qty', 'amount']);
  return { checks, extras };
}

const pct = (ok, all) => (all ? `${((100 * ok) / all).toFixed(1)}%` : '—');
const shown = (v) => (v == null ? 'nothing' : JSON.stringify(v));

function caseDirs(filter) {
  if (!fs.existsSync(BILLS)) return [];
  return fs.readdirSync(BILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!filter || d.name.includes(filter)))
    .map((d) => path.join(BILLS, d.name))
    .sort();
}

async function draft(which) {
  const dirs = which
    ? [fs.existsSync(which) ? which : path.join(BILLS, which)]
    : caseDirs().filter((d) => !fs.existsSync(path.join(d, 'expected.json')));
  if (!dirs.length) return console.log(`Nothing to draft: every case in ${BILLS} has an expected.json.`);
  for (const dir of dirs) {
    try {
      const claim = await readCase(dir);
      const out = path.join(dir, 'expected.draft.json');
      fs.writeFileSync(out, `${JSON.stringify({ _note: DRAFT_NOTE, ...snapshot(claim) }, null, 2)}\n`);
      console.log(`DRAFT ${path.basename(dir)}: ${out}`);
    } catch (err) {
      process.exitCode = 1;
      console.log(`ERROR ${path.basename(dir)}: ${err.message}`);
    }
  }
}

async function score(filter) {
  const dirs = caseDirs(filter).filter((d) => fs.existsSync(path.join(d, 'expected.json')));
  if (!dirs.length) {
    return console.log(`SKIP  no case with an expected.json in ${BILLS} — put each bill pair in its own folder there, then run "draft".`);
  }
  const all = { checks: [], extras: [] };
  for (const dir of dirs) {
    const name = path.basename(dir);
    let result;
    try {
      result = compare(JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')), snapshot(await readCase(dir)));
    } catch (err) {
      process.exitCode = 1;
      console.log(`ERROR ${name}: ${err.message}`);
      continue;
    }
    const { checks, extras } = result;
    const ok = checks.filter((c) => c.outcome === 'ok').length;
    const count = (o) => checks.filter((c) => c.outcome === o).length;
    console.log(`${name.padEnd(24)} ${ok}/${checks.length + extras.length} right  ${pct(ok, checks.length + extras.length).padStart(6)}`
      + `   (${count('wrong')} wrong, ${count('missing')} missing, ${extras.length} extra)`);
    for (const c of checks.filter((x) => x.outcome !== 'ok')) {
      console.log(`    ${c.outcome.padEnd(8)} ${c.area.padEnd(15)} ${c.what}: bill ${shown(c.want)}, read ${shown(c.got)}`);
    }
    for (const e of extras) console.log(`    ${'extra'.padEnd(8)} ${e.area.padEnd(15)} ${e.what}: not on the bill`);
    all.checks.push(...checks);
    all.extras.push(...extras);
  }

  const ok = all.checks.filter((c) => c.outcome === 'ok').length;
  console.log(`\nALL ${dirs.length} case(s): ${ok}/${all.checks.length + all.extras.length} values right: ${pct(ok, all.checks.length + all.extras.length)}`);
  for (const area of ['patient', 'totals', 'room', 'doctors', 'investigations']) {
    const inArea = all.checks.filter((c) => c.area === area);
    const extra = all.extras.filter((e) => e.area === area).length;
    const right = inArea.filter((c) => c.outcome === 'ok').length;
    if (inArea.length || extra) console.log(`    ${area.padEnd(15)} ${`${right}/${inArea.length + extra}`.padStart(9)}  ${pct(right, inArea.length + extra).padStart(6)}`);
  }
}

if (require.main === module) {
  (async () => {
    if (!ocrAvailable()) {
      console.log('SKIP  the bills are images and OCR is not available here (OCR_PROVIDER=off, or not Windows without Tesseract).');
      return;
    }
    const [mode, arg] = process.argv.slice(2);
    if (mode === 'draft') await draft(arg);
    else await score(mode);
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { compare, snapshot };
