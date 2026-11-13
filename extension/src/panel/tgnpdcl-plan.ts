// TGNPDCL "New Medical Bill Entry" site profile: the claim (from the bills)
// → one list of page actions per wizard tab. Labels and column headings are
// matched as written on the site (screenshots, 2026-10-09). If the site
// renames something, the step reports exactly which label it could not find,
// and "Copy page structure" shows the new wording to update here.

import type { TgnpdclClaim } from '../../../web/projects/shared/src/api-types';
import type { PageAction } from '../../../web/projects/shared/src/page-contract';

export interface PlanStep {
  key: 'room' | 'investigations' | 'pharmacy' | 'summary';
  title: string;
  /** What will be filled, one line each, for the person to check first. */
  preview: string[];
  /**
   * General reminders for this tab (declarations, reports, pouches). The bill's
   * items the person must enter or check are in the review list (tgnpdcl-review.ts).
   */
  manual: string[];
  actions: PageAction[];
  /** The bills hold no data for this tab — only the tab can be opened. */
  nothingToFill?: boolean;
}

/** Matches this site's bill-entry page. */
export function isTgnpdclBillPage(url: URL | null): boolean {
  return Boolean(url && /(^|\.)tgnpdcl\.com$/i.test(url.hostname) && /medical-bill-entry/i.test(url.pathname));
}

const WARD_TABLE = ['Ward\\s*Occupied', 'Rate\\s*Charged', '^Days$'];
const DOCTOR_TABLE = ['Doctor\\s*Name', 'No\\.?\\s*of\\s*Days'];
const PHARMACY_TABLE = ['Name\\s*of\\s*item', '^Rate$', '^Qty$'];

// Wizard tab captions. The number is optional: some builds draw it in a
// separate badge, or with CSS, so it is not part of the caption's text.
// One-word captions are anchored so "Add pharmacy row" is never taken for a tab.
// A tab captioned "Summary & Submit" is refused like any "submit" caption —
// the person opens that one (Next from tab 3 lands on it anyway).
const TAB = {
  room: 'Room\\b.{0,6}Consultation',
  investigations: 'Investigations?\\b.{0,6}Procedures?',
  pharmacy: '^\\s*(3\\s*[.)]?\\s*)?Pharmacy\\b.{0,12}$',
  summary: '^\\s*(4\\s*[.)]?\\s*)?Summary\\b.{0,14}$',
};

const NEXT = '^\\s*Next(\\s*(step|tab))?\\s*[»›→>▸]*\\s*$';

/**
 * The bill's tariff mark → the site's "Select Tariff Type" option. The site
 * (2026-10) offers EHS Ax-I…VI, NIMS(2015), NIMS2022, CGHS 21 and three
 * CGHS(2025) tiers; the bills mark codes NIMS or COMM ("COMM." too). Yashoda's
 * NIMS rates are the site's EHS Ax-V list (82A CRP ₹750 on both; NIMS(2015)
 * has ₹500) and COMM is EHS Ax-VI — confirmed with the hospital, 2026-10-13.
 * CGHS is not printed: the backend marks unmarked CGHS codes (MG038) with it,
 * and they go to "CGHS(2025)-Tier I" (Hyderabad is a Tier I city), never Tier II or III.
 * EHS is not printed either: the backend marks the dotted procedure codes
 * (51.22.6) with it, and they are looked for in "EHS Ax-III", then "EHS Ax-II"
 * (the client, 2026-11-11) — the first list that has the code is used.
 * A mark that is not listed here is never guessed — its codes are left for the person.
 */
const TARIFF_OPTION: Record<string, string | string[]> = {
  NIMS: '^EHS\\s*Ax\\s*-?\\s*V\\s*$',
  COMM: '^EHS\\s*Ax\\s*-?\\s*VI\\s*$',
  CGHS: '^CGHS\\s*\\(\\s*2025\\s*\\)\\s*[-‐‑–—]?\\s*Tier\\s*[-‐‑–—]?\\s*(I|1)\\s*$',
  EHS: ['^EHS\\s*Ax\\s*-?\\s*III\\s*$', '^EHS\\s*Ax\\s*-?\\s*II\\s*$'],
};

/** The same, as the site shows it — for the person entering a code by hand. */
export const TARIFF_NAME: Record<string, string> = {
  NIMS: 'EHS Ax-V',
  COMM: 'EHS Ax-VI',
  CGHS: 'CGHS(2025)-Tier I',
  EHS: 'EHS Ax-III (or EHS Ax-II)',
};

/** Captions this profile relies on — located in the page outline saved when a step fails. */
export const OUTLINE_PROBES = [
  'Room\\b.{0,6}Consultation', 'Investigations?\\b.{0,6}Procedures?', '^\\s*(\\d\\s*[.)]?\\s*)?(CC|Pharmacy|Summary)\\b',
  '^\\s*(Next|Back)\\b', 'Add\\s*(ward|doctor|row|item)', 'Add\\s*from\\s*tariff',
  'ICU\\s*Days', 'Number\\s*of\\s*Doctors', 'Ward\\s*Occupied', 'Rate\\s*Charged', 'Doctor\\s*Name',
  'Tariff\\s*Type', 'Search\\s*tariff', 'Amount\\s*claimed', 'Employee\\s*paid', 'Concession', 'Hospital\\s*bill\\s*number',
  'Upload\\s*Excel', 'Download\\s*Template', 'Name\\s*of\\s*item', 'Loaded\\s+\\d+\\s+pharmacy',
];

