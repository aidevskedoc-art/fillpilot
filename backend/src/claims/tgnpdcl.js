// Yashoda final bill (+ summary bill) → what each tab of the TGNPDCL
// "New Medical Bill Entry" wizard needs. Pure: the route loads the documents.
//
// Tab 1 Room & Consultation   ward rows (rate/day, days), ICU days, doctors (name, days)
// Tab 2 Investigations        tariff rows (code, qty, amount claimed by hospital); implants total;
//                             the hospital's own codes (YSSH) apart — no tariff list has them
// Tab 3 Pharmacy              rows (date, item, rate, qty) — the final bill only has a total
// Tab 4 Summary               employee paid, concession, hospital bill number
//
// Defaults that are business decisions (not facts on the bill) are marked
// `review: true` with a note, so the person filling sees them.

const { normLabel } = require('../text/labels');

const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;

const ROOM = /\b(ROOM\s*RENT|WARD|BED\s*CHARGES)\b/i;
const ICU = /\bICU\b|INTENSIVE/i;
const DOCTOR = /DOCTOR|CONSULTATION/i;
const PHARMACY = /PHARMACY|MEDICINE\s*CHARGES/i;
const IMPLANT = /IMPLANT|MEDICAL\s*APPLIANCE/i;

/**
 * A CGHS 2025 rate-list code (OM F.No.5-16/CGHS(HQ)/HEC/2024, 03.10.2025): the
 * speciality's two letters + three digits — MG038, LB012, CN002. The bill
 * prints it without a NIMS / COMM mark; the site lists it under
 * "CGHS(2025)-Tier I".
 */
const CGHS_CODE = /^(AG|BC|BP|BT|BY|CA|CC|CI|CN|CP|CT|CV|DI|DP|EI|EP|GI|GP|GS|HC|HN|IT|LB|MG|NI|NM|NS|NU|OG|OI|OP|OR|PI|PP|PS|PT|RI|RP|RT|SK)\d{3}$/;

function nameKey(name) {
  return normLabel(String(name || '').replace(/^(dr|mr|mrs|ms)\.?\s+/i, ''));
}

/**
 * final: structured yashoda-final-bill (required). summary: yashoda-summary-bill (optional).
 * → { patient, hospitalBillNumber, tabs, checks, totals }
 */
