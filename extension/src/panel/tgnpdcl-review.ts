// What the person still has to do on a TGNPDCL tab, as one list of two kinds
// (the client, 2026-11-13: the red and amber lines confused the staff):
//   enter — FillPilot could not put it on the site: the person must
//   check — it is on the site, but something may differ from the bill
// Each says in one sentence what to do, where it is (on the site, on the bill)
// and, for "enter", what to type. FillPilot's own messages stay as the details.
// Lines that are only information are not in it.
//
// One card per item: what reading the bill doubted about it (the checks the
// server ties to a tab and item) and what its fill left to do are said on the
// same card. Only checks about the bill as a whole stay in the list at the top.

import type { BillPlace, ClaimCheck, TgnpdclClaim, TgnpdclSource } from '../../../web/projects/shared/src/api-types';
import type { ActionResult, PageAction, PageSpot } from '../../../web/projects/shared/src/page-contract';
import { NEXT_ACTION, TARIFF_NAME } from './tgnpdcl-plan';
import type { PlanStep } from './tgnpdcl-plan';

export type ReviewLevel = 'enter' | 'check';

export interface ReviewItem {
  /**
   * The same for the same item of the same bill, fill after fill: ticks are kept by it. It carries
   * the card's kind and whether a fill added to it, so a tick given to a doubt about the bill does
   * not hide what a later fill left to do.
   */
  key: string;
  level: ReviewLevel;
  title: string;
  /** A short name for the outline's tag on the site (the code, for a tariff item); else the title. */
  short?: string;
  /** Code, quantity, amount — as the bill has them. */
  facts?: string;
  /** One sentence: what to do. */
  todo: string;
  /** Why: FillPilot's own messages and the bill's notes. */
  why: string[];
  /** What to type on the site, field by field (the popup copies each value). */
  how?: { label: string; value: string }[];
  spot?: PageSpot;
  at?: BillPlace;
}

type Row = TgnpdclClaim['tabs']['investigations']['items'][number];
type OwnRow = NonNullable<TgnpdclClaim['tabs']['investigations']['ownItems']>[number];

const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const billPage = (source?: TgnpdclSource): BillPlace | undefined => (source?.page ? { doc: 'final', page: source.page } : undefined);
const tariffName = (tariff: string | null) => (tariff ? TARIFF_NAME[tariff] ?? `none — the bill marks it "${tariff}"` : 'not on the bill');

// Card keys, before the kind is added (reviewFor).
const codeKey = (code: string, tariff: string | null) => `inv|code|${code}|${tariff ?? ''}`;
const manualKey = (i: Row) => `inv|manual|${i.description}|${i.amountClaimed}`;
const ownKey = (i: OwnRow) => `inv|own|${i.description}|${i.rate}`;
const isManual = (i: Row) => i.manual || !i.code;
const WARD_KEY = 'room|ward';
const doctorKey = (name: string) => `room|doctor|${name}`;

/** The todo a fill's result gives when it has nothing particular to say. */
const ADDED = 'Added — compare it with the bill.';

/** Where an action's row or field is (as the content script finds it again). */
function spotOf(a: PageAction): PageSpot | undefined {
  switch (a.type) {
    case 'setField': return { kind: 'field', field: a.field, ...(a.id ? { id: a.id } : {}) };
    case 'setCell': return { kind: 'cell', headers: a.headers, row: a.row, column: a.column };
    case 'addTariffItem': return { kind: 'codeRow', codes: [a.code, ...(a.alternatives ?? [])] };
    case 'loadPharmacyExcel': return { kind: 'table', headers: a.headers };
    default: return undefined;
  }
}

