// Yashoda final bill (+ summary bill) → the "Upload Bill" screen of the BHEL
// claim on KareXpert (bhel.karexpert.com, /insurance/insurance_billing_miscllaneous/add).
// Pure: the route loads the documents.
//
//   Patient Details   Visit ID = the IP number; Bill No = the summary bill's
//                     invoice number (ICO…); Visit Date Time = D.O.A; Discharge
//                     Date Time and Bill Date Time = D.O.D (the client, 2026-11-09)
//   Bill Details      ONE ROW PER SERVICE TYPE, holding the bill's total for it
//                     in whole rupees: Quantity 1, Discount 0 and the fixed
//                     Remarks text of SERVICE_TYPES. Only the Service Type is
//                     chosen: Service Item and Priority stay empty (the client,
//                     2026-11-09)
//
// The bill sections that fit none of those types (SDP / blood transfusion,
// bed-side procedures, chemotherapy infusion, oxygen, ICU…) are ONE row under
// "Other Unlisted Item": their total, and their names in Remarks (the client,
// 2026-11-11).
// Payment Details, Document Upload and Diagnosis stay with the person; Draft and
// Accept are never pressed.

const { addSummaryIssues } = require('./summary-issues');

const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;
const sum = (list) => round2(list.reduce((s, n) => s + (n || 0), 0));

/** ICU / ICCU bed charges are not "Room Rent" ("WARD CHARGES / ICU BED CHARGES"): they go under Other Unlisted Item. */
const ICU = /\bI?CCU\b|\bICU\b|INTENSIVE/i;

/** Where every section outside SERVICE_TYPES goes — all of them in one row (the client, 2026-11-11). */
const OTHER = 'Other Unlisted Item';

/**
 * The client's Service Types (2026-11-09), each with the Remarks typed for it,
 * in the order the rows go on the site. `test` is tried on the bill's section
 * name, then on its group's name — in the order of MATCH_ORDER, so "LABORATORY /
 * TRANSFUSION MEDICINE" is lab and "SURGICAL PATHOLOGY" is not surgery.
 * Add a pattern here to bring more of the bill's sections under a type.
 */
const SERVICE_TYPES = [
  { serviceType: 'Room Rent', remarks: 'ROOM RENT', test: /ROOM\s*RENT|WARD\s*CHARGES|\bBED\s*CHARGES/i },
  { serviceType: 'IP Consultation', remarks: 'DOCTOR CONSULTATIONS', test: /DOCTOR|CONSULTATION/i },
  { serviceType: 'Cardiology BHEL', remarks: 'ECG', test: /CARDIOLOGY|\bE\.?C\.?G\b|\b(2\s*D\s*)?ECHO\b|\bTMT\b|HOLTER/i },
  { serviceType: 'Surgery', remarks: 'SURGERY CHARGES', test: /SURGERY|SURGICAL|SURGEON/i },
  { serviceType: 'Pharmacy', remarks: 'IP PHARMACY + MEDICAL APPLIANCES', test: /PHARMACY|MEDICINE\s*CHARGES|MEDICAL\s*APPLIANCE/i },
  {
    serviceType: 'Radiology BHEL', remarks: 'RADIOLOGY INVESTIGATIONS',
    test: /RADIOLOG|X[\s-]?RAY|RADIOGRAPH|ULTRA\s*SOUND|\bUSG\b|\bC\.?T\.?\s*SCAN|\bCT\b|\bMRI\b|DOPPLER|MAMMOGRA/i,
  },
  {
    serviceType: 'Pathology BHEL', remarks: 'LAB INVESTIGATIONS',
    test: /LABORATORY|\bLAB\b|PATHOLOG|HA?EMATOLOG|BIO\s*-?\s*CHEM|MICRO\s*BIOLOG|SEROLOG|CYTOLOG|IMMUNOLOG|\bRBS\b|GLUCOMETER|TRANSFUSION\s*MEDICINE/i,
  },
];
const MATCH_ORDER = ['Pharmacy', 'Room Rent', 'IP Consultation', 'Pathology BHEL', 'Radiology BHEL', 'Cardiology BHEL', 'Surgery']
  .map((name) => SERVICE_TYPES.find((t) => t.serviceType === name));

const typeOf = (name) => (name ? MATCH_ORDER.find((t) => t.test.test(name)) ?? null : null);

/** The bill is made out to BHEL ("BHEL RCPURAM", "BHARAT HEAVY ELECTRICALS LTD"). */
const BHEL_COMPANY = /\bBHEL\b|BHARAT\s*HEAVY/i;

/** { date: "2026-10-12", time: "18:24" } → "12/10/2026 18:24", as the site's date boxes show it. */
function siteDateTime(when) {
  if (!when?.date) return null;
  const [y, m, d] = when.date.split('-');
  return when.time ? `${d}/${m}/${y} ${when.time}` : `${d}/${m}/${y}`;
}

/**
 * final: structured yashoda-final-bill (required). summary: yashoda-summary-bill (optional,
 * but Bill No and the dates are on it). → see BhelClaim in web/projects/shared/src/api-types.ts.
 */
