// npm run team-report -- [from] [to] — the dashboard's Team report as a CSV
// file, without the dashboard: per person, bills read per site, PDFs, pages,
// fills. Dates are YYYY-MM-DD, both days included; by default this month so far.
//   npm.cmd run team-report -- 2026-10-01 2026-10-31
// The file goes to backend/reports/ (gitignored).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { teamReport } = require('../src/team-report');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Local midnight of a 'YYYY-MM-DD', `addDays` later. */
function midnight(text, name, addDays = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${name} must be a date like 2026-10-01 (got "${text}")`);
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d + addDays);
}

(async () => {
  const now = new Date();
  const fromText = process.argv[2] || ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  const toText = process.argv[3] || ymd(now);
  const from = midnight(fromText, 'From');
  const to = midnight(toText, 'To', 1); // the whole last day
  if (from >= to) throw new Error(`From (${fromText}) must not be after To (${toText})`);

  const { rows } = await teamReport(from, to);

  const head = ['Person', 'Username', 'TGNPDCL', 'PM-JAY', 'Coal India', 'Bills', 'PDFs', 'Pages', 'Other PDFs', 'Fills', 'Steps done', 'Failed', 'Last active'];
  const lines = rows.map((u) => [
    u.fullName, u.username, u.bills.tgnpdcl, u.bills.pmjay, u.bills.cil, u.bills.total, u.pdfs, u.pages, u.uploads,
    u.fills, u.stepsDone, u.stepsFailed, u.lastActive ? new Date(u.lastActive).toLocaleString('en-IN') : 'Never',
  ]);
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [head, ...lines].map((row) => row.map(cell).join(',')).join('\r\n');
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `FillPilot-team-report_${fromText}_to_${toText}.csv`);
  fs.writeFileSync(file, `﻿${csv}`); // the BOM makes Excel read it as UTF-8

  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  console.log(`\nFillPilot team report, ${fromText} to ${toText}\n`);
  console.table(rows.map((u) => ({
    Person: u.fullName, TGNPDCL: u.bills.tgnpdcl, 'PM-JAY': u.bills.pmjay, 'Coal India': u.bills.cil,
    PDFs: u.pdfs, Fills: u.fills, Failed: u.stepsFailed,
  })));
  console.log(`Bills read: ${sum((r) => r.bills.total)} (TGNPDCL ${sum((r) => r.bills.tgnpdcl)}, PM-JAY ${sum((r) => r.bills.pmjay)}, Coal India ${sum((r) => r.bills.cil)})`);
  console.log(`PDFs: ${sum((r) => r.pdfs)} (${sum((r) => r.pages)} pages) · Fills: ${sum((r) => r.fills)} · People who used it: ${rows.filter((r) => r.bills.total || r.fills || r.uploads).length} of ${rows.length}`);
  console.log(`\nSaved: ${file}`);
  await db.pool.end();
})().catch(async (err) => {
  console.error('Report failed:', err.message);
  await db.pool.end().catch(() => {});
  process.exitCode = 1;
});