/** What to do about a tariff item that is on the site but marked to check, from FillPilot's message. */
function tariffCheck(message: string, amount: number): string {
  if (/the site set the amount claimed/i.test(message)) return `The site changed the amount claimed — the bill claims ${rupees(amount)}. Check which is right.`;
  if (/the site's tariff is/i.test(message)) return `The site's rate is not the bill's — check the amount claimed is ${rupees(amount)}.`;
  if (/check it is the same item|the bill reads|reading/i.test(message)) return 'The code was hard to read — check this is the right test on the site.';
  return ADDED;
}

/** What to do about a tariff item FillPilot could not add, from its message. */
function tariffFailed(message: string): string {
  if (/is on the bill, but/i.test(message)) return 'The row is on the site, but part of it could not be typed — complete it yourself.';
  if (/no search result|not listed|does not list/i.test(message)) return 'Not found in the site\'s list — search it yourself, or add it as a non-tariff item.';
  if (/tariff types?/i.test(message) && /enter it yourself/i.test(message)) return 'The site has no tariff type for this code\'s mark — add it yourself.';
  return 'FillPilot could not add it — add it yourself on the site.';
}

/**
 * What to do about a bill line whose reading is in doubt, from the reader's note
 * (yashoda.js, tgnpdcl.js) — the note itself stays in the card's details. Null: nothing particular.
 */
function readingTodo(note: string): string | null {
  if (/Quantity read as .*, but/i.test(note)) return 'The quantity was misread — FillPilot worked it out as amount ÷ rate. Check the quantity on the bill.';
  if (/Quantity ".*" unreadable/i.test(note)) return 'The quantity could not be read — FillPilot worked it out as amount ÷ rate. Check it on the bill.';
  if (/Quantity ".*" could not be read/i.test(note)) return 'The quantity could not be read, so 1 was used — check it on the bill.';
  if (/Amount corrected from/i.test(note)) return 'The amount was misread — FillPilot used quantity × rate. Check the amount on the bill.';
  if (/Amount derived from the sub total/i.test(note)) return 'The amount could not be read — FillPilot took it from the sub total. Check it on the bill.';
  if (/, but the amount reads/i.test(note)) return 'Quantity × rate does not come to the amount — check both on the bill.';
  if (/could not be read|not readable/i.test(note)) return 'Part of this line could not be read — check it on the bill.';
  if (/entered with them/i.test(note)) return 'One of its lines had a spoilt code, so FillPilot counted it with the same item\'s other lines — check the quantity on the bill.';
  if (/may be misread/i.test(note)) return 'The code was hard to read — check it on the bill.';
  if (/check the hours/i.test(note)) return 'The site counts hours and the bill gives no days — check the hours.';
  if (/Alpha bed/i.test(note)) return 'Alpha bed — confirm it is claimed under Investigations and Procedures.';
  return null;
}
const firstTodo = (notes: string[]) => notes.map(readingTodo).find(Boolean) ?? 'Compare the quantity and the amount with the bill.';

/** The plan's action a result belongs to: results of "Next" are numbered on their own. */
function actionOf(step: PlanStep, r: ActionResult): PageAction | null {
  const a = step.actions[r.index];
  if (a && a.label === r.label) return a;
  return r.label === NEXT_ACTION.label ? NEXT_ACTION : null;
}

/** The plan's tariff action for a row — where its row will be on the site. */
const tariffAction = (step: PlanStep, code: string, tariff: string | null) =>
  step.actions.find((a): a is Extract<PageAction, { type: 'addTariffItem' }> => a.type === 'addTariffItem' && a.code === code && a.tariff === tariff);

function codeCard(step: PlanStep, i: Row & { code: string }): ReviewItem {
  const a = tariffAction(step, i.code, i.tariff);
  const alternatives = a?.alternatives ?? i.alternatives ?? [];
  return {
    key: codeKey(i.code, i.tariff),
    level: 'check',
    title: i.description,
    short: i.code,
    facts: `${i.code}${alternatives.length ? ` (or ${alternatives.join(' / ')})` : ''} · qty ${i.qty} · ${rupees(i.amountClaimed)}`,
    todo: firstTodo(i.notes),
    // Copies: the checks are put on the card's list, never on the claim's.
    why: [...i.notes],
    at: billPage(i.source),
    spot: a ? spotOf(a) : undefined,
  };
}

function wardCard(step: PlanStep, claim: TgnpdclClaim, todo: string): ReviewItem {
  const wardCell = step.actions.find((a) => a.type === 'setCell' && /Ward/.test(a.column));
  return {
    key: WARD_KEY,
    level: 'check',
    title: 'Ward Occupied',
    short: 'Ward',
    facts: claim.tabs.room.wards.map((w) => `${rupees(w.ratePerDay)}/day × ${w.days} day(s)`).join(' · '),
    todo,
    why: [],
    spot: wardCell ? spotOf(wardCell) : undefined,
  };
}

function doctorCard(step: PlanStep, claim: TgnpdclClaim, index: number, todo: string): ReviewItem {
  const d = claim.tabs.room.doctors[index];
  const cell = step.actions.find((a) => a.type === 'setCell' && a.row === index && /Doctor/.test(a.column));
  return {
    key: doctorKey(d.name),
    level: 'check',
    title: `Dr. ${d.name}`,
    facts: `${d.days} day(s) · ${rupees(d.amount)}`,
    todo,
    why: [...d.notes],
    spot: cell ? spotOf(cell) : undefined,
  };
}

/** Items of the bill FillPilot never puts on the site, and lines whose reading is in doubt — known before any fill. */
function fromBill(step: PlanStep, claim: TgnpdclClaim): ReviewItem[] {
  const { investigations, pharmacy, summary } = claim.tabs;
  const items: ReviewItem[] = [];
  if (step.key === 'investigations') {
    for (const i of investigations.items.filter(isManual)) {
      items.push({
        key: manualKey(i),
        level: 'enter',
        title: i.description,
        facts: `${i.code ? `code on the bill "${i.code}" · ` : ''}qty ${i.qty} · ${rupees(i.amountClaimed)}`,
        todo: i.code?.includes('+')
          ? 'Several codes on one line — add each part on the site yourself.'
          : 'No tariff code FillPilot could use — find this item in the site\'s list and add it.',
        why: [...i.notes],
        how: [
          { label: 'Item', value: i.description },
          ...(i.code ? [{ label: 'Code on the bill', value: i.code }] : []),
          { label: 'Quantity', value: String(i.qty) },
          { label: 'Amount claimed', value: String(i.amountClaimed) },
        ],
        at: billPage(i.source),
      });
    }
    // Filled by FillPilot, but its reading (or a rule) is in doubt: checked against the bill.
    for (const i of investigations.items) {
      if (!isManual(i) && i.code && i.review && i.notes.length) items.push(codeCard(step, { ...i, code: i.code }));
    }
    for (const i of investigations.ownItems ?? []) {
      items.push({
        key: ownKey(i),
        level: 'enter',
        title: i.description,
        facts: `hospital's own code ${i.code} · ${i.qty} × ${rupees(i.rate)} = ${rupees(i.amountClaimed)}`,
        todo: 'The hospital\'s own code is in no tariff list — add it as a non-tariff item.',
        why: [...i.notes],
        how: [
          { label: 'Item', value: i.description },
          { label: 'Quantity', value: String(i.qty) },
          ...(i.rate != null ? [{ label: 'Rate', value: String(i.rate) }] : []),
          { label: 'Amount claimed', value: String(i.amountClaimed) },
        ],
        at: billPage(i.source),
      });
    }
    if (investigations.implants) {
      items.push({
        key: 'inv|implants',
        level: 'enter',
        title: 'Implants',
        facts: rupees(investigations.implants.amount),
        todo: 'Pick the department and the implant items on the site, and upload the implant invoice.',
        why: [investigations.implants.note],
      });
    }
  }
  if (step.key === 'pharmacy' && !pharmacy.rows.length && pharmacy.note) {
    items.push({ key: 'pharmacy|none', level: 'enter', title: 'Pharmacy items', todo: pharmacy.note, why: [] });
  }
  if (step.key === 'summary') {
    if (summary.employeePaid == null) {
      items.push({ key: 'summary|paid', level: 'enter', title: 'Employee paid', todo: 'Not on the bills that were read (no summary bill) — enter it yourself.', why: [] });
    }
    if (!summary.hospitalBillNumber) {
      items.push({ key: 'summary|billno', level: 'enter', title: 'Hospital bill number', todo: 'Not on the bills that were read (no summary bill) — enter it yourself.', why: [] });
    }
  }
  return items;
}

/** A sentence from a check, for a card of its own: what it is about, and what it says. */
function ownCard(c: ClaimCheck, key: string): ReviewItem {
  const text = c.message.replace(/^(Final|Summary|Pharmacy) bill: /, '');
  const from = /^Pharmacy bill: /.test(c.message) ? 'Pharmacy bill' : 'From the bill';
  let title = from;
  let rest = text;
  if (/^No room rent/i.test(text)) title = 'Room rent';
  else if (/^Room \+ ICU/i.test(text)) title = 'Room days';
  else {
    const cut = text.indexOf(': ');
    if (cut > 0 && cut <= 60) {
      title = text.slice(0, cut);
      rest = text.slice(cut + 2);
    }
  }
  const said = (rest.charAt(0).toUpperCase() + rest.slice(1)).replace(/[.\s]*$/, '');
  const yourself = /yourself/i.test(rest);
  // Said as it is when it already says what to do; else what the reading doubt asks.
  const todo = yourself ? `${said}.` : readingTodo(rest) ?? (/check|enter|choose/i.test(said) ? `${said}.` : `${said} — check it on the bill.`);
  return { key, level: yourself ? 'enter' : 'check', title, todo, why: [c.message], ...(c.at ? { at: c.at } : {}) };
}

/**
 * The checks from reading the bill that are about this tab, on the cards of
 * the items they are about (a card is made for an item that has none yet);
 * a check about the tab as a whole is a card of its own.
 */
function placeChecks(step: PlanStep, claim: TgnpdclClaim, cards: ReviewItem[]) {
  const { room, investigations } = claim.tabs;
  const byKey = new Map(cards.map((c) => [c.key, c]));
  /** Cards whose place on the bill was set by a check: the first such check is the line in doubt. */
  const placed = new Set<string>();
  const put = (key: string, make: () => ReviewItem | null, c: ClaimCheck) => {
    let card = byKey.get(key);
    if (!card) {
      const made = make();
      if (!made) return false;
      card = made;
      cards.push(card);
      byKey.set(key, card);
    }
    // The line's own note, said with the line's name — which of the item's lines it is about.
    const said = c.message.replace(/^Final bill: /, '');
    const note = card.why.findIndex((w) => said.endsWith(w));
    if (note >= 0) card.why[note] = said;
    else if (!said.endsWith(card.todo) && !card.why.includes(said)) card.why.push(said);
    if (!placed.has(key) && c.at) {
      card.at = c.at;
      placed.add(key);
    }
    return true;
  };

  for (const c of claim.checks) {
    if (c.tab !== step.key || c.level === 'info') continue;
    const todo = readingTodo(c.message) ?? 'Check this line on the bill.';
    const item = c.item;
    let done = false;
    if (item?.list === 'items') {
      const row = investigations.items[item.index];
      if (row && isManual(row)) done = put(manualKey(row), () => null, c);
      else if (row?.code) {
        const code = row.code;
        done = put(codeKey(code, row.tariff), () => ({ ...codeCard(step, { ...row, code }), todo }), c);
      }
    } else if (item?.list === 'ownItems') {
      const row = investigations.ownItems?.[item.index];
      if (row) done = put(ownKey(row), () => null, c);
    } else if (item?.list === 'implants') {
      done = put('inv|implants', () => null, c);
    } else if (item?.list === 'pharmacy') {
      done = put('pharmacy|none', () => null, c);
    } else if (item?.list === 'wards' && room.wards[item.index]) {
      const wardTodo = /rate per day not readable/i.test(c.message)
        ? 'The rate per day could not be read — FillPilot worked it out as amount ÷ days. Check it on the bill.'
        : todo;
      done = put(WARD_KEY, () => wardCard(step, claim, wardTodo), c);
    } else if (item?.list === 'doctors' && room.doctors[item.index]) {
      const index = item.index;
      done = put(doctorKey(room.doctors[index].name), () => doctorCard(step, claim, index, todo), c);
    }
    if (!done) {
      const key = `${step.key}|bill|${c.message}`;
      put(key, () => ownCard(c, key), c);
    }
  }
}

/** What a fill of this tab left to do: failed steps, steps to check, and what the site must be checked for. */
function fromResults(step: PlanStep, claim: TgnpdclClaim, results: ActionResult[]): ReviewItem[] {
  const { room, investigations } = claim.tabs;
  const items: ReviewItem[] = [];
  const seen = new Set<string>();
  const add = (item: ReviewItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };

  for (const r of results) {
    const a = actionOf(step, r);
    if (r.ok && !r.warn) continue;

    if (a?.type === 'addTariffItem') {
      const item = investigations.items.find((i) => i.code === a.code && i.tariff === a.tariff && !i.manual);
      const description = item?.description ?? a.label;
      const key = codeKey(a.code, a.tariff);
      const facts = `${a.code}${a.alternatives?.length ? ` (or ${a.alternatives.join(' / ')})` : ''} · qty ${a.qty} · ${rupees(a.amountClaimed)}`;
      const at = billPage(item?.source);
      const notes = item?.notes ?? [];
      const short = a.code;
      if (!r.ok) {
        add({
          key, level: 'enter', title: description, short, facts, todo: tariffFailed(r.message), why: [r.message, ...notes], at, spot: r.spot,
          how: [
            { label: 'Tariff type', value: tariffName(a.tariff) },
            { label: 'Code', value: a.code },
            { label: 'Quantity', value: String(a.qty) },
            { label: 'Amount claimed', value: String(a.amountClaimed) },
          ],
        });
      } else {
        add({ key, level: 'check', title: description, short, facts, todo: tariffCheck(r.message, a.amountClaimed), why: [r.message, ...notes], at, spot: r.spot });
      }
      continue;
    }

    const title = r.label;
    const spot = r.spot ?? (a ? spotOf(a) : undefined);
    const why = [r.message];
    if (!r.ok) {
      const todo = a?.type === 'clickTab' ? 'FillPilot could not open this tab — open it on the site yourself, then press Fill again.'
        : a?.type === 'clickButton' ? 'Press Next on the site yourself.'
          : a?.type === 'ensureRows' ? 'Add the missing rows with the site\'s own Add button, then press Fill again.'
            : a?.type === 'loadPharmacyExcel' ? 'The Excel did not load — press "Download Excel" below, then the site\'s "Upload Excel" button.'
              : 'FillPilot could not type this — enter it on the site yourself.';
      const how = a?.type === 'setField' || a?.type === 'setCell' ? [{ label: title.split(' = ')[0].split(': ')[0], value: a.value }] : undefined;
      add({ key: `${step.key}|result|${r.label}`, level: 'enter', title, todo, why, spot, ...(how ? { how } : {}) });
    } else {
      const todo = a?.type === 'loadPharmacyExcel' ? 'Check the pharmacy table on the site against the bill.' : 'Check this on the site.';
      add({ key: `${step.key}|result|${r.label}`, level: 'check', title, todo, why, spot });
    }
  }

  // Room: what the bill cannot tell, checked once the tab is filled.
  if (step.key === 'room') {
    if (room.wards.length) {
      add(wardCard(step, claim, 'Check the ward chosen on the site: the bill only says "Room rent", so FillPilot picks the ward whose rate is the bill\'s.'));
    }
    room.doctors.forEach((d, i) => {
      if (!d.review) return;
      const repeated = d.notes.some((n) => /more than once/.test(n));
      add(doctorCard(step, claim, i, repeated
        ? 'This doctor is on the bill more than once — check whether the site wants one row with the days added up.'
        : 'Add the doctor\'s specialization if the site asks for it — the bill does not show it.'));
    });
  }
  return items;
}

/** One card from what the bill said about an item (bill) and what its fill left to do (fill). */
function joinCards(bill: ReviewItem, fill: ReviewItem): ReviewItem {
  const why = [...fill.why];
  for (const w of bill.why) if (!why.some((x) => x === w || w.endsWith(x))) why.push(w);
  return {
    ...bill,
    ...fill,
    level: bill.level === 'enter' || fill.level === 'enter' ? 'enter' : 'check',
    todo: fill.todo === bill.todo || fill.todo === ADDED ? bill.todo : `${fill.todo} ${bill.todo}`,
    why,
    how: fill.how ?? bill.how,
    spot: fill.spot ?? bill.spot,
    at: bill.at ?? fill.at,
    short: fill.short ?? bill.short,
    facts: fill.facts ?? bill.facts,
  };
}

/**
 * The review list of one tab: the bill's items left for the person and the
 * lines whose reading is in doubt (always), joined with what the last fill
 * left to do (once the tab has been filled). Things to enter come before
 * things to check.
 */
export function reviewFor(step: PlanStep, claim: TgnpdclClaim, results: ActionResult[] | null): ReviewItem[] {
  const bill = fromBill(step, claim);
  placeChecks(step, claim, bill);
  const fill = new Map((results ? fromResults(step, claim, results) : []).map((i) => [i.key, i]));
  const items: ReviewItem[] = [];
  for (const b of bill) {
    const f = fill.get(b.key);
    fill.delete(b.key);
    const card = f ? joinCards(b, f) : b;
    items.push({ ...card, key: `${b.key}|${card.level}${f ? '|fill' : ''}` });
  }
  for (const f of fill.values()) items.push({ ...f, key: `${f.key}|${f.level}|fill` });
  return [...items.filter((i) => i.level === 'enter'), ...items.filter((i) => i.level === 'check')];
}

/**
 * The checks for the list at the top: those about the bill as a whole, and the
 * information lines (folded there). The rest are on their tab's review list.
 */
export const billWideChecks = (claim: TgnpdclClaim) => claim.checks.filter((c) => !c.tab || c.level === 'info');

/** Ties the ticks to one bill, so another patient's bill starts with none. */
export const billKey = (claim: TgnpdclClaim) => `${claim.patient.ipNo ?? ''}|${claim.hospitalBillNumber ?? ''}|${claim.totals.billTotal}`;
