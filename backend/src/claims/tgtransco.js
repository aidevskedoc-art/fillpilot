// The hospital's HIS Excel exports (final bill + pharmacy bill) → the rows of
// the TG Transco bill template ("Test" sheet): one row per service or medicine
// per day, dated as for SPDCL (spdcl.js: buildDailyRows), with TG Transco's own
// heads and columns. Pure: the route reads the files (xlsx.js) and writes the
// workbook (tgtransco-workbook.js).
//
// Made the way the billing team fills it (IP 122609, 11 November 2026):
//   Service_Type   TG Transco's list: ROOM RENT, ICU, CONSULTATION, INVESTIGATIONS
//                  (cardiology, laboratory, radiology), SURGERY CHARGES,
//                  IMPLANTS/MEDICAL APPLIANCES, PHARMACY (every pharmacy-bill item),
//                  OTHERS (blood transfusion, catheterisation, anything else)
//   Package        PACKAGE for surgery and implants, and for any row dated on or after
//                  the date of surgery ("Package starts from the date of surgery");
//                  NON PACKAGE otherwise
//   Tariff Code    the bill's code without its tariff mark: 3055/NIMS → 3055
//   Service Details  as on the bill; room rent in the team's words; doctors as "Dr.NAME"
//   Dates          dd.mm.yyyy; surgery and implants on the date of surgery; a test
//                  billed twice without a date stays on the same day
//   Rate           a pharmacy item whose price × qty is not its value: value ÷ qty to
//                  3 decimals, so Rate × Qty is the bill (34.643 × 3 = 103.93)
// Admission, discharge and surgery dates also go in the template's box (N4:N6).
const spdcl = require('./spdcl');

const { dayOf, dateText, buildDailyRows, checkList, lateRows, ICU, ROOM, PHARMACY } = spdcl;

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** The Service_Type list of TG Transco's template (Test!O20001:O20013), spelled as there. */
const HEAD = {
  consultation: 'CONSULTATION',
  investigations: 'INVESTIGATIONS',
  room: 'ROOM RENT',
  icu: 'ICU',
  pharmacy: 'PHARMACY',
  pharmacyReturns: 'PHARMACY RETURNS',
  consumables: 'CONSUMABLES',
  consumableReturns: 'CONSUMABLES RETURNS',
  surgery: 'SURGERY CHARGES',
  implants: 'IMPLANTS/MEDICAL APPLIANCES',
  employeePaid: 'EMPLOYEE PAID',
  discount: 'DISCOUNT IN RS.',
  others: 'OTHERS',
};

/** The TARIFF_TYPE list of the template (Test!M20001:M20008). */
const TARIFF_TYPES = [
  'CGHS NABH', 'CGHS NON-NABH', 'CGHS SUPERSPECIALITY', 'EHS SUPERSPECIALITY', 'EHS NON-SUPERSPECIALITY', 'NIMS 2015', 'TATAMEMORIAL', 'NOT LISTED',
];
const DEFAULT_TARIFF = 'EHS SUPERSPECIALITY';

/** The Package/Non-Package list (Test!N20001:N20003); a row is one or the other. */
const PACKAGE = 'PACKAGE';
const NON_PACKAGE = 'NON PACKAGE';
/** Heads that are the package itself, whatever their date. */
const PACKAGED = new Set([HEAD.surgery, HEAD.implants]);

/** The team's words for a room-rent row. */
const ROOM_TEXT = 'ROOM RENT (Includes Medical and Nursing Charges )';

const INVESTIGATIONS = /CARDIOLOGY|LABORATORY|RADIOLOGY|PATHOLOGY|\bRBS\b|GLUCOMETER/i;
/** Sections the team enters under OTHERS, as TG Transco's example bill does (nebulization, oxygen, Ryles…). */
const KNOWN_OTHERS = /BLOOD\s*TRANSFUSION|BED\s*SIDE\s*PROCEDURE|CATHETERI[SZ]ATION|DIALYSIS|NEBULI[SZ]ATION|OXYGEN|PHYSIOTHERAPY|PROCEDURE\s*CHARGES|VENTILATOR/i;

