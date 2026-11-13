// Yashoda final bill (+ summary bill) → what each tab of the TGNPDCL
// "New Medical Bill Entry" wizard needs. Pure: the route loads the documents.
//
// Tab 1 Room & Consultation   ward rows (rate/day, days), ICU days, doctors (name, days)
// Tab 2 Investigations        tariff rows (code, qty, amount claimed by hospital); implants total;
//                             the hospital's own codes (YSSH) apart — no tariff list has them
// Tab 3 Pharmacy              rows (date, item, rate, qty) from the pharmacy bill (PDF or HIS Excel),
//                             for the site's Excel upload — the final bill only has a total
// Tab 4 Summary               employee paid, concession, hospital bill number
//
// Defaults that are business decisions (not facts on the bill) are marked
// `review: true` with a note, so the person filling sees them.

const { normLabel } = require('../text/labels');
const { addSummaryIssues } = require('./summary-issues');

const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;

const ROOM =/\b(ROOM\s*RENT|WARD|BED\s*CHARGES)\b/i;
const ICU = /\bICU\b|INTENSIVE/i;
const DOCTOR = /DOCTOR|CONSULTATION/i;
const PHARMACY = /PHARMACY|MEDICINE\s*CHARGES/i;
const IMPLANT = /IMPLANT|MEDICAL\s*APPLIANCE/i;

/**
 * Tariff codes for lines a bill prints without one, as the client gave them:
 * oxygen is 2225 in the COMM list (EHS Ax-VI) — printed so on IP 131537's bill,
 * missing on others (2026-11-09). Matched on the line and its section. A line
 * with a code of its own keeps it. Add a line here for another such item.
 */
const CODES_WHEN_MISSING = [
  { test: /\bOXYGEN\b/i, code: '2225', tariff: 'COMM', item: 'oxygen' },
];

/**
 * Tariff items the site prices by the hour while the bill counts days: oxygen
 * 2225 (COMM) is ₹135 an hour on the site, and the bill charges "1 Day(s) X
 * 3,240.00" = 24 × 135 (the client, 2026-11-09). Its quantity on the site is
 * hours: 1 day = 24, 4 days = 96. Key: code|tariff.
 */
const HOURLY = new Set(['2225|COMM']);

/**
 * A CGHS 2025 rate-list code (OM F.No.5-16/CGHS(HQ)/HEC/2024, 03.10.2025): the
 * speciality's two letters + three digits — MG038, LB012, CN002. The bill
 * prints it without a NIMS / COMM mark; the site lists it under
 * "CGHS(2025)-Tier I".
 */
const CGHS_CODE = /^(AG|BC|BP|BT|BY|CA|CC|CI|CN|CP|CT|CV|DI|DP|EI|EP|GI|GP|GS|HC|HN|IT|LB|MG|NI|NM|NS|NU|OG|OI|OP|OR|PI|PP|PS|PT|RI|RP|RT|SK)\d{3}$/;

/**
 * EHS codes, marked EHS here: the site lists them under "EHS Ax-III" or "EHS
 * Ax-II", which the extension searches in that order, the bill's rate deciding
 * between the two (the client, 2026-11-11). They are printed without a mark:
 *   - every code of the bill's surgery charges ("SURGERY CHARGES" / "SURGICAL…")
 *   - and anywhere, a procedure code of digits in three or four dotted parts
 *     ("51.22.6" LAPAROSCOPIC CHOLECYSTECTOMY).
 * A code the bill marks itself (NIMS, COMM) or a CGHS code keeps its own list.
 */
const EHS_CODE = /^\d{1,3}(\.\d{1,3}){2,3}$/;
const SURGERY = /\bSURGERY\b|\bSURGICAL\b/i;

function nameKey(name) {
  return normLabel(String(name || '').replace(/^(dr|mr|mrs|ms)\.?\s+/i, ''));
}