function buildBhelClaim({ final, summary }) {
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
  const company = summary?.patient?.company;
  if (company && !BHEL_COMPANY.test(company)) {
    add('warning', `The summary bill is made out to "${company}", not BHEL — check these are the right bills`, { doc: 'summary', page: 1 });
  }

  const visitId = summary?.patient?.ipNo ?? final.patient?.ipNo ?? null;
  const billNo = summary?.invoiceNo ?? null;
  const visitDateTime = siteDateTime(summary?.patient?.admission);
  const dischargeDateTime = siteDateTime(summary?.patient?.discharge);
  if (!summary) {
    add('warning', 'No summary bill selected — Bill No and the dates are on it, so they are left for you');
  } else {
    if (!billNo) add('warning', 'Invoice number not read from the summary bill — Bill No is left for you', { doc: 'summary', page: 1 });
    if (!visitDateTime) add('warning', 'D.O.A not read from the summary bill — Visit Date Time is left for you', { doc: 'summary', page: 1 });
    if (!dischargeDateTime) add('warning', 'D.O.D not read from the summary bill — Discharge and Bill Date Time are left for you', { doc: 'summary', page: 1 });
    for (const [name, when] of [['D.O.A', summary.patient?.admission], ['D.O.D', summary.patient?.discharge]]) {
      if (when?.date && !when.time) add('warning', `${name} has no time on the summary bill — only the date is typed; check the time on the site`, { doc: 'summary', page: 1 });
    }
  }

  // Each group of the bill goes to the Service Type its section (else its own name)
  // belongs to; the groups that fit none are added up under Other Unlisted Item.
  const byType = new Map();
  const others = new Map();
  const manual = [];
  let groupsTotal = 0;
  for (const section of final.sections) {
    for (const g of section.groups) {
      const where = g.name && g.name !== section.name ? `${section.name} / ${g.name}` : section.name;
      const amount = g.subTotal ?? sum(g.items.map((i) => i.amount));
      groupsTotal = round2(groupsTotal + (amount || 0));
      const type = ICU.test(section.name) || ICU.test(g.name || '') ? null : typeOf(section.name) ?? typeOf(g.name);
      if (!type) {
        // Remarks: the bill's own name for it — the group's where a section holds several.
        const name = String(g.name || section.name).replace(/\s+/g, ' ').trim().toUpperCase();
        const parts = others.get(name) ?? [];
        parts.push({ where, amount });
        others.set(name, parts);
        continue;
      }
      const parts = byType.get(type) ?? [];
      parts.push({ where, amount });
      byType.set(type, parts);
    }
  }

  const row = (serviceType, remarks, parts) => {
    const billAmount = sum(parts.map((p) => p.amount));
    return { serviceType, remarks, qty: 1, amount: Math.round(billAmount), billAmount, sections: parts.map((p) => p.where) };
  };
  // Nothing to add for a section the bill charges nothing for.
  for (const [name, parts] of others) {
    if (sum(parts.map((p) => p.amount)) === 0) {
      add('info', `${name} is ₹0 on the bill — left out of Other Unlisted Item`);
      others.delete(name);
    }
  }
  const all = [
    ...SERVICE_TYPES.filter((t) => byType.has(t)).map((t) => row(t.serviceType, t.remarks, byType.get(t))),
    // All the other sections: one row, their names (as on the bill, in its order) in Remarks.
    ...(others.size ? [row(OTHER, [...others.keys()].join(', '), [...others.values()].flat())] : []),
  ];
  for (const r of all.filter((x) => x.amount === 0)) add('info', `${r.remarks} is ₹0 on the bill — no row added for it`);
  const rows = all.filter((x) => x.amount !== 0);

  if (!same(groupsTotal, final.totals.grandTotal)) {
    add('warning', `The bill's sections add up to ${groupsTotal}, its grand total is ${final.totals.grandTotal} — check the rows against the bill`, { doc: 'final', page: final.grandTotalPage ?? null });
  }
  if (!rows.length) add('warning', 'None of the bill\'s sections is one of the client\'s Service Types — nothing can be added to Bill Details');

  const netAmount = final.totals.netAmount ?? summary?.totals?.rounded ?? null;
  const totals = {
    billTotal: final.totals.grandTotal,
    netAmount,
    rows: rows.reduce((s, r) => s + r.amount, 0),
    manual: sum(manual.map((m) => m.amount)),
  };
  // Each row is rounded to the rupee, so together they can be a rupee or two off the bill.
  const expected = netAmount ?? Math.round(final.totals.grandTotal);
  const gap = Math.round((totals.rows + totals.manual - expected) * 100) / 100;
  if (Math.abs(gap) >= 1 && Math.abs(gap) <= rows.length) {
    add('info', `Rounding each row to whole rupees makes the rows ₹${Math.abs(gap)} ${gap > 0 ? 'more' : 'less'} than the bill's ${expected}`);
  }

  return {
    patient: { ...(final.patient || {}), ...(summary?.patient || {}) },
    visitId,
    billNo,
    visitDateTime,
    dischargeDateTime,
    billDateTime: dischargeDateTime,
    rows,
    manual,
    totals,
    checks,
  };
}

module.exports = { buildBhelClaim, siteDateTime, SERVICE_TYPES, OTHER };
