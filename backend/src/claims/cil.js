// Yashoda final bill (+ summary bill) → the Bill Details tab of the Coal India
// IP claim on e-Arogya Suvidha (cilbpa.utiitsl.com/coal/ipClaim, run by
// UTIITSL). Pure: the route loads the documents.
//
//   Bill No. / Bill Date   the summary bill's invoice number; the discharge date
//   CGHS List Items        one row per CIL code (CC008, LB037…), the quantities
//                          of all its bill lines added up: the site fills in the
//                          item name from the code and prices it; the bill's
//                          service names go in Remarks
//   Unlisted Procedures    code, service name, quantity and the bill's rate for:
//                          the hospital's own code (YSSH), the codes in
//                          UNLISTED_CODES (BC002, BC006), and room rent (code
//                          ROOM_CODE, days × rate per day)
//
// Room rent is also entered in Room Details on the Admission tab by the person
// (the panel reminds them). Doctor fees and lines without a code are listed for
// the person. Pharmacy reaches Bill Details from the site's own Pharmacy tab —
// it is only compared.

const { normLabel } = require('../text/labels');

const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;
const sum = (list) => round2(list.reduce((s, n) => s + (n || 0), 0));

const ROOM = /\b(ROOM\s*RENT|WARD|BED\s*CHARGES)\b/i;
/** ICU / ICCU bed charges are not room rent: they stay with the person (the client, 2026-10-19). */
const ICU = /\bI?CCU\b|\bICU\b|INTENSIVE/i;
const DOCTOR = /DOCTOR|CONSULTATION/i;
const PHARMACY = /PHARMACY|MEDICINE\s*CHARGES/i;

/**
 * Codes on the bill that Coal India takes as Unlisted Procedures, typed like the
 * hospital's own code YSSH — not as CGHS List Items (the client, 2026-10-19).
 * Add a code here to move it.
 */
const UNLISTED_CODES = new Set(['BC002', 'BC006']);
/** The Item Code typed for room rent in Unlisted Procedures — the bill prints none (the client, 2026-10-19). */
const ROOM_CODE = 'ROOM RENT';
/** Its Remarks: the site does not take a room rent row with Remarks empty (the client, 2026-10-19). */
const ROOM_REMARKS = 'ROOM RENT';

/** "2026-10-01" → "01-10-2026", the way the site writes dates. */
function siteDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/**
 * final: structured yashoda-final-bill (required). summary: yashoda-summary-bill (optional).
 * → { patient, hospitalBillNumber, billDate, cghs, unlisted, manual, room, pharmacy, totals, checks }
 */
