// The hospital's HIS Excel exports (final bill + pharmacy bill) → the rows of
// the SPDCL claim upload: one row per service or medicine per day. Pure: the
// route reads the files (xlsx.js) and writes the workbook (spdcl-workbook.js).
//
// The final bill prints many lines without a date ("ROOM RENT 4 Day(s) X 3000",
// "8 Visit(s)", an ECG). SPDCL wants a date on every row, so those dates are
// worked out the way the billing team does it by hand:
//   admission         the earliest date on either bill, unless the person gives it
//   ICU, then room    ICU days from admission, room-rent days straight after
//   N Day/Visit/Unit  N rows of 1, a day each, from admission (or the line's date)
//   N Time(s)         spread over the billed stay days, the remainder on the first days
//   an undated line   admission; the same item again in that section → the next day
//   pharmacy          the date of its indent
// Amount is Rate × Qty, as SPDCL's sheet works it out (a formula in the file).

const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;

/** The Service_Type list of SPDCL's template (sheet "Heads"), spelled as there — "Emergency  " has two trailing spaces. */
const HEAD = {
  emergency: 'Emergency  ',
  pharmacy: 'Pharmacy/Drugs/Medicine Charges',
  pharmacyReturns: 'Pharmacy/Drugs/Medicine Returns',
  icu: 'Intensive Care Units',
  room: 'Room Rent',
  investigations: 'Investigations',
  bloodBank: 'Blood Bank',
  consultation: 'Consulation Charges',
};

const TARIFF_TYPES = ['CGHS', 'EHS', 'NIMS_2015', 'COVID_TARIFF'];

const ICU = /INTENSIVE|\bI\.?C\.?U\b|\bICCU\b|\bHDU\b|\bNICU\b|\bPICU\b|\bMICU\b|\bSICU\b/i;
const ROOM = /ROOM\s*RENT|\bWARD\b|\bBED\s*CHARGES?\b/i;
const PHARMACY = /PHARMACY|MEDICINES?\b/i;
/** Final-bill sections and their SPDCL head, as the billing team maps them. ICU and room are tested first. */
const SECTION_HEADS = [
  [/BED\s*SIDE\s*PROCEDURE/i, HEAD.emergency],
  [/BLOOD\s*TRANSFUSION/i, HEAD.bloodBank],
  [/DOCTOR|CONSULTATION/i, HEAD.consultation],
];
/** Sections the team enters under Investigations. Any other section goes there too, flagged to check. */
const INVESTIGATION_SECTIONS = /CARDIOLOGY|CATHETERI[SZ]ATION|DIALYSIS|LABORATORY|NEBULI[SZ]ATION|OXYGEN|PHYSIOTHERAPY|PROCEDURE\s*CHARGES|RADIOLOGY|RBS|GLUCOMETER|VENTILATOR/i;

/** Which SPDCL head a final-bill section goes under → { head, known }. */
function headOf(sectionName) {
  if (ICU.test(sectionName)) return { head: HEAD.icu, known: true };
  if (ROOM.test(sectionName)) return { head: HEAD.room, known: true };
  for (const [test, head] of SECTION_HEADS) if (test.test(sectionName)) return { head, known: true };
  if (PHARMACY.test(sectionName)) return { head: HEAD.pharmacy, known: true };
  return { head: HEAD.investigations, known: INVESTIGATION_SECTIONS.test(sectionName) };
}

// ── cells ────────────────────────────────────────────────────────────────

/** A cell as text: spaces collapsed, for matching labels. */
const label = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
/** A cell as printed (ends trimmed only): descriptions keep their inner spaces, as on the bill. */
const printed = (v) => (v == null ? '' : String(v).trim());

