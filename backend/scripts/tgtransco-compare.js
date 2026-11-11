// Makes the TG Transco bill file from a pair of HIS exports and compares it with
// one the billing team made by hand: every row matched by its cells, in any
// order (the team orders rows by hand), and the date box. For checking on real
// files — they hold patient data, so they stay where they are and are never added here.
//
//   node scripts/tgtransco-compare.js <final-bill.xlsx> <pharmacy-bill.xlsx> [<expected.xlsx>] [--out <made.xlsx>]
//        [--admission dd/mm/yyyy] [--discharge dd/mm/yyyy] [--surgery dd/mm/yyyy]
const fs = require('fs');
const { readFirstSheet } = require('../src/claims/xlsx');
const spdcl = require('../src/claims/spdcl');
const { buildTgTranscoSheet } = require('../src/claims/tgtransco');
const { writeTgTranscoWorkbook } = require('../src/claims/tgtransco-workbook');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
};
const out = option('--out');
const admissionDate = option('--admission');
const dischargeDate = option('--discharge');
const surgeryDate = option('--surgery');
const [finalPath, pharmacyPath, expectedPath] = args;
if (!finalPath || !pharmacyPath) {
  console.log('Usage: node scripts/tgtransco-compare.js <final-bill.xlsx> <pharmacy-bill.xlsx> [<expected.xlsx>] [--out <made.xlsx>] [--admission d] [--discharge d] [--surgery d]');
  process.exit(2);
}

const final = spdcl.parseFinalBill(readFirstSheet(fs.readFileSync(finalPath)).rows);
const pharmacy = spdcl.parsePharmacyBill(readFirstSheet(fs.readFileSync(pharmacyPath)).rows);
const sheet = buildTgTranscoSheet({ final, pharmacy, admissionDate, dischargeDate, surgeryDate });
const file = writeTgTranscoWorkbook(sheet);
if (out) {
  fs.writeFileSync(out, file);
  console.log(`Written: ${out}`);
}

console.log(`IP ${sheet.patient.ipNo} · admission ${sheet.admissionDate}${sheet.admissionAssumed ? ' (earliest date on the bills)' : ''} · discharge ${sheet.dischargeDate ?? '—'} · surgery ${sheet.surgeryDate ?? '—'} · last date ${sheet.lastDate}`);
for (const h of sheet.heads) console.log(`  ${h.head.padEnd(30)} ${String(h.rows).padStart(4)} rows  ${h.amount}`);
console.log(`Rows ${sheet.rows.length} · total ${sheet.totals.excel} (package ${sheet.totals.package}) · HIS bill ${sheet.totals.hisBill} · difference ${sheet.totals.difference}`);
for (const c of sheet.checks) console.log(`  [${c.level}] ${c.message}`);

// What TG Transco will read: our own file, read back. A row is filled when any of B..I is.
const dataRows = (rows) => rows.slice(1).filter((r) => r.slice(1, 9).some((v) => v != null && v !== ''));
const dateBox = (rows) => [3, 4, 5].map((r) => rows[r]?.[13] ?? null);
const madeRows = readFirstSheet(file).rows;
const made = dataRows(madeRows);
if (made.length !== sheet.rows.length) console.log(`!! The file has ${made.length} rows, the sheet ${sheet.rows.length}`);

if (expectedPath) {
  const expectedRows = readFirstSheet(fs.readFileSync(expectedPath)).rows;
  const expected = dataRows(expectedRows);
  console.log(`\nCompared with ${expectedPath}: ${made.length} rows made, ${expected.length} expected`);
  const text = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v).trim());
  const key = (r) => r.slice(1, 9).map(text).join(' | ');
  const left = new Map();
  for (const r of expected) left.set(key(r), (left.get(key(r)) ?? 0) + 1);
  const extra = [];
  for (const r of made) {
    const k = key(r);
    if (left.get(k)) left.set(k, left.get(k) - 1);
    else extra.push(k);
  }
  const missing = [...left].flatMap(([k, n]) => Array(n).fill(k));
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + (Number(r[7]) || 0) * (Number(r[8]) || 0), 0) * 100) / 100;
  console.log(`Amount (Rate × Qty): made ${sum(made)}, expected ${sum(expected)}`);
  console.log(`Date box (N4:N6): made ${JSON.stringify(dateBox(madeRows))}, expected ${JSON.stringify(dateBox(expectedRows))}`);
  if (!extra.length && !missing.length) console.log('Every row matches (in any order).');
  if (extra.length) console.log(`${extra.length} row(s) made that the team's file does not have:\n${extra.map((k) => `  + ${k}`).join('\n')}`);
  if (missing.length) console.log(`${missing.length} row(s) in the team's file that were not made:\n${missing.map((k) => `  - ${k}`).join('\n')}`);
}
