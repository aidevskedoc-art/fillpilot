// NTPC Sanjeevani (sanjeevaninew.ntpc.co.in) site profile: the claim → the
// "Patient Discharge" screen's actions (/hospital/discharge). Fields are found by
// their captions. Page structure (copied 2026-11-13, Angular): each caption is a
// <label> in a column of its own (div.col-lg-2), its box in the next (div.col-lg-4)
// — no ids; Admission and Discharge are Chrome's own datetime-local boxes, Bill Date
// a date box the site keeps disabled, the charges number boxes; Total Amount and Bill
// Amount are disabled (the site adds them up). A step that fails saves the page
// outline, so the profile can be corrected.
//
// Filled: the dates, Discharge by (the portal's own user id), Bill No, Bill Date
// and every charge box the summary bill has lines for. Left alone: Total Amount,
// Discount, Bill Amount (the site works them out), Last Tentative Cumulative
// amount, Discharge Summary, Final Diagnosis, the uploads and every button.

import type { NtpcClaim } from '../../../web/projects/shared/src/api-types';
import type { PageAction } from '../../../web/projects/shared/src/page-contract';

/** The Patient Discharge screen of NTPC's Sanjeevani portal. */
export function isNtpcPage(url: URL | null): boolean {
  return Boolean(url && /(^|\.)ntpc\.co\.in$/i.test(url.hostname) && /\/discharge/i.test(url.pathname));
}

const ADMISSION = '^\\s*Admission\\s*Date(\\s*Change)?[\\s:*]*$';
const DISCHARGE = '^\\s*Discharge\\s*Date\\s*(&|and)?\\s*Time[\\s:*]*$';
const DISCHARGE_BY = '^\\s*Discharge\\s*by[\\s:*]*$';
const BILL_NO = '^\\s*Bill\\s*No\\.?[\\s:*]*$';
const BILL_DATE = '^\\s*Bill\\s*Date[\\s:*]*$';

/** Each charge box's caption on the site. */
export const NTPC_BOX: Record<NtpcClaim['charges'][number]['key'], string> = {
  room: '^\\s*Charges\\s*Room[\\s:*]*$',
  procedure: '^\\s*Charges\\s*Procedures?[\\s:*]*$',
  consultation: '^\\s*Consultation\\s*charges[\\s:*]*$',
  drug: '^\\s*Drug\\s*Charges[\\s:*]*$',
  consumables: '^\\s*Consumables?\\s*charges[\\s:*]*$',
  ot: '^\\s*OT\\s*Charges[\\s:*]*$',
  surgery: '^\\s*Surgery\\s*charges[\\s:*]*$',
  implants: '^\\s*Implants?\\s*Charges[\\s:*]*$',
  anesthesia: '^\\s*Ana?esthesia\\s*charges[\\s:*]*$',
  tests: '^\\s*Charges\\s*Tests?[\\s:*]*$',
  others: '^\\s*Charges\\s*Others?[\\s:*]*$',
};

/** Captions this profile relies on — located in the page outline saved when a step fails. */
export const NTPC_PROBES = [
  'Admission\\s*Date', 'Discharge\\s*Date', 'Discharge\\s*by', 'Bill\\s*No', 'Bill\\s*Date', 'Hospital\\s*IPD', 'Charges\\s*Room', 'Consultation',
  'Drug\\s*Charges', 'Implants', 'Charges\\s*Others', 'Total\\s*Amount', 'Bill\\s*Amount', 'Discount', 'Discharge\\s*Summary', 'Logged\\s*in\\s*as',
];

/** Rupees as the site's boxes take them: "4169.25", "39900". */
const amountText = (n: number) => String(Math.round(n * 100) / 100);
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** loginId: the user id after "Logged in as" on the page — Discharge by (the client, 2026-11-13); null when not read. */
export function buildNtpcActions(claim: NtpcClaim, loginId: string | null): PageAction[] {
  const actions: PageAction[] = [];
  if (claim.admissionDateTime) {
    actions.push({ type: 'setDateTime', field: ADMISSION, value: claim.admissionDateTime, label: `Admission Date = ${claim.admissionDateTime}` });
  }
  if (claim.dischargeDateTime) {
    actions.push({ type: 'setDateTime', field: DISCHARGE, value: claim.dischargeDateTime, label: `Discharge Date & Time = ${claim.dischargeDateTime}` });
  }
  if (loginId) actions.push({ type: 'setField', field: DISCHARGE_BY, value: loginId, label: `Discharge by = ${loginId}` });
  if (claim.billNo) actions.push({ type: 'setField', field: BILL_NO, value: claim.billNo, label: `Bill No = ${claim.billNo}` });
  if (claim.billDate) actions.push({ type: 'setDateTime', field: BILL_DATE, value: claim.billDate, label: `Bill Date = ${claim.billDate}` });
  for (const c of claim.charges) {
    actions.push({ type: 'setField', field: NTPC_BOX[c.key], value: amountText(c.amount), keys: true, label: `${c.box} = ${rupees(c.amount)}` });
  }
  return actions;
}

/** What a step was, without anything from the bill. */
export function ntpcAuditLabel(action: PageAction): string {
  if (action.type === 'setDateTime' || action.type === 'setField') return action.label.split(' = ')[0];
  return action.label;
}