function buildCilClaim({ final, summary }) {
  const checks = [];
  const add = (level, message) => checks.push({ level, message });

  for (const issue of final.issues || []) add(issue.level, `Final bill: ${issue.message}`);
  for (const issue of summary?.issues || []) add(issue.level, `Summary bill: ${issue.message}`);
  if (summary && final.patient?.ipNo && summary.patient?.ipNo && final.patient.ipNo !== summary.patient.ipNo) {
    add('error', `The bills are for different patients: IP ${final.patient.ipNo} (final) vs IP ${summary.patient.ipNo} (summary)`);
  }
  if (summary && !same(final.totals.grandTotal, summary.totals.gross)) {
    add('error', `Grand total differs: final bill ${final.totals.grandTotal} vs summary bill ${summary.totals.gross}`);
  }
  const company = summary?.patient?.company;
  if (company && !/COAL\s*INDIA/i.test(company)) {
    add('warning', `The summary bill is made out to "${company}", not Coal India — check these are the right bills`);
  }
  const billDate = siteDate(summary?.patient?.discharge?.date);
  if (!summary) add('warning', 'No summary bill selected — Bill No. and Bill Date are left empty');
  else if (!billDate) add('warning', 'Discharge date not read from the summary bill — Bill Date is left empty');

  const cghs = [];
  const unlisted = [];
  const manual = [];
  const rows = new Map();
  const manualLines = new Map();
  let room = null;
  let pharmacy = null;

  const toManual = (where, item, reason) => {
    const key = `${where}|${item.description}`;
    let line = manualLines.get(key);
    if (!line) {
      line = { section: where, description: item.description, count: 0, amount: 0, reason };
      manualLines.set(key, line);
      manual.push(line);
    }
    line.count += item.qty || 1;
    line.amount = round2(line.amount + (item.amount || 0));
  };

  /**
   * A bill line → its Bill Details row, `code` typed in Item Code; toUnlisted: Unlisted
   * Procedures, else CGHS List Items. remarks: typed in Remarks of an Unlisted row.
   */
  const addRow = (where, item, code, toUnlisted, remarks = null) => {
    const qty = item.qty || 1;
    const rate = item.rate ?? (item.amount != null ? round2(item.amount / qty) : null);
    // A CIL code is one row however many lines and services the bill charges it
    // for (CC008: SDP and blood component transfusion → quantity 2). An Unlisted
    // row is typed with the item's name, and YSSH names many different items, so
    // there only identical lines are one row.
    const key = toUnlisted ? `unlisted|${code}|${normLabel(item.description)}|${rate}` : `cil|${code}`;
    let row = rows.get(key);
    if (!row) {
      row = { code, description: item.description, qty: 0, rate, amount: 0, lines: 0, section: where, notes: [], services: [], rates: [], ...(remarks ? { remarks } : {}) };
      rows.set(key, row);
      (toUnlisted ? unlisted : cghs).push(row);
    }
    row.qty += qty;
    row.lines += 1;
    row.amount = round2(row.amount + (item.amount || 0));
    if (!row.services.includes(item.description)) row.services.push(item.description);
    if (!row.rates.includes(rate)) row.rates.push(rate);
    for (const message of item.issues || []) if (!row.notes.includes(message)) row.notes.push(message);
    if (item.tariff && !row.notes.some((n) => n.startsWith('Marked'))) row.notes.push(`Marked ${item.tariff} on the bill — check it is the CIL code`);
    if (toUnlisted && rate == null && !row.notes.includes('Rate not readable — enter it yourself')) row.notes.push('Rate not readable — enter it yourself');
  };

  for (const section of final.sections) {
    for (const g of section.groups) {
      const where = g.name && g.name !== section.name ? `${section.name} / ${g.name}` : section.name;
      const label = `${section.name} ${g.name || ''}`;
      for (const item of g.items) {
        if (!item.code) {
          if (PHARMACY.test(label)) {
            pharmacy = round2((pharmacy || 0) + (item.amount || 0));
          } else if (ICU.test(label) || ICU.test(item.description)) {
            toManual(where, item, 'ICU — enter it on the site yourself');
          } else if (ROOM.test(label)) {
            // Unlisted Procedures: ROOM RENT, the bill's description, days × rate per day, Remarks ROOM RENT.
            room = { days: (room?.days || 0) + (item.qty || 1), amount: round2((room?.amount || 0) + (item.amount || 0)) };
            addRow(where, item, ROOM_CODE, true, ROOM_REMARKS);
          } else if (DOCTOR.test(section.name)) {
            toManual(where, item, 'Doctor fees have no code — enter them on the site yourself');
          } else {
            toManual(where, item, 'No code on the bill');
          }
          continue;
        }
        if (/[+/]/.test(item.code)) {
          toManual(where, item, `Combined code ${item.code}`);
          continue;
        }
        const own = Boolean(item.ownCode);
        // A CIL code has digits (CC008); anything else that is not the hospital's own code is a misread.
        if (!own && !/\d/.test(item.code)) {
          toManual(where, item, `"${item.codeRaw}" is not a CIL code — check it on the bill`);
          continue;
        }
        addRow(where, item, item.code, own || UNLISTED_CODES.has(item.code));
      }
    }
  }

  for (const r of [...cghs, ...unlisted]) {
    // Several services under one code: all of them in Remarks; the rate is used
    // only if the site gives none, so lines charged differently average out.
    r.description = r.services.join('; ');
    // The site does not take an Unlisted row with Remarks empty: the item's name, as on the bill (room rent: ROOM RENT).
    if (unlisted.includes(r) && !r.remarks) r.remarks = r.description;
    if (r.rates.length > 1) r.rate = r.qty ? round2(r.amount / r.qty) : null;
    if (r.services.length > 1) r.notes.push(`${r.code} is on the bill ${r.lines} times, for: ${r.services.join('; ')} — one row, quantity ${r.qty}`);
    delete r.services;
    delete r.rates;
  }
  if (!cghs.length && !unlisted.length) add('warning', 'No item on the bill has a code — nothing can be added to Bill Details');

  return {
    patient: { ...(final.patient || {}), ...(summary?.patient || {}) },
    hospitalBillNumber: summary?.invoiceNo ?? null,
    billDate,
    cghs,
    unlisted,
    manual,
    room,
    pharmacy,
    totals: {
      billTotal: final.totals.grandTotal,
      netAmount: final.totals.netAmount ?? summary?.totals?.rounded ?? null,
      cghs: sum(cghs.map((r) => r.amount)),
      unlisted: sum(unlisted.map((r) => r.amount)),
      manual: sum(manual.map((m) => m.amount)),
    },
    checks,
  };
}

module.exports = { buildCilClaim, siteDate };