/** Items of this price or more go with their physical pouches (the site's rule on the Pharmacy tab). */
const POUCH_RATE = 2000;
/** No row limit of the site is known: above this many rows the person is asked to check they all loaded. */
const MANY_PHARMACY_ROWS = 100;

/** "130 007" → "130007": IP numbers compared as digits and letters only. */
const ipKey = (ip) => String(ip ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

/**
 * The HIS pharmacy Excel (spdcl.parsePharmacyBill) in the shape of the
 * pharmacy PDF's reading (yashoda.parsePharmacyBill): dates as yyyy-mm-dd,
 * Value for every item, and the items checked against TOTAL ISSUE AMOUNT.
 */
function pharmacyFromExcel(parsed) {
  const iso = (day) => (day == null ? null : new Date(day * 86400000).toISOString().slice(0, 10));
  const items = parsed.items.map((i) => ({
    date: iso(i.date),
    indentNo: i.indentNo,
    description: i.description,
    qty: Math.abs(i.qty),
    price: i.price == null ? null : Math.abs(i.price),
    value: Math.abs(i.value ?? round2(i.price * i.qty)),
    returned: i.returned,
    page: null,
    issues: [],
  }));
  const issues = [...parsed.issues];
  const issuedSum = round2(items.filter((i) => !i.returned).reduce((s, i) => s + i.value, 0));
  const returnedSum = round2(items.filter((i) => i.returned).reduce((s, i) => s + i.value, 0));
  if (parsed.issueTotal != null && !same(issuedSum, parsed.issueTotal)) {
    issues.push({ level: 'error', message: `Items add up to ${issuedSum} but the TOTAL ISSUE AMOUNT is ${parsed.issueTotal}` });
  }
  if (parsed.returnTotal != null && !same(returnedSum, Math.abs(parsed.returnTotal))) {
    issues.push({ level: 'error', message: `Returned items add up to ${returnedSum} but the TOTAL RETURN AMOUNT is ${Math.abs(parsed.returnTotal)}` });
  }
  const issued = parsed.issueTotal ?? issuedSum;
  const returned = parsed.returnTotal == null ? returnedSum : Math.abs(parsed.returnTotal);
  return {
    format: 'his-pharmacy-excel',
    patient: parsed.patient,
    items,
    totals: { issued, returned, net: round2(issued - returned) },
    issues,
  };
}

/**
 * What the pharmacy bill's items come to: TOTAL ISSUE − TOTAL RETURN, to the
 * paisa; else its NET AMOUNT, which is rounded to the rupee.
 */
const pharmacyDue = (totals) => (totals.issued != null
  ? { amount: round2(totals.issued - (totals.returned || 0)), exact: true }
  : { amount: totals.net, exact: false });
const matchesDue = (amount, due) => due.amount != null && (due.exact ? same(amount, due.amount) : Math.abs(amount - due.amount) <= 1);

/**
 * Tab 3 from the itemised pharmacy bill: one row per item issued — the
 * indent's date, the item as printed, Amount per item (the bill's Price, else
 * Value ÷ Qty), Qty — as the team types them into the site's Excel. A return
 * takes its qty (and value) off the same item issued, the latest issue first
 * (the client, 2026-11-06); an item returned in full is left out.
 * → { rows, value: what the rows stand for on the bill, problems }
 */
function pharmacyRows(bill) {
  const problems = [];
  const lines = bill.items
    .filter((i) => !i.returned && i.value != null)
    .map((i) => ({ date: i.date, name: i.description, qty: i.qty, price: i.price ?? null, value: i.value, page: i.page ?? null }));
  const skipped = bill.items.filter((i) => !i.returned && i.value == null);
  if (skipped.length) problems.push({ level: 'error', message: `${skipped.length} item(s) left out — their value could not be read: ${skipped.map((i) => i.description).join('; ')}` });

  for (const r of bill.items.filter((i) => i.returned && i.value != null)) {
    const price = r.value / r.qty;
    let left = r.qty;
    for (const l of lines.filter((x) => normLabel(x.name) === normLabel(r.description)).reverse()) {
      if (left <= 0) break;
      const take = Math.min(l.qty, left);
      l.qty = round2(l.qty - take);
      l.value = round2(l.value - price * take);
      left = round2(left - take);
    }
    if (left > 0) {
      problems.push({ level: 'warning', message: `Returned "${r.description}" ×${left} is not among the items issued — take it off the right row yourself`, page: r.page ?? null });
    }
  }

  const rows = lines
    .filter((l) => l.qty > 0)
    .map((l) => {
      // The printed price where it still makes the value; Value ÷ Qty otherwise.
      const rate = l.price != null && Math.abs(l.price * l.qty - l.value) <= 0.05 ? l.price : round2(l.value / l.qty);
      return { date: l.date, name: l.name, rate, qty: l.qty, amount: round2(rate * l.qty), pouch: rate >= POUCH_RATE, page: l.page };
    });
  return { rows, value: round2(lines.filter((l) => l.qty > 0).reduce((s, l) => s + l.value, 0)), problems };
}

/**
 * The Pharmacy tab from the pharmacy bill alone (yashoda-pharmacy-bill, or the
 * HIS Excel through pharmacyFromExcel) → { patient, rows, bill, checks }: the
 * rows, the bill's own checks, and how the rows stand against it. The claim
 * adds the final bill's side; the panel's "Excel & PDF" tab uses it as it is.
 */
function buildTgnpdclPharmacy(pharmacyBill) {
  const checks = [];
  const pdf = pharmacyBill.format === 'yashoda-pharmacy-bill';
  // A check with a page opens the pharmacy bill PDF there; the Excel has no pages.
  const at = (page) => (pdf ? { doc: 'pharmacy', page: page ?? null } : undefined);
  const add = (level, message, where) => checks.push({ level, message, ...(where ? { at: where } : {}) });

  for (const issue of pharmacyBill.issues || []) add(issue.level, `Pharmacy bill: ${issue.message}`, at(issue.page));
  const { rows, value, problems } = pharmacyRows(pharmacyBill);
  for (const p of problems) add(p.level, `Pharmacy bill: ${p.message}`, p.page ? at(p.page) : undefined);
  const due = pharmacyDue(pharmacyBill.totals);
  if (due.amount != null && !matchesDue(value, due)) {
    add('error', `Pharmacy rows come to ${value} but the pharmacy bill's ${due.exact ? 'issues − returns come' : 'NET AMOUNT comes'} to ${due.amount}`);
  }
  const typed = round2(rows.reduce((s, r) => s + r.amount, 0));
  if (rows.length && !same(typed, value)) {
    add('info', `Amount per item is rounded to paise, so the site's rows come to ${typed} — ${round2(typed - value)} from the bill's ${value}`);
  }
  if (rows.length > MANY_PHARMACY_ROWS) add('warning', `${rows.length} pharmacy rows — check the site shows all of them after the Excel loads`);
  return { patient: pharmacyBill.patient, rows, bill: { ...pharmacyBill.totals, source: pdf ? 'pdf' : 'excel' }, checks };
}

/**
 * final: structured yashoda-final-bill (required). summary: yashoda-summary-bill (optional).
 * pharmacy: yashoda-pharmacy-bill, or the HIS Excel through pharmacyFromExcel (optional).
 * → { patient, hospitalBillNumber, tabs, checks, totals }
 */
function buildTgnpdclClaim({ final, summary, pharmacy: pharmacyBill }) {
  const checks = [];
  // at: { doc: 'final' | 'summary' | 'pharmacy', page } — where on the bill; the panel opens the PDF there.
  const add = (level, message, at) => checks.push({ level, message, ...(at ? { at } : {}) });

  for (const issue of final.issues || []) add(issue.level, `Final bill: ${issue.message}`, { doc: 'final', page: issue.page ?? null });
  addSummaryIssues(add, final, summary);
  // The pharmacy bill's own checks come with its rows (buildTgnpdclPharmacy).

  // Same patient on both documents?
  if (summary && final.patient?.ipNo && summary.patient?.ipNo && final.patient.ipNo !== summary.patient.ipNo) {
    add('error', `The bills are for different patients: IP ${final.patient.ipNo} (final) vs IP ${summary.patient.ipNo} (summary)`);
  }
  if (pharmacyBill && final.patient?.ipNo && pharmacyBill.patient?.ipNo && ipKey(final.patient.ipNo) !== ipKey(pharmacyBill.patient.ipNo)) {
    add('error', `The bills are for different patients: IP ${final.patient.ipNo} (final) vs IP ${pharmacyBill.patient.ipNo} (pharmacy)`);
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
      summaryByName.set(key, { name: c.name, amount, page: prev?.page ?? c.page ?? null });
    }
    for (const [key, c] of summaryByName) {
      // Unreadable on the summary: said (and settled from the final bill, where it can be) with the summary's issues.
      if (c.amount == null) continue;
      const amount = byName.has(key) ? byName.get(key) : bySection.get(key);
      const at = { doc: 'summary', page: c.page };
      if (amount === undefined) add('warning', `"${c.name}" (${c.amount}) is on the summary bill but not found on the final bill`, at);
      else if (!same(amount, c.amount)) add('error', `${c.name}: final bill ${amount} vs summary bill ${c.amount} — check this amount`, at);
    }
    if (!same(final.totals.grandTotal, summary.totals.gross)) {
      add('error', `Grand total differs: final bill ${final.totals.grandTotal} vs summary bill ${summary.totals.gross}`, { doc: 'final', page: final.grandTotalPage ?? null });
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
  // bill: the pharmacy bill's totals when one was read; the rows come from it (pharmacyRows).
  const pharmacy = { total: null, rows: [], note: null, bill: null };
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
          const at = { doc: 'final', page: item.page ?? null };
          if (item.rate == null && item.amount == null) {
            add('warning', `Room rent "${item.description}": neither the rate nor the amount could be read — enter this ward row yourself`, at);
            continue;
          }
          // No rate printed (or unreadable): the amount covers all the days, so the rate is amount ÷ days.
          const ratePerDay = item.rate ?? round2(item.amount / days);
          if (item.rate == null && days > 1) {
            add('warning', `Room rent "${item.description}": rate per day not readable — worked out as ${item.amount} ÷ ${days} day(s) = ${ratePerDay}; check it`, at);
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
        // No code printed, but the client gave one for this item (oxygen → 2225/COMM).
        const given = item.code ? null : CODES_WHEN_MISSING.find((c) => c.test.test(`${label} ${item.description}`));
        const code = given ? given.code : item.code;
        const codeOk = code && (/^[A-Z]{0,3}\d+[A-Z]?$|^[A-Z]\d+(\.\d+)+$/.test(code) || EHS_CODE.test(code));
        const ehs = EHS_CODE.test(code || '') || (codeOk && SURGERY.test(label));
        const tariff = given ? given.tariff : item.tariff ?? (CGHS_CODE.test(code || '') ? 'CGHS' : ehs ? 'EHS' : null);
        // Days on the bill, hours on the site (oxygen 2225): 1 day = 24.
        const hourly = HOURLY.has(`${code}|${tariff}`);
        const days = hourly && /^day/i.test(item.unit || '') ? item.qty : null;
        const row = {
          code,
          tariff,
          description: item.description,
          qty: days != null ? days * 24 : item.qty || 1,
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
        if (days != null) row.notes.push(`${days} day(s) on the bill = ${days * 24} hour(s): the site prices ${code} by the hour`);
        else if (hourly && !/^h(ou)?rs?$/i.test(item.unit || '')) {
          row.notes.push(`The site prices ${code} by the hour, but the bill gives no days — ${row.qty} entered; check the hours`);
          row.review = true;
        }
        if (given) row.notes.push(`No code on the bill — ${given.code}/${given.tariff}, the client's code for ${given.item}`);
        else if (!item.code) row.notes.push('No tariff code on the bill — pick the tariff item manually');
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
  joinRepeatedLines(investigations.items);
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

  if (pharmacyBill) {
    const tab = buildTgnpdclPharmacy(pharmacyBill);
    pharmacy.rows = tab.rows;
    pharmacy.bill = tab.bill;
    checks.push(...tab.checks);
    // The final bill's PHARMACY line and the pharmacy bill are two readings of the same amount.
    const due = pharmacyDue(pharmacyBill.totals);
    if (pharmacy.total != null && due.amount != null && !matchesDue(pharmacy.total, due)) {
      add('error', `Pharmacy differs: final bill ${pharmacy.total} vs pharmacy bill ${due.amount} — check these are the same patient's bills`);
    }
    if (!tab.rows.length) pharmacy.note = 'The pharmacy bill has no item to enter.';
  } else if (pharmacy.total != null) {
    pharmacy.note = `The final bill shows pharmacy only as a total (${pharmacy.total}). Choose the pharmacy bill (PDF or the HIS Excel) with the other bills to fill this tab.`;
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
 * One item on several lines of the bill is one code. A line whose code the
 * scan spoilt became a row of its own, so the item came out short (Somajiguda,
 * 2026-11-12: 3 units on the bill, 2 entered):
 *   - no code read, or not a code: left for manual entry. It takes the code and
 *     mark of the other lines with the same name at the same rate, when they
 *     all carry one.
 *   - the code without its NIMS / COMM mark: a row of its own, which on the site
 *     typed its quantity over the other lines' row (same Code column). It takes
 *     the mark that code carries on the bill's other lines, when it has one.
 * Combined codes ("R171+171") are left as they are. Rows changed are marked to check.
 */
function joinRepeatedLines(rows) {
  const rateOf = (r) => (r.amountClaimed != null && r.qty ? round2(r.amountClaimed / r.qty) : null);
  const itemKey = (r) => `${normLabel(r.description)}|${rateOf(r)}`;
  const marked = rows.filter((r) => r.code && !r.manual && r.tariff);
  /** name + rate → the code|mark pairs its marked lines carry */
  const byItem = new Map();
  /** code → the marks it carries */
  const marksOf = new Map();
  for (const r of marked) {
    if (!byItem.has(itemKey(r))) byItem.set(itemKey(r), new Map());
    const pairs = byItem.get(itemKey(r));
    const pair = `${r.code}|${r.tariff}`;
    pairs.set(pair, { code: r.code, tariff: r.tariff, lines: (pairs.get(pair)?.lines || 0) + 1 });
    if (!marksOf.has(r.code)) marksOf.set(r.code, new Set());
    marksOf.get(r.code).add(r.tariff);
  }
  for (const r of rows) {
    if (r.code?.includes('+')) continue;
    if (!r.code || r.manual) {
      const pairs = rateOf(r) == null ? null : byItem.get(itemKey(r));
      if (!pairs || pairs.size !== 1) continue;
      const [{ code, tariff, lines }] = pairs.values();
      const read = r.code ? `the code read as "${r.code}"` : 'no code read';
      r.notes = r.notes.filter((n) => !/pick the tariff item manually|is not a tariff code — enter manually/.test(n));
      r.notes.push(`One line had ${read}; the same item at the same rate is ${code}/${tariff} on ${lines} other line(s), so it is entered with them — check it on the bill`);
      Object.assign(r, { code, tariff, manual: false, review: true });
      delete r.alternatives;
    } else if (!r.tariff && marksOf.get(r.code)?.size === 1) {
      const [tariff] = marksOf.get(r.code);
      r.notes.push(`${r.code} is printed without its mark on one line; it is ${r.code}/${tariff} on the bill's other lines, so it is entered with them — check it on the bill`);
      Object.assign(r, { tariff, review: true });
    }
  }
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

module.exports = { buildTgnpdclClaim, buildTgnpdclPharmacy, pharmacyFromExcel, POUCH_RATE };