/** 1500, "1,35,329.80", "₹ 300" → number; anything else → null. */
function amount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = label(v).replace(/^(?:rs\.?|inr|₹)\s*/i, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const DAY_MS = 86400000;

/** A day as a whole number (days since 1970-01-01), from "27/09/2026" or an Excel date serial; null otherwise. */
function dayOf(v) {
  if (typeof v === 'number') {
    // Excel stores a date-formatted cell as days since 1899-12-30. Only plausible years are taken.
    return v > 36526 && v < 73051 && Number.isInteger(v) ? v - 25569 : null;
  }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(label(v));
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1990 || y > 2100) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null;
  return ms / DAY_MS;
}

/** Day number → "27/09/2026". */
function dateText(day) {
  if (day == null) return null;
  const d = new Date(day * DAY_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** The value printed after a label in the same row: "Name: X" in one cell, or "IP No:" then the next filled cell. */
function labelled(rows, test) {
  for (const row of rows.slice(0, 12)) {
    for (let c = 0; c < row.length; c++) {
      const text = label(row[c]);
      const m = test.exec(text);
      if (!m) continue;
      const inline = (m[1] || '').trim();
      if (inline) return inline;
      for (let n = c + 1; n < row.length; n++) if (label(row[n])) return label(row[n]);
    }
  }
  return null;
}

const NAME = /^Name\s*:?\s*(.*)$/i;
const IP_NO = /^IP\s*No\.?\s*:?\s*(.*)$/i;

/** The final bill's sheet: the itemised bill whose last column is "Charged Amount". */
function isFinalBill({ sheetName, rows }) {
  return /final\s*bill/i.test(sheetName || '') || rows.slice(0, 10).some((r) => r.some((c) => /charged\s*amount/i.test(label(c))));
}

/** The pharmacy bill's sheet: "PHARMACY DETAILS", items with batch and expiry. */
function isPharmacyBill({ sheetName, rows }) {
  return /pharmacy/i.test(sheetName || '') || rows.slice(0, 10).some((r) => r.some((c) => /pharmacy\s*details/i.test(label(c))));
}

// ── the final bill ───────────────────────────────────────────────────────

const SECTION_ROW = /^(\d+)\s*\.\s*(.+)$/;
/** "4 Day(s) X", "37 Time(s) X", "1.5 Day(s) X". */
const COUNT = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*\(s\)\s*[xX×]?$/;

/**
 * The HIS final bill sheet (columns: A date, B code, C description, D order no,
 * E "N Day(s) X", F rate, G labels, H charged amount) →
 * { patient, sections: [{ name, items, subTotals }], grandTotal, netAmount, issues }.
 */
function parseFinalBill(rows) {
  const issues = [];
  const sections = [];
  let section = null;
  let groupSum = 0;
  let grandTotal = null;
  let netAmount = null;

  rows.forEach((row, r) => {
    const [a, b, c, d, e, f, g, h] = Array.from({ length: 8 }, (_, i) => row[i] ?? null);
    const gText = label(g);
    if (/^sub\s*total/i.test(gText)) {
      if (section) {
        const printedTotal = amount(h);
        const sectionSum = round2(section.items.reduce((s, it) => s + (it.amount || 0), 0));
        // A Sub Total closes a group of the section; some bills print one for the whole section.
        if (printedTotal != null && !same(printedTotal, round2(groupSum)) && !same(printedTotal, sectionSum)) {
          issues.push({ level: 'warning', message: `"${section.name}": its lines add up to ${round2(groupSum)}, but the bill's Sub Total is ${printedTotal} — check this section` });
        }
        section.subTotals.push(printedTotal);
      }
      groupSum = 0;
      return;
    }
    if (/^grand\s*total/i.test(gText)) {
      grandTotal = amount(h);
      return;
    }
    if (/^net\s*amount/i.test(gText)) {
      netAmount = amount(h);
      return;
    }

    const aText = label(a);
    const sectionMatch = SECTION_ROW.exec(aText);
    if (sectionMatch && !label(c) && amount(h) == null) {
      section = { name: sectionMatch[2].replace(/\s+/g, ' ').trim(), items: [], subTotals: [] };
      sections.push(section);
      groupSum = 0;
      return;
    }

    const description = printed(c);
    const charged = amount(h);
    if (!description || charged == null || !section) return;
    if (/^description$/i.test(description)) return;

    const item = {
      row: r + 1,
      date: dayOf(a),
      code: printed(b) || null,
      description,
      orderNo: label(d) || null,
      count: null,
      unit: null,
      rate: amount(f),
      amount: charged,
    };
    const countText = label(e);
    const m = COUNT.exec(countText);
    if (m) {
      item.count = Number(m[1]);
      item.unit = m[2].toLowerCase();
    } else if (countText) {
      issues.push({ level: 'warning', message: `"${description}" (row ${r + 1}): "${countText}" is not a count FillPilot knows — entered as one row of ${charged}` });
    }
    section.items.push(item);
    groupSum += charged;
  });

  if (!sections.length) issues.push({ level: 'error', message: 'No sections found on the final bill (rows like "1. ROOM RENT")' });

  return {
    patient: { name: labelled(rows, NAME), ipNo: labelled(rows, IP_NO) },
    sections,
    grandTotal,
    netAmount,
    issues,
  };
}

// ── the pharmacy bill ────────────────────────────────────────────────────

/**
 * The HIS pharmacy bill sheet (Indent No | Date | Item Description | Batch |
 * Expiry | Qty | Price | Value | C/F Total) →
 * { patient, items: [{ date, indentNo, description, qty, price, value, returned }], issueTotal, returnTotal, issues }.
 */
function parsePharmacyBill(rows) {
  const issues = [];
  const items = [];
  // Columns from the header row; the HIS layout when there is none.
  const col = { indent: 0, date: 1, item: 2, qty: 5, price: 6, value: 7 };
  const header = rows.findIndex((row) => row.some((cell) => /^item\s*description$/i.test(label(cell))));
  if (header >= 0) {
    rows[header].forEach((cell, i) => {
      const t = label(cell).toLowerCase();
      if (/^indent/.test(t)) col.indent = i;
      else if (t === 'date') col.date = i;
      else if (/^item\s*description$/.test(t)) col.item = i;
      else if (/^(qty|quantity)$/.test(t)) col.qty = i;
      else if (/^(price|rate|mrp)$/.test(t)) col.price = i;
      else if (/^(value|amount)$/.test(t)) col.value = i;
    });
  }

  let returned = false;
  let indent = { no: null, date: null };
  let issueTotal = null;
  let returnTotal = null;

  rows.forEach((row, r) => {
    if (r <= header) return;
    const joined = row.map(label).filter(Boolean).join(' ');
    if (/item\s*issues?\s*>/i.test(joined)) {
      returned = false;
      return;
    }
    if (/return.*>{2,}|>{2,}.*return/i.test(joined)) {
      returned = true;
      return;
    }
    const totalIssue = /total\s*issue\s*amount\s*:?\s*([\d,]+(?:\.\d+)?)/i.exec(joined);
    if (totalIssue) issueTotal = amount(totalIssue[1]);
    const totalReturn = /total\s*return\s*amount\s*:?\s*([\d,]+(?:\.\d+)?)/i.exec(joined);
    if (totalReturn) returnTotal = amount(totalReturn[1]);
    if (totalIssue || totalReturn || /net\s*amount/i.test(joined)) return;

    const indentNo = label(row[col.indent]);
    const date = dayOf(row[col.date]);
    if (/^\d{3,}$/.test(indentNo) && date != null) indent = { no: indentNo, date };

    const description = printed(row[col.item]);
    const qty = amount(row[col.qty]);
    if (!description || qty == null) return;
    const value = amount(row[col.value]);
    let price = amount(row[col.price]);
    if (price == null && value != null && qty) price = round2(value / qty);
    if (price == null) {
      issues.push({ level: 'warning', message: `Pharmacy "${description}" (row ${r + 1}): no price — left out, enter it yourself` });
      return;
    }
    items.push({ row: r + 1, date: indent.date, indentNo: indent.no, description, qty, price, value, returned });
  });

  if (!items.length) issues.push({ level: 'warning', message: 'No items found on the pharmacy bill' });

  return {
    patient: { name: labelled(rows, NAME), ipNo: labelled(rows, IP_NO) },
    items,
    issueTotal,
    returnTotal,
    issues,
  };
}

// ── the SPDCL rows ───────────────────────────────────────────────────────

const PER_DAY = new Set(['day', 'visit', 'unit']);

/** "130 007" → "130007": IP numbers compared as digits and letters only. */
const ipKey = (ip) => String(ip ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

/**
 * final: parseFinalBill(); pharmacy: parsePharmacyBill() or null.
 * admissionDate: "dd/mm/yyyy" the person typed, or null for the earliest date on the bills.
 * → { patient, tariffType, admissionDate, admissionAssumed, lastDate, stayDays, rows, heads, totals, checks }
 */
function buildSpdclSheet({ final, pharmacy = null, admissionDate = null, tariffType = 'EHS' }) {
  const checks = [];
  const add = (level, message) => {
    if (!checks.some((c) => c.message === message)) checks.push({ level, message });
  };
  for (const issue of final.issues || []) add(issue.level, `Final bill: ${issue.message}`);
  for (const issue of pharmacy?.issues || []) add(issue.level, `Pharmacy bill: ${issue.message}`);

  if (pharmacy && final.patient.ipNo && pharmacy.patient.ipNo && ipKey(final.patient.ipNo) !== ipKey(pharmacy.patient.ipNo)) {
    add('error', `The files are for different patients: IP ${final.patient.ipNo} (final bill) vs IP ${pharmacy.patient.ipNo} (pharmacy bill)`);
  }

  // Dates on the bills: the stay runs from the earliest to the latest.
  const billDays = [
    ...final.sections.flatMap((s) => s.items.map((i) => i.date)),
    ...(pharmacy?.items.map((i) => i.date) ?? []),
  ].filter((d) => d != null);
  const earliest = billDays.length ? Math.min(...billDays) : null;
  const latest = billDays.length ? Math.max(...billDays) : null;

  let admission = admissionDate ? dayOf(admissionDate) : null;
  const assumed = admission == null;
  if (assumed) admission = earliest;
  if (admission == null) {
    add('error', 'No date on either bill — enter the admission date so the rows can be dated');
  } else if (assumed) {
    add('info', `Admission date taken as ${dateText(admission)}, the earliest date on the bills. Change it above if the patient was admitted earlier.`);
  } else if (earliest != null && admission > earliest) {
    add('warning', `The admission date ${dateText(admission)} is after the earliest date on the bills (${dateText(earliest)}) — check it`);
  }

  // A count line is "clean" when N × rate is the amount; anything else is entered as one row of its amount.
  const clean = (item) => item.count != null && Number.isInteger(item.count) && item.count > 0
    && item.rate != null && same(round2(item.count * item.rate), item.amount);

  // Bed days: ICU first, then room rent, back to back from admission.
  const sections = final.sections.map((s) => ({ ...s, ...headOf(s.name) }));
  const bedLines = (head) => sections.filter((s) => s.head === head)
    .flatMap((s) => s.items.filter((i) => clean(i) && i.unit === 'day'));
  const icuLines = bedLines(HEAD.icu);
  const roomLines = bedLines(HEAD.room);
  const starts = new Map();
  let cursor = admission;
  for (const line of [...icuLines, ...roomLines]) {
    const start = line.date ?? cursor;
    starts.set(line, start);
    if (start != null) cursor = start + line.count;
  }
  const bedDays = [...icuLines, ...roomLines].reduce((n, l) => n + l.count, 0);
  const stayDays = bedDays || (admission != null && latest != null ? Math.max(1, latest - admission) : 1);
  if (roomLines.length > 1 || icuLines.length > 1) {
    add('info', 'The bill has more than one room or ICU line — they are dated one after another (ICU first). Check the dates if the patient moved back and forth.');
  }

  const rows = [];
  const late = [];
  const push = (row) => {
    rows.push(row);
    if (row.day != null && latest != null && row.day > latest && !late.includes(row.description)) late.push(row.description);
  };
  const row = (head, item, day, rate, qty, section) => ({
    head,
    code: item.code ?? null,
    description: item.description,
    day,
    date: dateText(day),
    rate,
    qty,
    amount: round2(rate * qty),
    section,
  });

  let finalPharmacy = null;
  for (const section of sections) {
    if (section.head === HEAD.pharmacy) {
      // The final bill has pharmacy as one total; the pharmacy bill has its items.
      finalPharmacy = round2((finalPharmacy || 0) + section.items.reduce((s, i) => s + (i.amount || 0), 0));
      continue;
    }
    if (!section.known) add('warning', `Section "${section.name}" is new to FillPilot — its lines are entered as ${HEAD.investigations}. Check the Service_Type.`);
    const seen = new Map();
    for (const item of section.items) {
      // The same item again in this section, without a date of its own, goes on the next day.
      const key = `${item.code ?? ''}|${item.description.toUpperCase()}`;
      const repeat = seen.get(key) ?? 0;
      seen.set(key, repeat + 1);
      const from = item.date ?? (admission == null ? null : admission + repeat);
      const plus = (day, n) => (day == null ? null : day + n);

      if (starts.has(item)) {
        for (let n = 0; n < item.count; n++) push(row(section.head, item, plus(starts.get(item), n), item.rate, 1, section.name));
        continue;
      }
      if (clean(item) && PER_DAY.has(item.unit)) {
        const start = item.date ?? admission;
        for (let n = 0; n < item.count; n++) push(row(section.head, item, plus(start, n), item.rate, 1, section.name));
        continue;
      }
      if (clean(item) && item.unit === 'time') {
        if (item.count === 1) {
          push(row(section.head, item, from, item.rate, 1, section.name));
          continue;
        }
        // Spread over the stay: 37 times over 7 days → 6, 6, 5, 5, 5, 5, 5.
        const days = Math.min(item.count, stayDays);
        const start = item.date ?? admission;
        const base = Math.floor(item.count / days);
        const extra = item.count % days;
        for (let n = 0; n < days; n++) push(row(section.head, item, plus(start, n), item.rate, base + (n < extra ? 1 : 0), section.name));
        continue;
      }
      if (clean(item)) {
        // A count FillPilot has no rule for (hours, sessions): one row of N.
        add('warning', `"${item.description}": ${item.count} ${item.unit}(s) entered as one row on ${dateText(from) ?? 'no date'} — check it`);
        push(row(section.head, item, from, item.rate, item.count, section.name));
        continue;
      }
      if (item.count != null) {
        add('warning', `"${item.description}": ${item.count} ${item.unit}(s) × ${item.rate ?? '?'} is not the charged ${item.amount} — entered as one row of ${item.amount}`);
      }
      push(row(section.head, item, from, item.amount, 1, section.name));
    }
  }

  // Pharmacy: every item on its indent's date, after the final bill's rows.
  let pharmacyIssued = null;
  let pharmacyReturned = 0;
  let roundingGap = 0;
  if (pharmacy) {
    pharmacyIssued = 0;
    let fractional = false;
    for (const item of pharmacy.items) {
      const head = item.returned ? HEAD.pharmacyReturns : HEAD.pharmacy;
      const day = item.date ?? admission;
      if (item.date == null) add('warning', `Pharmacy "${item.description}": no indent date — dated ${dateText(admission) ?? '(none)'}`);
      if (!Number.isInteger(item.qty)) fractional = true;
      const out = row(head, { code: null, description: item.description }, day, item.price, item.qty, 'Pharmacy');
      push(out);
      const charged = item.value ?? out.amount;
      if (item.returned) pharmacyReturned = round2(pharmacyReturned + charged);
      else pharmacyIssued = round2(pharmacyIssued + charged);
      roundingGap = round2(roundingGap + (charged - out.amount) * (item.returned ? -1 : 1));
    }
    if (pharmacy.items.some((i) => i.returned)) {
      add('warning', `The pharmacy bill has returns (${pharmacyReturned}) — entered under "${HEAD.pharmacyReturns}". Check how SPDCL wants returns.`);
    }
    if (fractional) add('warning', 'Some pharmacy quantities are not whole numbers — SPDCL\'s sheet shows quantities without decimals; check those rows');
    if (pharmacy.issueTotal != null && !same(pharmacy.issueTotal, pharmacyIssued)) {
      add('warning', `Pharmacy items add up to ${pharmacyIssued}, but the pharmacy bill's total issue amount is ${pharmacy.issueTotal}`);
    }
  }
  const pharmacyNet = pharmacyIssued == null ? null : round2(pharmacyIssued - pharmacyReturned);
  if (finalPharmacy != null && pharmacy == null) {
    add('error', `The final bill has pharmacy ${finalPharmacy}, but no pharmacy bill was chosen — its items are missing from the SPDCL Excel`);
  } else if (finalPharmacy != null && !same(finalPharmacy, pharmacyNet)) {
    add('error', `Pharmacy on the final bill is ${finalPharmacy}, but the pharmacy bill comes to ${pharmacyNet} — are these the same patient's latest bills?`);
  }

  if (late.length) {
    add('warning', `${late.slice(0, 3).map((d) => `"${d}"`).join(', ')}${late.length > 3 ? ` and ${late.length - 3} more` : ''} run past the last date on the bills (${dateText(latest)}) — check the admission date and those rows`);
  }

  // Returns come off the bill, as they do on the HIS pharmacy bill.
  const excel = round2(rows.reduce((s, r) => s + (r.head === HEAD.pharmacyReturns ? -r.amount : r.amount), 0));
  const billLines = round2(final.sections.reduce((s, sec) => s + sec.items.reduce((t, i) => t + (i.amount || 0), 0), 0));
  if (final.grandTotal != null && !same(final.grandTotal, billLines)) {
    add('warning', `The final bill's lines add up to ${billLines}, but its Grand Total is ${final.grandTotal}`);
  }
  const hisBill = final.grandTotal ?? billLines;
  const difference = round2(hisBill - excel);
  if (Math.abs(difference) >= 0.01) {
    if (same(difference, roundingGap)) {
      add('info', `The SPDCL total ${excel} is ${Math.abs(difference)} ${difference > 0 ? 'below' : 'above'} the HIS bill (${hisBill}): some pharmacy prices are rounded to paise, and SPDCL works out Amount = Rate × Qty.`);
    } else {
      add('warning', `The SPDCL total ${excel} differs from the HIS bill (${hisBill}) by ${difference} — check the rows`);
    }
  }

  const heads = [];
  for (const r of rows) {
    let h = heads.find((x) => x.head === r.head);
    if (!h) heads.push((h = { head: r.head, rows: 0, amount: 0 }));
    h.rows += 1;
    h.amount = round2(h.amount + r.amount);
  }

  return {
    patient: { name: final.patient.name ?? pharmacy?.patient.name ?? null, ipNo: final.patient.ipNo ?? pharmacy?.patient.ipNo ?? null },
    tariffType: TARIFF_TYPES.includes(tariffType) ? tariffType : 'EHS',
    admissionDate: dateText(admission),
    admissionAssumed: assumed,
    lastDate: dateText(latest),
    stayDays,
    rows: rows.map(({ day, ...r }) => r),
    heads,
    totals: { excel, hisBill, netAmount: final.netAmount ?? null, pharmacyBill: pharmacyNet, difference },
    checks,
  };
}

module.exports = {
  HEAD, TARIFF_TYPES, headOf, dayOf, dateText, isFinalBill, isPharmacyBill, parseFinalBill, parsePharmacyBill, buildSpdclSheet,
};