/** Which TG Transco head a final-bill section goes under → { head, known }. Anything new goes under OTHERS, flagged. */
function headOf(sectionName) {
  if (ICU.test(sectionName)) return { head: HEAD.icu, known: true };
  if (ROOM.test(sectionName)) return { head: HEAD.room, known: true };
  if (/DOCTOR|CONSULTATION/i.test(sectionName)) return { head: HEAD.consultation, known: true };
  if (PHARMACY.test(sectionName)) return { head: HEAD.pharmacy, known: true };
  // Before surgery: a "SURGICAL PATHOLOGY" section is a test.
  if (INVESTIGATIONS.test(sectionName)) return { head: HEAD.investigations, known: true };
  if (/\bSURGERY\b|\bSURGICAL\b/i.test(sectionName)) return { head: HEAD.surgery, known: true };
  if (/IMPLANT|MEDICAL\s*APPLIANCE/i.test(sectionName)) return { head: HEAD.implants, known: true };
  return { head: HEAD.others, known: KNOWN_OTHERS.test(sectionName) };
}

/** "3055/NIMS" → "3055", "R171+R171/NIM" → "R171+R171", "2251/COMM." → "2251": the code without the tariff it is from. */
function tariffCode(code) {
  if (!code) return null;
  const bare = String(code).trim().replace(/\s*\/\s*[A-Z][A-Z0-9.]*\s*$/i, '').trim();
  return bare || null;
}

/** Service Details as the team writes them. */
function serviceDetails(head, description) {
  if (head === HEAD.room) return ROOM_TEXT;
  if (head === HEAD.consultation && !/^DR\b/i.test(description)) return `Dr.${description}`;
  return description;
}