function buildTgnpdclClaim({ final, summary }) {
  const checks = [];
  const add = (level, message) => checks.push({ level, message });

  for (const issue of final.issues || []) add(issue.level, `Final bill: ${issue.message}`);
  for (const issue of summary?.issues || []) add(issue.level, `Summary bill: ${issue.message}`);

  // Same patient on both documents?
  if (summary && final.patient?.ipNo && summary.patient?.ipNo && final.patient.ipNo !== summary.patient.ipNo) {
    add('error', `The bills are for different patients: IP ${final.patient.ipNo} (final) vs IP ${summary.patient.ipNo} (summary)`);
  }

  // Every group total is printed on both bills — two independent OCR reads of the same number.
  const groups = final.sections.flatMap((s) => s.groups.map((g) => ({ ...g, section: s.name })));
  if (summary) {
    // One name can head several groups (a section's unnamed groups after a
    // "Sub Total"), so the summary's line is compared with all of them together;
    // a summary line named after a whole section is compared with that section.
    const byName = new Map();
    const bySection = new Map();
    const addTo = (map, key, amount) => map.set(key, round2((map.get(key) || 0) + (amount || 0)));
    for (const g of groups) {
      addTo(byName, normLabel(g.name || g.section), g.subTotal);
      addTo(bySection, normLabel(g.section), g.subTotal);
    }
    // The summary can print one name twice, a line per group (CARDIOLOGY 14,700
    // and 1,11,550 on IP 129009), so its lines are added up by name as well.
    const summaryByName = new Map();
    for (const c of summary.categories) {
      const key = normLabel(c.name);
      const prev = summaryByName.get(key);
      const amount = !prev ? c.amount : prev.amount == null || c.amount == null ? null : round2(prev.amount + c.amount);
      summaryByName.set(key, { name: c.name, amount });
    }
    for (const [key, c] of summaryByName) {
      const amount = byName.has(key) ? byName.get(key) : bySection.get(key);
      if (amount === undefined) add('warning', `"${c.name}" (${c.amount}) is on the summary bill but not found on the final bill`);
      else if (!same(amount, c.amount)) add('error', `${c.name}: final bill ${amount} vs summary bill ${c.amount} — check this amount`);
    }
    if (!same(final.totals.grandTotal, summary.totals.gross)) {
      add('error', `Grand total differs: final bill ${final.totals.grandTotal} vs summary bill ${summary.totals.gross}`);
    }
  }

  const consultant = summary?.patient?.consultant;
  const speciality = summary?.patient?.consultantSpeciality;

  const room = { roomDays: 0, icuDays: 0, wards: [], doctors: [], numberOfDoctors: 0 };
  const investigations = { items: [], implants: null, ownItems: [] };
  // The hospital's own codes (YSSH) name many different items: identical lines are one row.
  const ownByKey = new Map();
  const addOwn = (item, source) => {
    const qty = item.qty || 1;
    const rate = item.rate ?? (item.amount != null ? round2(item.amount / qty) : null);
    const key = `${item.code}|${normLabel(item.description)}|${rate}`;
    let row = ownByKey.get(key);
    if (!row) {
      row = { code: item.code, description: item.description, qty: 0, rate, amountClaimed: 0, lines: 0, source, notes: [] };
      ownByKey.set(key, row);
      investigations.ownItems.push(row);
    }
    row.qty += qty;
    row.lines += 1;
    row.amountClaimed = round2(row.amountClaimed + (item.amount || 0));
    for (const n of item.issues || []) if (!row.notes.includes(n)) row.notes.push(n);
    if (rate == null && !row.notes.includes('Rate not readable — enter it yourself')) row.notes.push('Rate not readable — enter it yourself');
  };
  const pharmacy = { total: null, rows: [], note: null };
  // Every section DOCTOR matches — the same test that keeps them out of
  // Investigations, so a "CONSULTATION CHARGES" section can't fall between the two.
  const doctorItems = [];

  for (const section of final.sections) {
    for (const g of section.groups) {
      const label = `${section.name} ${g.name || ''}`;
      for (const item of g.items) {
        const source = { section: section.name, group: g.name, description: item.description, page: item.page };
        if (DOCTOR.test(section.name)) {
          doctorItems.push(item);
          continue;
        }
        if (ICU.test(label)) {
          room.icuDays += item.qty || 0;
          continue;
        }
        if (ROOM.test(label) && !/ALPHA/i.test(label)) {
          const days = item.qty || 1;
          if (item.rate == null && item.amount == null) {
            add('warning', `Room rent "${item.description}": neither the rate nor the amount could be read — enter this ward row yourself`);
            continue;
          }
          // No rate printed (or unreadable): the amount covers all the days, so the rate is amount ÷ days.
          const ratePerDay = item.rate ?? round2(item.amount / days);
          if (item.rate == null && days > 1) {
            add('warning', `Room rent "${item.description}": rate per day not readable — worked out as ${item.amount} ÷ ${days} day(s) = ${ratePerDay}; check it`);
          }
          room.wards.push({ ratePerDay, days, amount: item.amount, source });
          continue;
        }
        if (PHARMACY.test(label)) {
          pharmacy.total = round2((pharmacy.total || 0) + (item.amount || 0));
          continue;
        }
        if (IMPLANT.test(label)) {
          investigations.implants = {
            amount: round2((investigations.implants?.amount || 0) + (item.amount || 0)),
            note: 'Implants are entered on the site by department and implant item, with the implant invoice — the bill only shows a total.',
          };
          continue;
        }
        if (item.ownCode) {
          addOwn(item, source);
          continue;
        }
        const codeOk = item.code && /^[A-Z]{0,3}\d+[A-Z]?$|^[A-Z]\d+(\.\d+)+$/.test(item.code);
        const row = {
          code: item.code,
          tariff: item.tariff ?? (CGHS_CODE.test(item.code || '') ? 'CGHS' : null),
          description: item.description,
          qty: item.qty || 1,
          amountClaimed: item.amount,
          lines: 1,
          source,
          review: false,
          // Only clean single tariff codes are searched on the site; the rest is entered by hand.
          manual: !codeOk,
          notes: [...(item.issues || [])],
          // The other reading of a last character OCR cannot settle (78I / 781): the site's tariff list decides.
          ...(item.codeAlternatives ? { alternatives: item.codeAlternatives } : {}),
        };
        if (!item.code) row.notes.push('No tariff code on the bill — pick the tariff item manually');
        else if (item.code.includes('+')) row.notes.push(`Combined code ${item.code} — enter its parts on the site`);
        else if (!codeOk) row.notes.push(`"${item.codeRaw}" is not a tariff code — enter manually`);
        if (/ALPHA\s*BED/i.test(label)) {
          row.review = true;
          row.notes.push('Alpha bed — confirm it is claimed under Investigations and Procedures');
        }
        if (row.manual || item.issues?.length || item.corrected) row.review = true;
        investigations.items.push(row);
      }
    }
  }
  investigations.items = mergeByCode(investigations.items);
  // A reading that is another line's code on this bill is not an alternative: both items are on the bill.
  const billCodes = new Set(investigations.items.map((r) => r.code).filter(Boolean));
  for (const r of investigations.items) {
    if (!r.alternatives) continue;
    r.alternatives = r.alternatives.filter((a) => !billCodes.has(a));
    if (!r.alternatives.length) delete r.alternatives;
  }

  const doctorCount = new Map();
  for (const item of doctorItems) doctorCount.set(nameKey(item.description), (doctorCount.get(nameKey(item.description)) || 0) + 1);
  room.doctors = doctorItems.map((item) => {
    const name = item.description.replace(/^DR\.?\s*/i, '').trim();
    const isConsultant = consultant && nameKey(name) === nameKey(consultant);
    const notes = isConsultant ? [] : ['Specialization not on the bill — add it if the site needs it'];
    const repeated = doctorCount.get(nameKey(item.description)) > 1;
    if (repeated) notes.push('This doctor is on the bill more than once — check whether the site wants one row with the days added up');
    return {
      name: isConsultant && speciality ? `${name} (${speciality})` : name,
      days: item.qty,
      amount: item.amount,
      review: !isConsultant || repeated,
      notes,
    };
  });
  room.numberOfDoctors = room.doctors.length;
  // The site's "Room Days (total)": days charged as room rent, ICU counted separately.
  room.roomDays = room.wards.reduce((s, w) => s + w.days, 0);

  if (!room.wards.length) add('warning', 'No room rent on the bill — ward rows left empty');
  const stayDays = daysBetween(summary?.patient?.admission?.date, summary?.patient?.discharge?.date);
  const bedDays = room.roomDays + room.icuDays;
  if (stayDays != null && (room.wards.length || room.icuDays) && bedDays !== stayDays) {
    add('warning', `Room + ICU charged for ${bedDays} day(s) but the stay was ${stayDays} day(s) (admission to discharge) — check the ward rows`);
  }

  if (pharmacy.total != null) {
    pharmacy.note = `The final bill shows pharmacy only as a total (${pharmacy.total}). Rows need the itemised pharmacy bill (date, item, rate, qty).`;
    add('warning', pharmacy.note);
  }
  if (investigations.implants) add('warning', `Implants ${investigations.implants.amount}: ${investigations.implants.note}`);

  const summaryTab = {
    employeePaid: summary?.totals?.paid ?? null,
    concession: 0,
    hospitalBillNumber: summary?.invoiceNo ?? null,
  };
  if (!summary) add('warning', 'No summary bill selected — employee paid and hospital bill number are left empty');

  const filledTotal = round2(
    room.wards.reduce((s, w) => s + (w.amount || 0), 0)
    + room.doctors.reduce((s, d) => s + (d.amount || 0), 0)
    + investigations.items.reduce((s, i) => s + (i.amountClaimed || 0), 0),
  );

  return {
    patient: { ...(final.patient || {}), ...(summary?.patient || {}) },
    hospitalBillNumber: summaryTab.hospitalBillNumber,
    tabs: { room, investigations, pharmacy, summary: summaryTab },
    totals: {
      billTotal: final.totals.grandTotal,
      netAmount: final.totals.netAmount,
      filledByExtension: filledTotal,
      leftForManualEntry: round2((final.totals.grandTotal || 0) - filledTotal),
    },
    checks,
  };
}

/**
 * One site row per tariff code: the bill lists a test once per time it was
 * done (HAEMOGRAM × 18), the site wants code + qty + total claimed. Rows
 * without any code stay separate; manual rows merge only with manual rows.
 */
function mergeByCode(rows) {
  const out = [];
  const byKey = new Map();
  for (const r of rows) {
    if (!r.code) {
      out.push(r);
      continue;
    }
    const key = `${r.code}|${r.tariff || ''}|${r.manual ? 'manual' : ''}`;
    const prev = byKey.get(key);
    if (!prev) {
      const copy = { ...r, notes: [...r.notes], descriptions: [r.description] };
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    prev.qty += r.qty;
    prev.amountClaimed = round2(prev.amountClaimed + (r.amountClaimed || 0));
    prev.lines += 1;
    prev.review = prev.review || r.review;
    for (const n of r.notes) if (!prev.notes.includes(n)) prev.notes.push(n);
    if (!prev.descriptions.includes(r.description)) prev.descriptions.push(r.description);
  }
  for (const r of out) {
    if (r.descriptions?.length > 1) r.notes.push(`Same code on the bill for: ${r.descriptions.join('; ')}`);
    delete r.descriptions;
  }
  return out;
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

module.exports = { buildTgnpdclClaim };
