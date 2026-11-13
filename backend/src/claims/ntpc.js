// Yashoda summary bill → the "Patient Discharge" screen of NTPC's Sanjeevani
// portal (sanjeevaninew.ntpc.co.in/hospital/discharge). Pure: the route loads
// the documents. The client, 2026-11-13 — "like BHEL":
//
//   Admission Date Change    D.O.A                 Discharge Date & Time   D.O.D
//   Bill No                  the summary bill's invoice number (ICO…)
//   Bill Date                D.O.D's date
//   Discharge by             the hospital's user id the portal shows ("Logged in as … (0610)") —
//                            read on the page by the extension, not from the bill
//   Charges Room             ROOM RENT
//   Charges Procedure        PROCEDURE CHARGES, BED SIDE PROCEDURE CHARGES, CATHETERIZATION
//   Consultation charges     DOCTOR FEES (consultations)
//   Drug Charges             PHARMACY
//   Consumables charges      CONSUMABLES / DISPOSABLES
//   OT Charges               OPERATION THEATRE CHARGES
//   Surgery charges          SURGERY CHARGES, ASSISTANT SURGEON
//   Implants Charges         MEDICAL APPLIANCES
//   Anesthesia charges       ANAESTHESIOLOGY
//   Charges Tests            the lab, radiology and cardiology lines (HAEMATOLOGY, CT SCAN, CARDIOLOGY…)
//   Charges Others           every other line, added up (ICU, alpha bed, SDP / blood transfusion,
//                            physiotherapy, instrument charges… — as BHEL's Other Unlisted Item)
// A box the bill has no line for stays empty.
//
// Only the summary bill is needed: its amounts are NTPC's, after the discount
// ("SDP TRANSFUSSION (1,650.00 - 20.00 %) 1,320.00"). A final bill chosen with
// it is only checked to be the same patient's. Total Amount, Discount and Bill
// Amount are left alone: the site works out its totals. Nothing is saved or
// submitted on the site.

const { addSummaryIssues } = require('./summary-issues');

const round2 = (n) => Math.round(n * 100) / 100;
const sum = (list) => round2(list.reduce((s, n) => s + (n || 0), 0));
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;

/** ICU / ICCU bed charges are not room rent: they go to Charges Others (as on BHEL). */
const ICU = /\bI?CCU\b|\bICU\b|INTENSIVE/i;

/**
 * The screen's charge boxes, in their order on it, each with the summary lines
 * that go to it: every box the bill has a line for is filled (the client,
 * 2026-11-13: "Anesthesia charges and so on — it is in our summary"). A line
 * that fits none goes to Charges Others. Add a pattern here to bring more lines
 * under a box.
 */
const TESTS = new RegExp([
  'LABORATORY', '\\bLAB\\b', 'PATHOLOG', 'HA?EMATOLOG', 'BIO\\s*-?\\s*CHEM', 'MICRO\\s*BIOLOG', 'MOLECULAR', 'SEROLOG', 'CYTOLOG', 'IMMUNOLOG',
  'PARASITOLOG', 'GROUPING', 'TRANSFUSION\\s*MEDICINE', 'INVESTIGATION', 'RADIOLOG', 'RADIOGRAPH', 'X[\\s-]?RAY', 'ULTRA\\s*SOUND', '\\bUSG\\b',
  'C\\.?T\\.?\\s*SCAN', '\\bCT\\b', '\\bMRI\\b', 'IMAGING', 'DOPPLER', 'MAMMOGRA', 'NUCLEAR\\s*MEDICINE', 'CARDIOLOGY', '\\bE\\.?C\\.?G\\b',
  '\\bECHO\\b', '\\bTMT\\b', 'HOLTER', '\\bRBS\\b', 'GLUCOMETER',
].join('|'), 'i');
const BOXES = [
  { key: 'room', box: 'Charges Room', test: /ROOM\s*RENT|WARD\s*CHARGES|\bBED\s*CHARGES/i },
  { key: 'procedure', box: 'Charges Procedure', test: /PROCEDURE|CATHETERI[SZ]ATION/i },
  { key: 'consultation', box: 'Consultation charges', test: /DOCTOR|CONSULTATION/i },
  { key: 'drug', box: 'Drug Charges', test: /PHARMACY|MEDICINE\s*CHARGES|\bDRUGS?\b/i },
  { key: 'consumables', box: 'Consumables charges', test: /CONSUMABLE|DISPOSABLE/i },
  { key: 'ot', box: 'OT Charges', test: /OPERATION\s*THEAT(RE|ER)|\bO\.?\s*T\.?\s*CHARGES/i },
  { key: 'surgery', box: 'Surgery charges', test: /SURGERY|SURGEON|SURGICAL/i },
  { key: 'implants', box: 'Implants Charges', test: /MEDICAL\s*APPLIANCE|IMPLANT/i },
  { key: 'anesthesia', box: 'Anesthesia charges', test: /AN(A)?ESTHE/i },
  { key: 'tests', box: 'Charges Tests', test: TESTS },
];
const OTHERS = { key: 'others', box: 'Charges Others' };
/**
 * Tried in this order: "MEDICAL APPLIANCES" is not a drug; "SURGICAL PATHOLOGY" and "TRANSFUSION MEDICINE" are tests;
 * "BED SIDE PROCEDURE CHARGES" is a procedure, not a bed; ICU bed charges are not room rent (checked before all).
 */
