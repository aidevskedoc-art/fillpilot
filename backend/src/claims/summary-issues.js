// The summary bill's own reading problems, as the claim builders list them — with
// one thing only both bills together can settle: summary amounts OCR could not
// read ("O" for 18,000.00). The summary reader says what its total leaves for them
// (unreadableCharges); when the final bill's sections of the same names add up to
// exactly that, the amounts are known and the doubt is replaced by an info line.
// Pure.
const { normLabel } = require('../text/labels');

const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;

/** The final bill's totals by name — each group's, and each section's (all its groups). */
function finalTotalsByName(final) {
  const byName = new Map();
  const addTo = (key, amount) => key && byName.set(key, round2((byName.get(key) || 0) + (amount || 0)));
  for (const s of final?.sections || []) {
    for (const g of s.groups) {
      const amount = g.subTotal ?? round2(g.items.reduce((n, i) => n + (i.amount || 0), 0));
      const group = normLabel(g.name || s.name);
      addTo(group, amount);
      if (normLabel(s.name) !== group) addTo(normLabel(s.name), amount);
    }
  }
  return byName;
}

/**
 * → the summary's issues to list ({ level, message, page }, unchanged otherwise).
 * add(level, message, at) is the builder's own.
 */
function addSummaryIssues(add, final, summary) {
  const u = summary?.unreadableCharges;
  let confirmed = null;
  if (u) {
    const byName = finalTotalsByName(final);
    const found = u.names.map((n) => byName.get(normLabel(n)));
    const total = round2(found.reduce((n, a) => n + (a || 0), 0));
    if (found.every((a) => a != null) && same(total, u.amount)) {
      confirmed = `Summary bill: ${u.names.map((n, i) => `${n} ${found[i].toFixed(2)}`).join(', ')} — not readable on the summary, taken from the final bill; `
        + `together ${total.toFixed(2)}, exactly what the summary's total leaves for them`;
    }
  }
  for (const issue of summary?.issues || []) {
    if (confirmed && issue.code === 'unreadable-charges') {
      add('info', confirmed, { doc: 'summary', page: issue.page ?? null });
      continue;
    }
    add(issue.level, `Summary bill: ${issue.message}`, { doc: 'summary', page: issue.page ?? null });
  }
}

module.exports = { addSummaryIssues, finalTotalsByName };
