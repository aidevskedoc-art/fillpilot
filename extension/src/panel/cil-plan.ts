// Coal India e-Arogya Suvidha (cilbpa.utiitsl.com/coal/ipClaim, run by UTIITSL)
// site profile: the claim → the Bill Details tab's actions. Labels are matched
// as written on the site (screenshots, 2026-10-15); a step that fails saves the
// page outline, so the profile can be corrected.
//
// The person opens the claim and its Bill Details tab: the site's tabs may load
// a new page, which would cut a fill off half-way. Room details (room rent itself
// is an Unlisted row), doctor fees, the prior-approval tick, update Room / update
// Date, Save As Draft and Submit IP Bill stay with the person.

import type { CilClaim } from '../../../web/projects/shared/src/api-types';
import type { PageAction } from '../../../web/projects/shared/src/page-contract';

/** The Coal India claim pages of e-Arogya Suvidha. */
export function isCilPage(url: URL | null): boolean {
  return Boolean(url && /(^|\.)cilbpa\.utiitsl\.com$/i.test(url.hostname) && /^\/coal\b/i.test(url.pathname));
}

const BILL_NO = '^\\s*Bill\\s*No\\.?\\s*:?\\s*$';
const BILL_DATE = '^\\s*Bill\\s*Date\\s*:?\\s*$';

/** Captions this profile relies on — located in the page outline saved when a step fails. */
export const CIL_PROBES = [
  'Bill\\s*No', 'Bill\\s*Date', '^\\s*Category\\s*[-–:]+', 'Item\\s*Code', 'Item\\s*Name', 'Quantity', '^\\s*Rate\\s*$',
  'Hospital\\s*Amount', 'Remarks', 'Pharmacy\\s*Amount', 'Grand\\s*Total', 'Admission\\s*No', 'Patient\\s*Name', 'Prior\\s*approval',
];

const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

export function buildCilActions(claim: CilClaim): PageAction[] {
  const actions: PageAction[] = [];
  if (claim.hospitalBillNumber) actions.push({ type: 'setField', field: BILL_NO, value: claim.hospitalBillNumber, label: `Bill No. = ${claim.hospitalBillNumber}` });
  if (claim.billDate) actions.push({ type: 'setField', field: BILL_DATE, value: claim.billDate, calendar: true, label: `Bill Date = ${claim.billDate}` });
  for (const r of claim.cghs) {
    actions.push({
      type: 'addCilRow', section: 'cghs', code: r.code, qty: r.qty, rate: r.rate, amount: r.amount, remarks: r.description,
      label: `CGHS ${r.code} ${r.description} — qty ${r.qty}, bill ${rupees(r.amount)}`,
    });
  }
  for (const r of claim.unlisted) {
    actions.push({
      type: 'addCilRow', section: 'unlisted', code: r.code, qty: r.qty, rate: r.rate, amount: r.amount, name: r.description,
      ...(r.remarks ? { remarks: r.remarks } : {}),
      label: `Unlisted ${r.code} ${r.description} — ${r.qty} × ${rupees(r.rate)}`,
    });
  }
  actions.push({ type: 'checkCilTotals', netAmount: claim.totals.netAmount, pharmacy: claim.pharmacy, notFilled: claim.totals.manual, label: 'Pharmacy Amount and Grand Total against the bill' });
  return actions;
}

/** What a step was, without anything from the bill beyond the item code. */
export function cilAuditLabel(action: PageAction): string {
  switch (action.type) {
    case 'setField': return action.field === BILL_NO ? 'Bill No.' : action.field === BILL_DATE ? 'Bill Date' : 'Field';
    case 'addCilRow': return `${action.section === 'cghs' ? 'CGHS' : 'Unlisted'} ${action.code}`;
    case 'checkCilTotals': return 'Totals check';
    default: return action.label;
  }
}
