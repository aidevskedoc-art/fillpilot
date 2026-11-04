// Makes the SPDCL Excel from a pair of HIS exports and compares it, row by
// row, with one the billing team made by hand. For checking on real files —
// they hold patient data, so they stay where they are and are never added here.
//
//   node scripts/spdcl-compare.js <final-bill.xlsx> <pharmacy-bill.xlsx> [<expected.xlsx>] [--out <made.xlsx>] [--admission dd/mm/yyyy]
const fs = require('fs');
const { readFirstSheet } = require('../src/claims/xlsx');
const spdcl = require('../src/claims/spdcl');
const { writeSpdclWorkbook } = require('../src/claims/spdcl-workbook');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
};
const out = option('--out');
const admissionDate = option('--admission');
const [finalPath, pharmacyPath, expectedPath] = args;
if (!finalPath || !pharmacyPath) {
  console.log('Usage: node scripts/spdcl-compare.js <final-bill.xlsx> <pharmacy-bill.xlsx> [<expected.xlsx>] [--out <made.xlsx>] [--admission dd/mm/yyyy]');
  process.exit(2);
}

const final = spdcl.parseFinalBill(readFirstSheet(fs.readFileSync(finalPath)).rows);
const pharmacy = spdcl.parsePharmacyBill(readFirstSheet(fs.readFileSync(pharmacyPath)).rows);
const sheet = spdcl.buildSpdclSheet({ final, pharmacy, admissionDate });
const file = writeSpdclWorkbook(sheet);
if (out) {
  fs.writeFileSync(out, file);
  console.log(`Written: ${out}`);
}

console.log(`IP ${sheet.patient.ipNo} · admission ${sheet.admissionDate}${sheet.admissionAssumed ? ' (earliest date on the bills)' : ''} · last date ${sheet.lastDate} · ${sheet.stayDays} billed day(s)`);
for (const h of sheet.heads) console.log(`  ${JSON.stringify(h.head).padEnd(36)} ${String(h.rows).padStart(4)} rows  ${h.amount}`);
console.log(`Rows ${sheet.rows.length} · SPDCL total ${sheet.totals.excel} · HIS bill ${sheet.totals.hisBill} · difference ${sheet.totals.difference}`);
for (const c of sheet.checks) console.log(`  [${c.level}] ${c.message}`);

// What SPDCL will read: our own file, read back.
const COLS = 'ABCDEFGHIJK';
const dataRows = (rows) => rows.slice(1).filter((r) => r.slice(0, 11).some((v) => v != null && v !== ''));
const made = dataRows(readFirstSheet(file).rows);
if (made.length !== sheet.rows.length) console.log(`!! The file has ${made.length} rows, the sheet ${sheet.rows.length}`);

if (expectedPath) {
  const expected = dataRows(readFirstSheet(fs.readFileSync(expectedPath)).rows);
  console.log(`\nCompared with ${expectedPath}: ${made.length} rows made, ${expected.length} expected`);
  const differences = [];
  for (let r = 0; r < Math.max(made.length, expected.length); r++) {
    const a = made[r] ?? [];
    const b = expected[r] ?? [];
    for (let c = 0; c < COLS.length; c++) {
      const x = a[c] ?? null;
      const y = b[c] ?? null;
      const equal = typeof x === 'number' || typeof y === 'number'
        ? Math.abs(Number(x) - Number(y)) < 0.005
        : String(x ?? '') === String(y ?? '');
      if (!equal) differences.push(`  row ${r + 2} ${COLS[c]}: made ${JSON.stringify(x)}, expected ${JSON.stringify(y)}   (${a[4] ?? b[4]})`);
    }
  }
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + (Number(r[10]) || 0), 0) * 100) / 100;
  console.log(`Total Amount: made ${sum(made)}, expected ${sum(expected)}`);
  console.log(differences.length ? `${differences.length} cell(s) differ:\n${differences.slice(0, 60).join('\n')}${differences.length > 60 ? '\n  …' : ''}` : 'Every cell matches.');
}
