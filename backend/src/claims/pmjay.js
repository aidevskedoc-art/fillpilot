// Yashoda final bill (+ summary bill) → the rows of the PM-JAY "Treatment Plan"
// (provider.nha.gov.in, Transaction Management System). Pure: the route loads
// the documents.
//
// The site adds a treatment by its package code: Procedure (listed as
// "Name(CODE-stratification)"), No. of Days/Units, then "+". The amount is the
// site's own package rate, so only the code and the units come from the bill:
// one row per code, units = how many times the bill charges it (13 HAEMOGRAM
// lines → LB012 × 13; "20 Time(s) x 40.00" counts 20). A line charged under
// several codes ("LB092+93+94") counts once for each of them.

const { addSummaryIssues } = require('./summary-issues');

const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;
const sum = (list) => round2(list.reduce((s, n) => s + (n || 0), 0));

/**
 * final: structured yashoda-final-bill (required). summary: yashoda-summary-bill (optional).
 * → { patient, hospitalBillNumber, procedures, manual, totals, checks }
 */
function buildPmjayClaim({ final, summary }) {
  const checks = [];
  // at: { doc: 'final' | 'summary', page } — where on the bill; the panel opens the PDF there.
  const add = (level, message, at) => checks.push({ level, message, ...(at ? { at } : {}) });

  for (const issue of final.issues || []) add(issue.level, `Final bill: ${issue.message}`, { doc: 'final', page: issue.page ?? null });
  addSummaryIssues(add, final, summary);
  if (summary && final.patient?.ipNo && summary.patient?.ipNo && final.patient.ipNo !== summary.patient.ipNo) {
    add('error', `The bills are for different patients: IP ${final.patient.ipNo} (final) vs IP ${summary.patient.ipNo} (summary)`);
  }
  if (summary && !same(final.totals.grandTotal, summary.totals.gross)) {
    add('error', `Grand total differs: final bill ${final.totals.grandTotal} vs summary bill ${summary.totals.gross}`, { doc: 'final', page: final.grandTotalPage ?? null });
  }

  const procedures = [];
  const byCode = new Map();
  const manual = [];
  const byLine = new Map();
  for (const section of final.sections) {
    for (const g of section.groups) {
      const where = g.name && g.name !== section.name ? `${section.name} / ${g.name}` : section.name;
      for (const item of g.items) {
        // Only a single code can be chosen in the Procedure list; "R171+171" is entered by
        // hand, and so is the hospital's own code (YSSH), which is no package code. Package
        // codes charged as one line ("LB092+93+94", codeParts) are a row for each code.
        if (!item.code || (!item.codeParts && /[+/]/.test(item.code)) || item.ownCode) {
          const key = `${where}|${item.description}`;
          let line = byLine.get(key);
          if (!line) {
            const reason = !item.code ? 'No code on the bill' : item.ownCode ? `Hospital's own code ${item.code}` : `Combined code ${item.code}`;
            line = { section: where, description: item.description, count: 0, amount: 0, reason };
            byLine.set(key, line);
            manual.push(line);
          }
          line.count += item.qty || 1;
          line.amount = round2(line.amount + (item.amount || 0));
          continue;
        }
        const combined = item.codeParts && `${item.code} on the bill is one line for ${item.codeParts.map((p) => p.code).join(', ')} — "${item.description}"`;
        for (const part of item.codeParts ?? [{ code: item.code, amount: item.amount }]) {
          let row = byCode.get(part.code);
          if (!row) {
            row = { code: part.code, units: 0, lines: 0, amountOnBill: 0, description: item.description, section: where, notes: [], descriptions: [] };
            byCode.set(part.code, row);
            procedures.push(row);
          }
          row.units += item.qty || 1;
          row.lines += 1;
          row.amountOnBill = round2(row.amountOnBill + (part.amount || 0));
          if (!row.descriptions.includes(item.description)) row.descriptions.push(item.description);
          for (const message of [...(item.issues || []), combined, part.note]) if (message && !row.notes.includes(message)) row.notes.push(message);
          if (item.tariff && !row.notes.some((n) => n.startsWith('Marked'))) row.notes.push(`Marked ${item.tariff} on the bill — a PM-JAY bill has package codes`);
        }
      }
    }
  }
  for (const r of procedures) {
    if (r.descriptions.length > 1) r.notes.push(`Same code on the bill for: ${r.descriptions.join('; ')}`);
    delete r.descriptions;
  }
  if (!procedures.length) add('warning', 'No item on the bill has a code — nothing can be added to the Treatment Plan');

  return {
    patient: { ...(final.patient || {}), ...(summary?.patient || {}) },
    hospitalBillNumber: summary?.invoiceNo ?? null,
    procedures,
    manual,
    totals: {
      billTotal: final.totals.grandTotal,
      coded: sum(procedures.map((p) => p.amountOnBill)),
      notCoded: sum(manual.map((m) => m.amount)),
    },
    checks,
  };
}

module.exports = { buildPmjayClaim };