const MATCH_ORDER = ['implants', 'drug', 'tests', 'anesthesia', 'ot', 'surgery', 'procedure', 'consumables', 'room', 'consultation']
  .map((key) => BOXES.find((b) => b.key === key));

/** The bill is made out to NTPC ("NATIONAL THERMAL POWER CORPORATION"). */
const NTPC_COMPANY = /\bNTPC\b|NATIONAL\s*THERMAL/i;

/** "SDP TRANSFUSSION (1,650.00 - 20.00 %)" → "SDP TRANSFUSSION": the discount the line shows is not its name. */
const lineName = (name) => String(name || '').replace(/\(\s*[\d,.\s]+-\s*[\d,.\s]+%?\s*\)/g, ' ').replace(/\s+/g, ' ').trim();

/** { date: "2026-11-03", time: "16:54" } → "03-11-2026 16:54", as the site's date boxes show it. */
function siteDateTime(when) {
  if (!when?.date) return null;
  const [y, m, d] = when.date.split('-');
  return when.time ? `${d}-${m}-${y} ${when.time}` : `${d}-${m}-${y}`;
}
const siteDate = (when) => siteDateTime(when ? { date: when.date } : null);

function boxOf(name) {
  if (ICU.test(name)) return OTHERS;
  return MATCH_ORDER.find((b) => b.test.test(name)) ?? OTHERS;
}

/**
 * summary: structured yashoda-summary-bill (required). final: yashoda-final-bill (optional,
 * only to check it is the same patient's). → see NtpcClaim in web/projects/shared/src/api-types.ts.
 */
function buildNtpcClaim({ summary, final }) {
  const checks = [];
  // at: { doc: 'final' | 'summary', page } — where on the bill; the panel opens the PDF there.
  const add = (level, message, at) => checks.push({ level, message, ...(at ? { at } : {}) });
  const first = { doc: 'summary', page: 1 };

  addSummaryIssues(add, final, summary);
  if (final && final.patient?.ipNo && summary.patient?.ipNo && final.patient.ipNo !== summary.patient.ipNo) {
    add('error', `The bills are for different patients: IP ${final.patient.ipNo} (final) vs IP ${summary.patient.ipNo} (summary)`);
  }
  const company = summary.patient?.company;
  if (company && !NTPC_COMPANY.test(company)) {
    add('warning', `The summary bill is made out to "${company}", not NTPC — check this is the right bill`, first);
  }

  const billNo = summary.invoiceNo ?? null;
  const admission = siteDateTime(summary.patient?.admission);
  const discharge = siteDateTime(summary.patient?.discharge);
  const billDate = siteDate(summary.patient?.discharge);
  if (!billNo) add('warning', 'Invoice number not read from the summary bill — Bill No is left for you', first);
  if (!admission) add('warning', 'D.O.A not read from the summary bill — the admission date is left for you', first);
  if (!discharge) add('warning', 'D.O.D not read from the summary bill — the discharge date and the bill date are left for you', first);
  for (const [name, when] of [['D.O.A', summary.patient?.admission], ['D.O.D', summary.patient?.discharge]]) {
    if (when?.date && !when.time) add('warning', `${name} has no time on the summary bill — check the time on the site`, first);
  }

  // Each line of the summary goes to its box; the lines that fit none are added up in Charges Others.
  const parts = new Map();
  for (const c of summary.categories || []) {
    const name = lineName(c.name);
    if (c.amount == null) continue; // unreadable: said with the summary's own checks
    const box = boxOf(name);
    if (!parts.has(box)) parts.set(box, []);
    parts.get(box).push({ name, amount: c.amount, page: c.page ?? null });
  }
  const charges = [...BOXES, OTHERS]
    .filter((b) => parts.has(b))
    .map((b) => ({ key: b.key, box: b.box, amount: sum(parts.get(b).map((p) => p.amount)), lines: parts.get(b).map((p) => p.name) }))
    .filter((c) => c.amount !== 0);
  if (!charges.length) add('warning', 'No charges read from the summary bill — the charge boxes are left for you', first);

  const unread = (summary.categories || []).filter((c) => c.amount == null);
  if (unread.length) {
    add('warning', `${unread.map((c) => lineName(c.name)).join(', ')}: amount not readable — not in any box; enter it yourself`, { doc: 'summary', page: unread[0].page ?? 1 });
  }

  const boxesTotal = sum(charges.map((c) => c.amount));
  const gross = summary.totals?.gross ?? null;
  if (gross != null && !unread.length && !same(boxesTotal, gross)) {
    add('warning', `The boxes add up to ${boxesTotal}, the summary bill's total amount is ${gross} — check the boxes against the bill`, first);
  }
  const gst = summary.totals?.gst ?? null;
  if (gst) {
    add('warning', `GST ${gst} is in no charge box: the boxes come to ${boxesTotal}, the bill with GST to ${summary.totals.withGst ?? round2(boxesTotal + gst)} — check what the site's total should be`, first);
  }

  return {
    patient: { ...(final?.patient || {}), ...(summary.patient || {}) },
    ipNo: summary.patient?.ipNo ?? final?.patient?.ipNo ?? null,
    billNo,
    admissionDateTime: admission,
    dischargeDateTime: discharge,
    billDate,
    charges,
    totals: { billTotal: gross, gst, withGst: summary.totals?.withGst ?? null, boxes: boxesTotal },
    checks,
  };
}

module.exports = { buildNtpcClaim, BOXES, OTHERS, lineName };
