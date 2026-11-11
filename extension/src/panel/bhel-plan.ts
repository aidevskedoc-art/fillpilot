// BHEL claims on KareXpert (bhel.karexpert.com) site profile: the claim → the
// "Upload Bill" screen's actions (/insurance/insurance_billing_miscllaneous/add).
// Fields are found by the ids in the page structure the user copied
// (2026-11-09), else by their captions; a step that fails saves the page
// outline, so the profile can be corrected.
//
// The person picks the branch (unit) and opens the patient's Upload Bill
// screen. Payment Details, Document Upload, Diagnosis, Draft and Accept stay
// with the person.

import type { BhelClaim } from '../../../web/projects/shared/src/api-types';
import type { PageAction } from '../../../web/projects/shared/src/page-contract';

/** The Upload Bill screen of the BHEL KareXpert portal. */
export function isBhelPage(url: URL | null): boolean {
  return Boolean(url && /^bhel\.karexpert\.com$/i.test(url.hostname) && /\/insurance\/insurance_billing_misc/i.test(url.pathname));
}

const VISIT_ID = '^\\s*Visit\\s*ID\\s*\\*?\\s*$';
const BILL_NO = '^\\s*Bill\\s*No\\.?\\s*\\*?\\s*$';
const VISIT_DATE = '^\\s*Visit\\s*Date\\s*Time\\s*\\*?\\s*$';
const DISCHARGE_DATE = '^\\s*Discharge\\s*Date\\s*Time\\s*\\*?\\s*$';
const BILL_DATE = '^\\s*Bill\\s*Date\\s*Time\\s*\\*?\\s*$';

/** Captions this profile relies on — located in the page outline saved when a step fails. */
export const BHEL_PROBES = [
  'Visit\\s*ID', 'Bill\\s*No', 'Visit\\s*Date', 'Discharge\\s*Date', 'Bill\\s*Date', 'Service\\s*Type', 'Service\\s*Item', 'Priority',
  'Quantity', '^\\s*Amount', 'Discount', 'Remarks', '^\\s*\\+?\\s*Add\\s*\\+?\\s*$', 'Total\\s*Amount', 'Net\\s*Amount', 'Apply',
];

const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

export function buildBhelActions(claim: BhelClaim): PageAction[] {
  const actions: PageAction[] = [];
  if (claim.visitId) actions.push({ type: 'setField', field: VISIT_ID, id: 'encounter_id', value: claim.visitId, label: `Visit ID = ${claim.visitId}` });
  if (claim.billNo) actions.push({ type: 'setField', field: BILL_NO, id: 'bill_no', value: claim.billNo, label: `Bill No = ${claim.billNo}` });
  if (claim.visitDateTime) actions.push({ type: 'setDateTime', field: VISIT_DATE, id: 'admission_date_time', value: claim.visitDateTime, label: `Visit Date Time = ${claim.visitDateTime}` });
  if (claim.dischargeDateTime) {
    actions.push({ type: 'setDateTime', field: DISCHARGE_DATE, id: 'discharge_date_time', value: claim.dischargeDateTime, label: `Discharge Date Time = ${claim.dischargeDateTime}` });
  }
  if (claim.billDateTime) actions.push({ type: 'setDateTime', field: BILL_DATE, id: 'bill_date_time', value: claim.billDateTime, label: `Bill Date Time = ${claim.billDateTime}` });
  for (const r of claim.rows) {
    actions.push({
      type: 'addBhelRow', serviceType: r.serviceType, qty: r.qty, amount: r.amount, remarks: r.remarks,
      ...(r.byRemarks ? { byRemarks: true } : {}),
      label: `${r.serviceType} — ${rupees(r.amount)} — ${r.remarks}`,
    });
  }
  if (claim.rows.length) {
    actions.push({ type: 'checkBhelTotals', rowsTotal: claim.totals.rows, netAmount: claim.totals.netAmount, notFilled: claim.totals.manual, label: 'Total Amount against the bill' });
  }
  return actions;
}

/** What a step was, without anything from the bill beyond the Service Type. */
export function bhelAuditLabel(action: PageAction): string {
  switch (action.type) {
    case 'setField': return action.id === 'encounter_id' ? 'Visit ID' : action.id === 'bill_no' ? 'Bill No' : 'Field';
    case 'setDateTime': return action.id === 'admission_date_time' ? 'Visit Date Time' : action.id === 'discharge_date_time' ? 'Discharge Date Time' : 'Bill Date Time';
    // Remarks of Other Unlisted Item rows are the bill's section names (no patient data).
    case 'addBhelRow': return `Bill Details ${action.serviceType}${action.byRemarks ? ` ${action.remarks}` : ''}`;
    case 'checkBhelTotals': return 'Totals check';
    default: return action.label;
  }
}