const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
/** "2026-10-09" → "09/10/2026", as the site shows dates. */
const dayMonthYear = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : 'no date');
/** " (or 781)" — a code whose last character OCR cannot settle; the site's price for each reading decides. */
const orReadings = (alternatives?: string[]) => (alternatives?.length ? ` (or ${alternatives.join(' / ')})` : '');

export function buildPlan(claim: TgnpdclClaim): PlanStep[] {
  const { room, investigations, pharmacy, summary } = claim.tabs;

  // ---- 1. Room & Consultation
  // "Room Days (total)" is not typed: the site locks it and works it out from the ward rows.
  const roomActions: PageAction[] = [
    { type: 'clickTab', text: TAB.room, next: NEXT, label: 'Open "1. Room & Consultation"' },
    { type: 'setField', id: 'icuDays', field: 'ICU\\s*Days', value: String(room.icuDays), label: `ICU days = ${room.icuDays}` },
  ];
  if (room.wards.length) {
    roomActions.push({ type: 'ensureRows', headers: WARD_TABLE, count: room.wards.length, addButton: 'Add\\s*ward', label: `${room.wards.length} ward row(s)` });
    room.wards.forEach((w, i) => {
      roomActions.push(
        { type: 'setCell', headers: WARD_TABLE, row: i, column: 'Ward\\s*Occupied', value: String(w.ratePerDay), optionMatch: `(^|\\D)${Math.round(w.ratePerDay)}(\\D|$)`, label: `Ward ${i + 1}: ward with ${rupees(w.ratePerDay)}/day` },
        { type: 'setCell', headers: WARD_TABLE, row: i, column: 'Rate\\s*Charged', value: String(w.ratePerDay), label: `Ward ${i + 1}: rate ${rupees(w.ratePerDay)}` },
        { type: 'setCell', headers: WARD_TABLE, row: i, column: '^Days$', value: String(w.days), label: `Ward ${i + 1}: ${w.days} day(s)` },
      );
    });
  }
  if (room.doctors.length) {
    roomActions.push(
      { type: 'setField', id: 'consultDoctors', field: 'Number\\s*of\\s*Doctors', value: String(room.numberOfDoctors), label: `Number of doctors = ${room.numberOfDoctors}` },
      { type: 'ensureRows', headers: DOCTOR_TABLE, count: room.doctors.length, addButton: 'Add\\s*(doctor|row)', label: `${room.doctors.length} doctor row(s)` },
    );
    room.doctors.forEach((d, i) => {
      roomActions.push(
        { type: 'setCell', headers: DOCTOR_TABLE, row: i, column: 'Doctor\\s*Name', value: d.name, label: `Doctor ${i + 1}: ${d.name}` },
        { type: 'setCell', headers: DOCTOR_TABLE, row: i, column: 'No\\.?\\s*of\\s*Days', value: String(d.days), label: `Doctor ${i + 1}: ${d.days} day(s)` },
      );
    });
  }

  // ---- 2. Investigations and Procedures
  /** The tariff types to search for a mark, in order (most marks have one). */
  const optionsFor = (tariff: string | null): string[] => {
    const o = tariff ? TARIFF_OPTION[tariff] : undefined;
    return o ? (Array.isArray(o) ? o : [o]) : [];
  };
  const optionFor = (tariff: string | null) => optionsFor(tariff)[0] ?? null;
  // One tariff type after the other — every switch makes the site load that tariff's list again.
  // Codes whose tariff type is not known come last: they are reported, not searched.
  const coded = investigations.items
    .filter((i) => !i.manual && i.code)
    .sort((a, b) => Number(!optionFor(a.tariff)) - Number(!optionFor(b.tariff)) || (a.tariff || '').localeCompare(b.tariff || ''));
  // Items without a usable code, the hospital's own codes (YSSH) and codes whose mark the
  // site has no tariff type for are left for the person: the review list says which.
  const invActions: PageAction[] = [
    { type: 'clickTab', text: TAB.investigations, next: NEXT, label: 'Open "2. Investigations and Procedures"' },
    ...coded.map((i): PageAction => ({
      type: 'addTariffItem',
      code: i.code!,
      tariff: i.tariff,
      tariffOption: optionFor(i.tariff),
      ...(optionsFor(i.tariff).length > 1 ? { moreTariffOptions: optionsFor(i.tariff).slice(1) } : {}),
      qty: i.qty,
      amountClaimed: i.amountClaimed,
      ...(i.alternatives?.length ? { alternatives: i.alternatives } : {}),
      label: `${i.code}${orReadings(i.alternatives)} ${i.description} — qty ${i.qty}, ${rupees(i.amountClaimed)}`,
    })),
  ];

  // ---- 3. Pharmacy — the pharmacy bill's rows, as the site's own upload Excel (the team's way: the site fills its table from it)
  const pharmacyActions: PageAction[] = [{ type: 'clickTab', text: TAB.pharmacy, next: NEXT, label: 'Open "3. Pharmacy"' }];
  const pharmacyTotal = Math.round(pharmacy.rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  if (pharmacy.rows.length && pharmacy.file) {
    pharmacyActions.push({
      type: 'loadPharmacyExcel', fileName: pharmacy.file.fileName, base64: pharmacy.file.base64, rows: pharmacy.rows.length, total: pharmacyTotal, headers: PHARMACY_TABLE,
      label: `Pharmacy Excel: ${pharmacy.rows.length} item(s), ${rupees(pharmacyTotal)}`,
    });
  }
  const pouches = pharmacy.rows.filter((r) => r.pouch);

  // ---- 4. Summary — inputs only; declarations and Save & Submit stay with the person
  const summaryActions: PageAction[] = [{ type: 'clickTab', text: TAB.summary, next: NEXT, label: 'Open "4. Summary"' }];
  if (summary.employeePaid != null) summaryActions.push({ type: 'setField', id: 'employeePaid', field: 'Employee\\s*paid', value: String(summary.employeePaid), label: `Employee paid = ${rupees(summary.employeePaid)}` });
  summaryActions.push({ type: 'setField', id: 'concession', field: 'Concession', value: String(summary.concession), label: `Concession = ${summary.concession}` });
  if (summary.hospitalBillNumber) summaryActions.push({ type: 'setField', id: 'hospitalBillNumber', field: 'Hospital\\s*bill\\s*number', value: summary.hospitalBillNumber, label: `Hospital bill number = ${summary.hospitalBillNumber}` });

  return [
    {
      key: 'room',
      title: '1. Room & Consultation',
      preview: [
        `ICU days: ${room.icuDays}`,
        ...room.wards.map((w, i) => `Ward ${i + 1}: ${rupees(w.ratePerDay)}/day × ${w.days} day(s)`),
        `Doctors: ${room.numberOfDoctors}`,
        ...room.doctors.map((d) => `• ${d.name} — ${d.days} day(s)`),
      ],
      manual: [],
      actions: roomActions,
    },
    {
      key: 'investigations',
      title: '2. Investigations and Procedures',
      preview: coded.map((i) => `${i.code}${orReadings(i.alternatives)}${i.tariff ? ` (${i.tariff})` : ''} —${i.description}${i.lines > 1 ? ` ×${i.lines} lines` : ''} — qty ${i.qty}, ${rupees(i.amountClaimed)}${i.review ? '  ⚠' : ''}`),
      manual: ['Tick the compliance declaration and upload investigation reports'],
      actions: invActions,
    },
    {
      key: 'pharmacy',
      title: '3. Pharmacy',
      preview: pharmacy.rows.map((r) => `${dayMonthYear(r.date)} — ${r.name} — ${r.qty} × ${rupees(r.rate)} = ${rupees(r.amount)}${r.pouch ? ' · pouch' : ''}`),
      manual: [
        ...(pouches.length
          ? [`Enclose the pouches of ${pouches.length} item(s) costing ₹2,000 or more each (${pouches.reduce((n, r) => n + r.qty, 0)} pouch(es)) with the original bill`]
          : []),
        ...(pharmacy.rows.length ? ['If the site does not take the Excel, use "Download Excel" below and the site\'s "Upload Excel" button'] : []),
      ],
      actions: pharmacyActions,
      nothingToFill: !pharmacy.rows.length,
    },
    {
      key: 'summary',
      title: '4. Summary',
      preview: [`Employee paid: ${rupees(summary.employeePaid)}`, `Concession: ${summary.concession}`, `Hospital bill number: ${summary.hospitalBillNumber ?? '—'}`],
      manual: ['Check totals, tick the hospital declarations, then Save & Submit yourself'],
      actions: summaryActions,
    },
  ];
}

const words = (pattern: string) =>
  pattern.replace(/\\s\*/g, ' ').replace(/\\\.\??/g, '.').replace(/\(([^|)]*)\|[^)]*\)/g, '$1').replace(/\\[a-zA-Z]|[\\^$?*+()[\]{}]/g, '').replace(/\s+/g, ' ').trim();

/**
 * What a step was, without what was typed: the activity log names the field
 * or the tariff code, never a patient's or doctor's name or an amount.
 */
export function auditLabel(action: PageAction): string {
  switch (action.type) {
    case 'setField': return words(action.field);
    case 'ensureRows': return `${words(action.headers[0])} table: rows`;
    case 'setCell': return `${words(action.headers[0])} table, row ${action.row + 1}: ${words(action.column)}`;
    case 'addTariffItem': return `Tariff code ${action.code}${action.tariff ? ` (${action.tariff})` : ''}`;
    // The item names stay out of the log.
    case 'loadPharmacyExcel': return `Pharmacy Excel (${action.rows} row(s))`;
    default: return action.label;
  }
}

/** The site's Next button — never Save as Draft, never Save & Submit. */
export const NEXT_ACTION: PageAction = { type: 'clickButton', text: NEXT, label: 'Next' };