/** Day number → "01.08.2026", the template's date format. */
const fileDate = (day) => (day == null ? null : dateText(day).replace(/\//g, '.'));

/**
 * The Rate of a pharmacy row: the bill's price, unless price × qty is not the
 * item's value (the printed price is rounded) — then value ÷ qty to 3 decimals.
 */
function pharmacyRate(item) {
  // To the paisa: 34.64 × 3 = 103.92 is not 103.93.
  if (item.value == null || !item.qty || Math.abs(round2(item.price * item.qty) - item.value) < 0.005) return item.price;
  return round3(item.value / item.qty);
}

/**
 * final: parseFinalBill(); pharmacy: parsePharmacyBill() or null.
 * admissionDate, dischargeDate, surgeryDate: "dd/mm/yyyy" (or dd.mm.yyyy) the person typed, or null.
 * Without them: admission is the earliest date on the bills, surgery the date on
 * the bill's surgery lines (if any), discharge is left for the person.
 * → { patient, tariffType, admissionDate, admissionAssumed, dischargeDate, surgeryDate, surgeryAssumed,
 *     lastDate, stayDays, rows, heads, totals, checks } — dates as dd.mm.yyyy.
 */
function buildTgTranscoSheet({ final, pharmacy = null, admissionDate = null, dischargeDate = null, surgeryDate = null, tariffType = DEFAULT_TARIFF }) {
  const { checks, add } = checkList();

  // The date of surgery: typed, or the earliest date printed on the surgery lines.
  const billSurgery = final.sections.filter((s) => headOf(s.name).head === HEAD.surgery)
    .flatMap((s) => s.items.map((i) => i.date)).filter((d) => d != null);
  let surgery = surgeryDate ? dayOf(surgeryDate) : null;
  const surgeryAssumed = surgery == null && billSurgery.length > 0;
  if (surgeryAssumed) surgery = Math.min(...billSurgery);
  const discharge = dischargeDate ? dayOf(dischargeDate) : null;

  const daily = buildDailyRows({
    final,
    pharmacy,
    admissionDate,
    site: 'TG Transco',
    headOf,
    heads: HEAD,
    add,
    repeatsNextDay: false,
    pharmacyRate,
    // Surgery and implants on the date of surgery — none (left blank) until it is known.
    undatedDay: (section) => (PACKAGED.has(section.head) ? surgery : undefined),
  });
  const { admission, latest } = daily;

  const rows = daily.rows.map((r) => ({
    head: r.head,
    packageType: PACKAGED.has(r.head) || (surgery != null && r.day != null && r.day >= surgery) ? PACKAGE : NON_PACKAGE,
    code: tariffCode(r.code),
    description: serviceDetails(r.head, r.description),
    date: fileDate(r.day),
    rate: r.rate,
    qty: r.qty,
    amount: r.amount,
    section: r.section,
    day: r.day,
  }));

  // ── TG Transco's own checks ──
  if (pharmacy?.items.some((i) => i.returned)) {
    add('info', `The pharmacy bill has returns (${daily.pharmacyReturned}) — entered under "${HEAD.pharmacyReturns}" as positive amounts, as TG Transco's instructions say, and taken off the total`);
  }
  // Discharge and surgery dates are optional (the client, 2026-11-13): said, not asked for.
  if (rows.some((r) => PACKAGED.has(r.head)) && surgery == null) {
    add('info', 'No date of surgery (optional) — the surgery and implant rows are left without a Service Date');
  } else if (surgeryAssumed) {
    add('info', `Date of surgery taken as ${fileDate(surgery)}, the date on the bill's surgery lines. Change it above if it is wrong.`);
  }
  if (surgery != null && admission != null && surgery < admission) {
    add('warning', `The date of surgery ${fileDate(surgery)} is before the admission date ${fileDate(admission)} — check it`);
  }
  if (discharge == null) {
    add('info', 'No date of discharge (optional) — left empty in the dates box');
  } else {
    if (admission != null && discharge < admission) add('warning', `The date of discharge ${fileDate(discharge)} is before the admission date ${fileDate(admission)} — check it`);
    if (surgery != null && surgery > discharge) add('warning', `The date of surgery ${fileDate(surgery)} is after the date of discharge ${fileDate(discharge)} — check it`);
  }
  const ends = [latest, surgery].filter((d) => d != null);
  const last = discharge ?? (ends.length ? Math.max(...ends) : null);
  const late = lateRows(rows, last, discharge != null ? `the date of discharge (${fileDate(discharge)})` : `the last date on the bills (${fileDate(last)})`);
  if (late) add('warning', `${late} — check the dates`);

  const uncoded = [...new Set(rows.filter((r) => r.head === HEAD.investigations && !r.code).map((r) => r.description))];
  if (uncoded.length) {
    add('warning', `TG Transco wants a tariff code on every investigation — ${uncoded.slice(0, 3).map((d) => `"${d}"`).join(', ')}${uncoded.length > 3 ? ` and ${uncoded.length - 3} more` : ''} have none; add them in the Tariff Code column`);
  }
  const joined = [...new Set(rows.filter((r) => r.code && r.code.includes('+')).map((r) => r.code))];
  if (joined.length) {
    add('info', `${joined.join(', ')}: more than one code in a cell, as on the bill. TG Transco's instructions ask for one code per cell — split them if they ask.`);
  }
  const byDate = rows.filter((r) => r.packageType === PACKAGE && !PACKAGED.has(r.head)).length;
  if (byDate) {
    add('info', `${byDate} row(s) dated on or after the date of surgery (${fileDate(surgery)}) are marked PACKAGE — TG Transco's package starts from the date of surgery`);
  }

  const packageAmount = round2(rows.filter((r) => r.packageType === PACKAGE)
    .reduce((s, r) => s + (r.head === HEAD.pharmacyReturns ? -r.amount : r.amount), 0));

  return {
    patient: daily.patient,
    tariffType: TARIFF_TYPES.includes(tariffType) ? tariffType : DEFAULT_TARIFF,
    admissionDate: fileDate(admission),
    admissionAssumed: daily.assumed,
    dischargeDate: fileDate(discharge),
    surgeryDate: fileDate(surgery),
    surgeryAssumed,
    lastDate: fileDate(latest),
    stayDays: daily.stayDays,
    rows: rows.map(({ day, ...r }) => r),
    heads: daily.heads,
    totals: { ...daily.totals, package: packageAmount },
    checks,
  };
}

module.exports = {
  HEAD, TARIFF_TYPES, DEFAULT_TARIFF, PACKAGE, NON_PACKAGE, ROOM_TEXT, headOf, tariffCode, pharmacyRate, buildTgTranscoSheet,
};
