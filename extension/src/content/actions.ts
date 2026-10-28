// Multi-step form actions for site profiles (e.g. TGNPDCL bill entry):
// switch tabs, fill fields by their label, add table rows, pick tariff items,
// press Next. Everything is found by visible text (labels, headings, button
// captions), not by ids/classes the site may change.
//
// Safety: a click on anything captioned save / submit / remove / delete /
// request / print / cancel / logout is refused here, whatever the caller asks.

import type { ActionResult, PageAction, PageIdentity, PageOutline } from '../../../web/projects/shared/src/page-contract';
import { fillControl, flash, OUTLINE, setNativeValue } from './fill';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const FORBIDDEN_CLICK = /\b(save|submit|remove|delete|request|print|cancel|log\s*out|sign\s*out|upload|download)\b/i;
const CONTROL_SELECTOR = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]), select, textarea';
const CLICKABLE_SELECTOR = 'button, a, [role="tab"], [role="button"], input[type="button"], .nav-link, li';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Pace of a fill, in ms: a pause after every step, and between the parts of
 * one step (pick a search result, then quantity, then amount). Slower than the
 * page needs, so the site's own scripts and server keep up as they do for a
 * person — at full speed a site can drop a value or add a row half-done.
 */
const PACE = { step: 600, part: 200 };
const rx = (source: string) => new RegExp(source, 'i');
/** A caption pattern as words, for messages: "No\\.?\\s*of\\s*Days" → "No. of Days". */
const readable = (source: string) =>
  norm(source.replace(/\\s\*/g, ' ').replace(/\\\.\??/g, '.').replace(/\(([^|)]*)\|[^)]*\)/g, '$1').replace(/\\[a-zA-Z]|[\\^$?*+()[\]{}]/g, ''));

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeout = 5000): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(100);
  }
}

function textOf(el: Element): string {
  return norm(el instanceof HTMLInputElement ? el.value : el.textContent);
}

/** The element's own text, without the text of nested controls/blocks. */
function ownText(el: Element): string {
  let t = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    else if (n instanceof HTMLElement && /^(SPAN|STRONG|B|I|EM|SMALL|SUP|ABBR)$/.test(n.tagName)) t += n.textContent;
  }
  return norm(t);
}

/**
 * What a click on `el` would activate: its own caption and that of the button
 * or link around it — a click on the "Next" inside "Save & Next" presses the
 * whole button.
 */
function clickCaptions(el: Element): string[] {
  const owner = el.closest('button, a, [role="button"], [role="tab"], input[type="button"], input[type="submit"]');
  return owner && owner !== el ? [textOf(el), textOf(owner)] : [textOf(el)];
}

const isForbidden = (el: Element) => clickCaptions(el).some((c) => FORBIDDEN_CLICK.test(c));

function safeClick(el: HTMLElement): void {
  const caption = clickCaptions(el).find((c) => FORBIDDEN_CLICK.test(c));
  if (caption) throw new Error(`Refused to click "${caption}" — the extension never saves, submits or removes.`);
  // Only as far as needed to bring it on screen — the page should not jump about while filling.
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.click();
}

const isInteractive = (el: Element) => el.matches('button, a, [role="tab"], [role="button"], input');

/**
 * The deepest visible elements whose whole text matches. Sites build tabs and
 * buttons from plain <div>/<span> too; a click on the innermost element
 * bubbles to whichever ancestor carries the handler.
 */
function textLeaves(r: RegExp, maxLength = 80): HTMLElement[] {
  const hits = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((el) => {
    if (el.matches('script, style, noscript, option, select, textarea, input')) return false;
    if ((el.textContent || '').length > maxLength * 4) return false;
    const t = textOf(el);
    return t.length > 0 && t.length <= maxLength && r.test(t) && isVisible(el);
  });
  return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
}

const hasPointer = (el: Element) => getComputedStyle(el).cursor === 'pointer';

function findClickable(pattern: string, scope: ParentNode = document): HTMLElement | null {
  const r = rx(pattern);
  const found = Array.from(scope.querySelectorAll<HTMLElement>(CLICKABLE_SELECTOR))
    .filter((el) => isVisible(el) && r.test(textOf(el)) && !isForbidden(el))
    // Real buttons/links first (an <li> often only wraps the <a> that has the handler), then the tightest text.
    .sort((a, b) => Number(isInteractive(b)) - Number(isInteractive(a)) || textOf(a).length - textOf(b).length);
  if (found[0]) return found[0];
  // A "button" made of a styled <div>/<span>: accepted only when the page marks it clickable.
  if (scope !== document) return null;
  return textLeaves(r, 60).find((el) => hasPointer(el) && !isForbidden(el)) || null;
}

const TAB_CLASS = /(^|[\s_-])(tabs?|steps?|stepper|wizard|nav)([\s_-]|$)/i;

/** How much an element looks like a wizard tab rather than a heading with the same words. */
function tabScore(el: HTMLElement): number {
  let score = 0;
  if (hasPointer(el)) score += 2;
  if (el.closest('[role="tab"], [role="tablist"], button, a, li')) score += 2;
  let numbered = false;
  let tabClass = false;
  for (let node: Element | null = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const text = textOf(node);
    if (text.length > 80) break;
    if (/^\d\s*[.)]?\s*\D/.test(text)) numbered = true;
    if (typeof node.className === 'string' && TAB_CLASS.test(node.className)) tabClass = true;
  }
  return score + (numbered ? 1 : 0) + (tabClass ? 1 : 0);
}

function findTab(pattern: string): HTMLElement | null {
  const ranked = textLeaves(rx(pattern), 60)
    .filter((el) => !isForbidden(el))
    .map((el) => ({ el, score: tabScore(el) }))
    .filter((c) => c.score > 0)
    // Best-looking tab; on a tie the first in the page (the tab strip sits above the content).
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.el || null;
}

/** A control the site will not let anyone type into. */
const isLocked = (c: Control) => c.disabled || (!(c instanceof HTMLSelectElement) && c.readOnly);

/** First visible control after `anchor` inside its ancestor `levels` up. */
function controlAfter(anchor: Element, levels: number, locked = false): Control | null {
  let container: Element | null = anchor;
  for (let i = 0; i < levels && container; i++) container = container.parentElement;
  if (!container) return null;
  for (const c of Array.from(container.querySelectorAll<Control>(CONTROL_SELECTOR))) {
    if (!isVisible(c) || isLocked(c) !== locked) continue;
    if (anchor.contains(c) || anchor.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) return c;
  }
  return null;
}

/**
 * The control a label describes: <label for>, a wrapping <label>, or the first
 * control after label-like text — preferring the tightest container, so read-only
 * text such as "Hospital bill number ICO…" in a summary table never captures
 * an unrelated input further down. `locked` looks for a disabled / read-only
 * control instead, to tell "the site locked it" from "it is not on this page".
 */
function findField(pattern: string, locked = false): Control | null {
  const r = rx(pattern);
  for (const label of Array.from(document.querySelectorAll('label'))) {
    if (!isVisible(label) || !r.test(norm(label.textContent))) continue;
    const c = (label.control as Control | null) || label.querySelector<Control>(CONTROL_SELECTOR) || controlAfter(label, 1, locked);
    if (c && isVisible(c) && isLocked(c) === locked) return c;
  }
  const byPlaceholder = Array.from(document.querySelectorAll<Control>(CONTROL_SELECTOR))
    .find((c) => isVisible(c) && isLocked(c) === locked && r.test(c.getAttribute('placeholder') || '') );
  if (byPlaceholder) return byPlaceholder;

  const texts = Array.from(document.querySelectorAll('span, div, p, td, th, strong, b, h5, h6, small, dt'))
    .filter((el) => isVisible(el) && ownText(el).length < 80 && r.test(ownText(el)));
  for (let level = 1; level <= 3; level++) {
    for (const el of texts) {
      const c = controlAfter(el, level, locked);
      if (c) return c;
    }
  }
  return null;
}

/** The visible control with this id. */
function fieldById(id: string): Control | null {
  const el = document.getElementById(id);
  return (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && isVisible(el) ? el : null;
}

interface FoundTable {
  table: HTMLTableElement;
  headers: string[];
}

function findTable(headers: string[]): FoundTable | null {
  const patterns = headers.map(rx);
  for (const table of Array.from(document.querySelectorAll('table'))) {
    if (!isVisible(table)) continue;
    const headRow = table.tHead?.rows[0] ?? table.rows[0];
    if (!headRow) continue;
    const texts = Array.from(headRow.cells).map((c) => norm(c.textContent));
    if (patterns.every((p) => texts.some((t) => p.test(t)))) return { table, headers: texts };
  }
  return null;
}

function dataRows(t: FoundTable): HTMLTableRowElement[] {
  return Array.from(t.table.tBodies).flatMap((b) => Array.from(b.rows)).filter((r) => r.querySelector(CONTROL_SELECTOR));
}

function cellControl(t: FoundTable, row: HTMLTableRowElement, column: string): Control | null {
  const idx = t.headers.findIndex((h) => rx(column).test(h));
  if (idx < 0) return null;
  return row.cells[idx]?.querySelector<Control>(CONTROL_SELECTOR) ?? null;
}

function setValue(control: Control, value: string, optionMatch?: string): string | null {
  let v = value;
  if (control instanceof HTMLSelectElement) {
    const options = Array.from(control.options).filter((o) => o.value !== '');
    const byPattern = optionMatch ? options.find((o) => rx(optionMatch).test(o.text.replace(/,/g, ''))) : null;
    const exact = options.find((o) => o.value === value || norm(o.text).toLowerCase() === value.toLowerCase());
    const hit = byPattern || exact;
    if (!hit) return `None of the site's options fits (${options.map((o) => norm(o.text)).slice(0, 8).join(' / ')}) — choose it yourself`;
    v = hit.value;
  }
  const error = fillControl(control, v);
  flash(control, error ? OUTLINE.failed : OUTLINE.filled, 2500);
  return error;
}

// ------------------------------------------------------------- actions

/** A structural problem — the rest of the step cannot work, so it stops here. */
class StepStopped extends Error {}

const isMarkedActive = (el: Element) =>
  /(^|\s)(active|selected|current)(\s|$)/i.test(typeof el.className === 'string' ? el.className : '') || el.getAttribute('aria-selected') === 'true';

interface TabPosition {
  open: number;
  wanted: number;
  openCaption: string;
}

/**
 * Where the open tab and this tab sit in the strip — null when the strip does
 * not mark its open tab (no "active" class or aria-selected on any tab).
 */
function tabPosition(tab: HTMLElement): TabPosition | null {
  for (const el of [tab, tab.parentElement]) {
    const strip = el?.parentElement ? Array.from(el.parentElement.children) : [];
    const open = strip.findIndex(isMarkedActive);
    if (el && open >= 0) return { open, wanted: strip.indexOf(el), openCaption: textOf(strip[open]) };
  }
  return null;
}

const TAB_NOT_OPENED = 'This tab could not be opened automatically — open it on the site yourself; filling continues on the tab that is showing';

/**
 * Opens a wizard tab. Real tabs open on a click. A step indicator that only
 * looks like tabs does not — then the site's own Next button is pressed until
 * the tab is reached (`next` is that button's caption pattern). Going
 * backwards is left to the person.
 */
async function clickTab(pattern: string, next?: string): Promise<string> {
  const tab = await waitFor(() => findTab(pattern), 2000);
  if (!tab) throw new Error(TAB_NOT_OPENED);
  const caption = textOf(tab);
  const position = () => tabPosition(findTab(pattern) ?? tab);
  let at = position();
  if (at && at.open === at.wanted) return `"${caption}" is open`;

  safeClick(tab);
  await sleep(400);
  const clicked = await waitFor(() => {
    const p = position();
    return !p || p.open === p.wanted;
  }, 1200);
  if (clicked) return `Opened "${caption}"`;

  at = position();
  if (!at || !next) throw new Error(TAB_NOT_OPENED);
  if (at.wanted < at.open) throw new Error(`The site is on "${at.openCaption}" — go Back on the site to "${caption}", then press Fill again`);
  while (at.open < at.wanted) {
    const button = findClickable(next);
    if (!button) throw new Error(`"${at.openCaption}" has no Next button — open "${caption}" on the site yourself`);
    const from: number = at.open;
    safeClick(button);
    const moved: TabPosition | null = await waitFor(() => {
      const p = position();
      return p && p.open !== from ? p : null;
    }, 4000);
    if (!moved) throw new Error(`The site stayed on "${at.openCaption}" after Next — it may need something on that tab first. Then press Fill again`);
    at = moved;
    await sleep(300);
  }
  if (at.open !== at.wanted) throw new Error(TAB_NOT_OPENED);
  return `Opened "${caption}" with Next`;
}

async function clickButton(pattern: string): Promise<string> {
  const button = await waitFor(() => findClickable(pattern), 3000);
  if (!button) throw new Error('Button not found on the page');
  safeClick(button);
  await sleep(500);
  return `Clicked "${textOf(button)}"`;
}

async function setField(field: string, value: string, id?: string, calendar = false): Promise<string> {
  const byId = () => (id ? fieldById(id) : null);
  const control = await waitFor(() => {
    const c = byId();
    return c && !isLocked(c) ? c : findField(field);
  }, 3000);
  if (!control) {
    const locked = byId() || findField(field, true);
    // A date box the site locks for typing because its calendar fills it: the
    // value is written as the calendar writes it. A disabled box is never sent with the form — left alone.
    if (locked && calendar && !locked.disabled && !(locked instanceof HTMLSelectElement)) {
      setNativeValue(locked, value);
      locked.dispatchEvent(new Event('input', { bubbles: true }));
      locked.dispatchEvent(new Event('change', { bubbles: true }));
      const ok = locked.value === value;
      flash(locked, ok ? OUTLINE.filled : OUTLINE.failed, 2500);
      if (!ok) throw new Error(`the site changed "${readable(field)}" to "${locked.value}"`);
      return `${readable(field)} = ${value} (calendar box)`;
    }
    if (locked) throw new Error(`"${readable(field)}" is locked on the site — it cannot be typed into right now`);
    throw new Error(`Field "${readable(field)}" not found on the page — is the right tab open?`);
  }
  const error = setValue(control, value);
  if (error) throw new Error(error);
  return `${readable(field)} = ${value}`;
}

async function ensureRows(headers: string[], count: number, addButton?: string): Promise<string> {
  const t = await waitFor(() => findTable(headers), 3000);
  if (!t) throw new Error(`Table with columns ${headers.map(readable).join(', ')} not found`);
  let rows = dataRows(t).length;
  while (rows < count) {
    if (!addButton) throw new Error(`Table has ${rows} row(s), ${count} needed, and no add button is configured`);
    const button = findClickable(addButton);
    if (!button) throw new Error(`Table has ${rows} row(s), ${count} needed — "${readable(addButton)}" button not found`);
    safeClick(button);
    const grew = await waitFor(() => dataRows(findTable(headers) || t).length > rows, 3000);
    if (!grew) throw new Error(`Clicking "${textOf(button)}" did not add a row`);
    rows = dataRows(findTable(headers) || t).length;
    await sleep(PACE.part);
  }
  return rows > count ? `${rows} rows present (${count} needed — extra rows left as they are)` : `${rows} row(s) ready`;
}

async function setCell(headers: string[], rowIndex: number, column: string, value: string, optionMatch?: string): Promise<string> {
  const t = findTable(headers);
  if (!t) throw new Error(`Table with columns ${headers.map(readable).join(', ')} not found`);
  const row = dataRows(t)[rowIndex];
  if (!row) throw new Error(`Row ${rowIndex + 1} not found`);
  const control = cellControl(t, row, column);
  if (!control) throw new Error(`Column "${readable(column)}" has no input in row ${rowIndex + 1}`);
  const error = setValue(control, value, optionMatch);
  if (error) throw new Error(error);
  return `Row ${rowIndex + 1}: ${value}`;
}

// ------------------------------------------- tariff items (Investigations)

interface BillRow {
  t: FoundTable;
  row: HTMLTableRowElement;
}

const SEARCH_BOX = 'Search.{0,24}(tariff|code|description|item|procedure|investigation)|(tariff|code).{0,16}search';
const ADD_BUTTON = '^\\+?\\s*Add(\\s*(item|row|to\\s*bill|from\\s*tariff))?\\s*$';

/**
 * A search result naming `code`: its text starts with the code as a whole
 * token, as the site prints it ("82A – C-Reactive Protein - CRP (₹750)").
 * "586" is not found in "1,586.00" or "5860", and a short code such as "23"
 * never matches another item's price "(₹23)" — that item would be added instead.
 */
function codeToken(code: string): RegExp {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}($|[^A-Za-z0-9.])`, 'i');
}

/** Tables of entered items: those with a "Code" column and rows that have inputs. */
function billTables(): FoundTable[] {
  return Array.from(document.querySelectorAll('table'))
    .filter(isVisible)
    .map((table) => ({ table, headers: Array.from((table.tHead?.rows[0] ?? table.rows[0])?.cells ?? []).map((c) => norm(c.textContent)) }))
    .filter((t) => t.headers.some((h) => /code/i.test(h)));
}

/**
 * The row already entered for `code`. Only the Code column is compared — a
 * quantity or an amount that happens to equal the code must never match.
 */
function rowWithCode(code: string): BillRow | null {
  const want = code.toUpperCase();
  for (const t of billTables()) {
    const idx = t.headers.findIndex((h) => /code/i.test(h));
    for (const row of dataRows(t)) {
      const cell = row.cells[idx];
      const control = cell?.querySelector<Control>(CONTROL_SELECTOR);
      if (norm(control ? control.value : cell?.textContent).toUpperCase() === want) return { t, row };
    }
  }
  return null;
}

const inEnteredRow = (el: Element) => Boolean(el.closest('tr')?.querySelector(CONTROL_SELECTOR));

/**
 * The search result to press for `code`: the innermost element naming the
 * code, outside the rows already entered. It must be something the page added
 * after typing, or sit in the search box's own block — a matching number
 * elsewhere on the page is not a result. Code-first, tightest text first.
 */
function findTariffResult(code: string, appeared: HTMLElement[], search: Element): HTMLElement | null {
  const r = codeToken(code);
  const fresh = appeared.filter((el) => el.isConnected);
  const isFresh = (el: Element) => fresh.some((root) => root.contains(el));
  const rank = (el: HTMLElement) => {
    const t = textOf(el).toUpperCase();
    return (isFresh(el) ? 0 : 3) + (t === code.toUpperCase() ? 0 : t.startsWith(code.toUpperCase()) ? 1 : 2);
  };
  const candidates = textLeaves(r, 250)
    .filter((el) => !inEnteredRow(el) && !isForbidden(el) && !el.closest('label, h1, h2, h3, h4, h5, h6, th'))
    .filter((el) => isFresh(el) || near(search, el, 5))
    .sort((a, b) => rank(a) - rank(b) || textOf(a).length - textOf(b).length);
  return candidates[0] || null;
}

/** Press like a person does — lists that pick on mousedown ignore a bare click(). */
function press(el: HTMLElement): void {
  const caption = clickCaptions(el).find((c) => FORBIDDEN_CLICK.test(c));
  if (caption) throw new Error(`Refused to click "${caption}" — the extension never saves, submits or removes.`);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const init = { bubbles: true, cancelable: true };
  if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.click();
}

/** `el` sits in the same block as `anchor` (within `levels` ancestors of it). */
function near(anchor: Element, el: Element, levels = 4): boolean {
  let container: Element | null = anchor;
  for (let i = 0; i < levels && container?.parentElement; i++) container = container.parentElement;
  return Boolean(container?.contains(el));
}

/** Results offered natively: a <datalist> on the search box, or a <select> beside it listing tariff items. */
function pickNative(code: string, search: HTMLInputElement, typeSelect: Control | null): string | null {
  const r = codeToken(code);
  const option = search.list ? Array.from(search.list.options).find((o) => r.test(o.value) || r.test(o.text)) : null;
  if (option) {
    typeInto(search, option.value);
    search.dispatchEvent(new Event('change', { bubbles: true }));
    return option.value;
  }
  for (const select of Array.from(document.querySelectorAll('select'))) {
    if (select === typeSelect || !isVisible(select) || select.disabled || inEnteredRow(select) || !near(search, select)) continue;
    const o = Array.from(select.options).find((x) => x.value !== '' && r.test(x.text));
    if (o && !fillControl(select, o.value)) return norm(o.text);
  }
  return null;
}

/**
 * The price on a search result's line ("82A – C-Reactive Protein - CRP (₹750)"),
 * or null when the line shows none. Only the result's own line is read — never a
 * block that also holds other results' prices.
 */
function resultPrice(hit: HTMLElement, code: string): number | null {
  const parent = hit.parentElement;
  const line = hit.closest<HTMLElement>('tr, li, [role="option"], .list-group-item, .dropdown-item')
    ?? (parent && textOf(parent).length <= 200 && codeToken(code).test(textOf(parent)) ? parent : hit);
  const m = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i.exec(textOf(line));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** What the page added after typing — tells how this site shows its search results. */
function describeAppeared(appeared: HTMLElement[]): string {
  const live = appeared.filter((el) => el.isConnected && isVisible(el) && textOf(el));
  const roots = live.filter((el) => !live.some((o) => o !== el && o.contains(el))).slice(0, 3);
  if (!roots.length) return 'nothing appeared on the page after typing the code';
  return `after typing the page showed: ${roots.map((el) => `[${domPath(el).split(' < ').slice(0, 3).join(' < ')}] "${textOf(el).slice(0, 70)}"`).join(' | ')}`;
}

/** Types into a search box and keeps focus there — many result lists close on blur. */
function typeInto(control: HTMLInputElement, value: string): void {
  control.focus({ preventScroll: true });
  setNativeValue(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || 'Backspace' }));
}

/**
 * Adds the tariff item `code` to the bill (unless its row is there already)
 * and sets quantity and the amount the hospital claimed. The tariff type is
 * never guessed: the same code is a different item in another tariff, so only
 * the site's type that `option` names is searched (the site profile maps the
 * bill's tariff mark to it). The site's own rate for the item is compared
 * with the bill — many differences mean the wrong tariff type is mapped.
 *
 * `alternatives` are other readings of the code where OCR cannot tell I from 1
 * (78I / 781). Both may be real items, so the bill's rate decides: the reading
 * whose price on the site is the bill's rate is added. When no price settles it,
 * the bill's reading is kept (or the one the site has) and the step is marked
 * for the person to check.
 */
async function addTariffItem(code: string, tariff: string | null, qty: number, amountClaimed: number, option?: string | null, alternatives: string[] = []): Promise<{ message: string; warn: boolean }> {
  const readings = [code, ...alternatives.filter((c) => c.toUpperCase() !== code.toUpperCase())];
  /** The reading that went on the bill, and why it needs checking when that is not certain. */
  let used = code;
  let doubt = '';
  let found: BillRow | null = null;
  for (const c of readings) {
    found = rowWithCode(c);
    if (found) {
      used = c;
      if (c !== code) doubt = `the bill reads ${code}; ${c} is already on the site's bill — check it is the same item`;
      break;
    }
  }
  let via = 'already on the bill';

  if (!found) {
    const search = await waitFor(() => findField(SEARCH_BOX), 3000);
    if (!(search instanceof HTMLInputElement)) {
      throw new StepStopped('Tariff search box not found — open the "2. Investigations and Procedures" tab on the site, then press Fill again');
    }
    const typeSelect = findField('Tariff\\s*Type');
    if (!(typeSelect instanceof HTMLSelectElement)) {
      // Without the tariff type the search could add the same code from another tariff.
      throw new StepStopped('The "Tariff Type" box was not recognised on this page, so nothing was added (the page layout has been saved for the developer)');
    }
    const options = Array.from(typeSelect.options).filter((o) => o.value !== '');
    const wanted = option ? options.find((o) => rx(option).test(norm(o.text))) : null;
    if (!wanted) {
      const types = options.map((o) => norm(o.text)).join(' / ');
      throw new Error(option
        ? `The bill marks this code "${tariff}", but none of the site's tariff types (${types}) matches the one expected for it (${readable(option)}) — enter it yourself`
        : `The bill marks this code "${tariff ?? 'no tariff'}" and it is not known which of the site's tariff types that is (${types}) — enter it yourself`);
    }
    const switched = typeSelect.value !== wanted.value;
    if (switched) {
      fillControl(typeSelect, wanted.value);
      await sleep(700);
    }
    via = norm(wanted.text);

    const appeared: HTMLElement[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of Array.from(record.addedNodes)) if (node instanceof HTMLElement) appeared.push(node);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let failure = '';
    try {
      // After a change of tariff type the site first loads that tariff's list —
      // the code is typed again until the list is there to be filtered.
      const look = async (tries: number, c = code): Promise<HTMLElement | null> => {
        for (let attempt = 0; attempt < tries; attempt++) {
          if (attempt) typeInto(search, '');
          typeInto(search, c);
          const result = await waitFor(() => findTariffResult(c, appeared, search), 3000);
          if (result) return result;
        }
        return null;
      };
      let hit = await look(switched ? 4 : 1);
      // Nothing found: choose the type again, as a person would, so the list
      // reloads, and search once more. The site shows the same text ("No tariff
      // items. Select a tariff type above to load.") for a list that is not
      // loaded and for a code that is not in it (690A in EHS Ax-V), so a
      // second look is the only way to tell them apart.
      if (!hit && !switched) {
        if (Array.from(typeSelect.options).some((o) => o.value === '')) {
          fillControl(typeSelect, '');
          await sleep(300);
        }
        fillControl(typeSelect, wanted.value);
        await sleep(700);
        hit = await look(4);
      }
      if (readings.length > 1) {
        // 78I or 781: the reading whose price on the site is the bill's rate.
        const rate = qty ? Math.round((amountClaimed / qty) * 100) / 100 : null;
        const fits = (price: number | null) => price != null && rate != null && Math.abs(price - rate) <= 0.5;
        const seen: { c: string; price: number | null }[] = hit ? [{ c: code, price: resultPrice(hit, code) }] : [];
        let typedOther = false;
        for (const alt of readings.slice(1)) {
          if (seen.some((s) => fits(s.price))) break;
          typedOther = true;
          const altHit = await look(2, alt);
          if (altHit) seen.push({ c: alt, price: resultPrice(altHit, alt) });
        }
        const choice = seen.find((s) => fits(s.price)) ?? seen[0];
        if (choice) {
          used = choice.c;
          const price = (s: { c: string; price: number | null }) => `${s.c}${s.price != null ? ` is ₹${s.price}` : ''}`;
          const others = seen.filter((s) => s !== choice);
          const absent = readings.filter((c) => !seen.some((s) => s.c === c));
          if (fits(choice.price)) {
            if (used !== code) {
              doubt = `the bill reads ${code}, but ${price(choice)} — the bill's rate (${others.length ? others.map(price).join(', ') : `${code} is not in ${via}`}) — check the code on the bill`;
            }
          } else if (others.length) {
            doubt = `the bill reads ${code}; OCR cannot tell I from 1 here and the site's prices do not settle it (${seen.map(price).join(', ')}, the bill's rate is ₹${rate}) — ${used} was added, check it is the right item`;
          } else if (used !== code) {
            doubt = `the bill reads ${code}, which is not in ${via}${absent.length > 1 ? ` (nor ${absent.filter((c) => c !== code).join(', ')})` : ''}; ${used} was added — check it is the right item`;
          }
          // Typing another reading replaced the result list: search the chosen one again.
          if (typedOther) hit = await look(2, used);
        }
      }
      let picked: string | null = null;
      if (!hit) {
        for (const c of readings) {
          picked = pickNative(c, search, typeSelect);
          if (picked) {
            used = c;
            if (c !== code) doubt = `the bill reads ${code}, which is not in ${via}; ${c} was chosen — check it is the right item`;
            break;
          }
        }
      }
      if (hit) {
        await sleep(PACE.part);
        press(hit);
      }
      if (hit || picked) {
        found = await waitFor(() => rowWithCode(used), 2500);
        if (!found) {
          // A result line with its own "Add" button — only the one on that line, never
          // another result's. After a native choice the form may wait for its "Add".
          const line = hit ? hit.closest<HTMLElement>('tr, li, [role="option"], .list-group-item, .dropdown-item') : null;
          const buttons = Array.from((hit ? line ?? hit : document).querySelectorAll<HTMLElement>('button, a, [role="button"], input[type="button"]'))
            .filter((b) => isVisible(b) && !isForbidden(b) && !inEnteredRow(b));
          const add = hit
            ? buttons.find((b) => /^\+?\s*(add|select|choose)\b/i.test(textOf(b)))
            : buttons.find((b) => near(search, b) && rx(ADD_BUTTON).test(textOf(b)));
          if (add) {
            safeClick(add);
            found = await waitFor(() => rowWithCode(used), 2500);
          }
        }
        if (!found) {
          const tables = billTables().map((t) => `[${t.headers.join(' | ')}] ${dataRows(t).length} row(s)`).join('; ') || 'no table with a Code column';
          failure = `chose "${(hit ? textOf(hit) : picked || '').slice(0, 70)}" but no row with code ${used} appeared (tables: ${tables})`;
        }
      } else {
        failure = `no search result for ${readings.join(' or ')} in ${via} — ${describeAppeared(appeared)}`;
      }
    } finally {
      observer.disconnect();
      typeInto(search, '');
    }
    if (!found) throw new Error(failure);
  }

  const problems: string[] = [];
  await sleep(PACE.part);
  const qtyControl = cellControl(found.t, found.row, 'Qty|Quantity');
  if (qtyControl && !isLocked(qtyControl)) {
    const e = setValue(qtyControl, String(qty));
    if (e) problems.push(`quantity: ${e}`);
  } else if (qty !== 1) problems.push(`quantity ${qty} could not be typed (column locked or missing)`);
  await sleep(PACE.part);
  const amountControl = cellControl(found.t, found.row, 'claimed');
  /** The site's own figure, when it would not keep the bill's (it caps the claim at its tariff). */
  let siteAmount: number | null = null;
  if (amountControl && !isLocked(amountControl)) {
    const e = setValue(amountControl, String(amountClaimed));
    const kept = amountControl.value.trim() ? Number(amountControl.value) : NaN;
    if (e && Number.isFinite(kept)) {
      // The row is on the bill and the amount is the site's decision — for the person to check, not a failure.
      siteAmount = kept;
      flash(amountControl, OUTLINE.focus, 2500);
    } else if (e) problems.push(`amount: ${e}`);
  } else problems.push(`the "claimed by hospital" amount could not be typed (columns: ${found.t.headers.join(' | ')})`);
  if (problems.length) throw new Error(`${doubt ? `${doubt}. ` : ''}${used} is on the bill, but ${problems.join('; ')}`);

  const rate = Number(cellControl(found.t, found.row, 'rate')?.value);
  const differs = Number.isFinite(rate) && rate > 0 && Math.abs(rate * qty - amountClaimed) > 0.5;
  const siteTariff = differs ? `the site's tariff is ${rate} × ${qty} = ${Math.round(rate * qty * 100) / 100}` : '';
  const withDoubt = (message: string) => (doubt ? `${used}: ${doubt}. ${message}` : message);
  if (siteAmount != null) {
    return { message: withDoubt(`the site set the amount claimed to ${siteAmount}, the bill claims ${amountClaimed}${siteTariff ? ` — ${siteTariff}` : ''} (${via})`), warn: true };
  }
  return {
    message: withDoubt(differs ? `${siteTariff}, the bill claims ${amountClaimed} (${via})` : `${used} (${via}) qty ${qty}, claimed ${amountClaimed}`),
    warn: differs || Boolean(doubt),
  };
}

// ------------------------------------- PM-JAY Treatment Plan (procedures)

const PROCEDURE_LABEL = '^\\s*Procedure\\s*:?\\s*$';
const UNITS_LABEL = 'No\\.?\\s*of\\s*Days\\s*\\/?\\s*Units';
const ICHI_LABEL = '^\\s*ICHI\\s*Code\\s*:?\\s*$';
const PROBLEM_TEXT = '.invalid-feedback, .text-danger, .error, .error-message, [role="alert"], .toast, .alert, mat-error, .swal2-popup, .ng-invalid ~ small';

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The site lists procedures as "Haemodialysis(NU116-None)": the entry ends with (code-stratification). */
const procedureEntry = (code: string) => new RegExp(`\\(\\s*${escapeRx(code)}\\s*-[^()]*\\)\\s*$`, 'i');

/** The visible element whose own text is this form label — never a table heading with the same word. */
function formLabel(pattern: string): HTMLElement | null {
  const r = rx(pattern);
  return Array.from(document.querySelectorAll<HTMLElement>('label, span, div, p, td, strong, b, h5, h6, dt'))
    .find((el) => isVisible(el) && !el.closest('th, thead') && r.test(ownText(el))) ?? null;
}

/** area: the block the dropdown was found in — where the chosen entry shows once picked. */
type Widget = { kind: 'select'; el: HTMLSelectElement } | { kind: 'combo'; box: HTMLElement; input: HTMLInputElement | null; area: Element };

const CUSTOM_DROPDOWN = '[role="combobox"], ng-select, .ng-select, .p-dropdown, mat-select, [class*="select" i], [class*="dropdown" i]';

/**
 * The dropdown a label stands for: a native <select>, or a custom one (ng-select,
 * PrimeNG, Material…) — its outer box and the input it searches with, if any.
 * The first one after the label in its block, looking a few levels up.
 */
function dropdownAfter(label: HTMLElement): Widget | null {
  const follows = (el: Element) => !label.contains(el) && Boolean(label.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  let container: Element | null = label;
  for (let level = 1; level <= 4 && container; level++) {
    container = container.parentElement;
    if (!container) break;
    const first = Array.from(container.querySelectorAll<HTMLElement>(`select, ${CUSTOM_DROPDOWN}`)).find((el) => follows(el) && isVisible(el));
    if (!first) continue;
    if (first instanceof HTMLSelectElement) return { kind: 'select', el: first };
    // A styled box over a real <select> (select2 and the like): the <select> is what the page reads.
    const native = first.querySelector('select');
    if (native) return { kind: 'select', el: native };
    let box = first;
    for (let up = first.parentElement; up && up !== container && up.matches(CUSTOM_DROPDOWN); up = up.parentElement) box = up;
    // react-select: the element found is the search input itself.
    const input = box instanceof HTMLInputElement ? box : box.querySelector<HTMLInputElement>('input:not([type=hidden])');
    return { kind: 'combo', box, input, area: container };
  }
  return null;
}

/** The first visible control after `anchor` in its block — locked or not, so a locked box is never skipped for the next one. */
function controlNextTo(anchor: Element, levels: number): Control | null {
  let container: Element | null = anchor;
  for (let i = 0; i < levels && container; i++) container = container.parentElement;
  if (!container) return null;
  return Array.from(container.querySelectorAll<Control>(CONTROL_SELECTOR))
    .find((c) => isVisible(c) && !anchor.contains(c) && Boolean(anchor.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? null;
}

/** Opens a custom dropdown the way a person does: a press on its visible text, which the box's own handlers hear. */
function openDropdown(box: HTMLElement): void {
  box.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = box.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), r.top + r.height / 2);
  press(at instanceof HTMLElement && box.contains(at) ? at : box);
}

/** The Treatment Plan table: the one with "Procedure" and "Days/Units" columns. */
function treatmentTable(): { table: HTMLTableElement; procedureColumn: number } | null {
  for (const table of Array.from(document.querySelectorAll('table'))) {
    if (!isVisible(table)) continue;
    const headers = Array.from((table.tHead?.rows[0] ?? table.rows[0])?.cells ?? []).map((c) => norm(c.textContent));
    const procedureColumn = headers.findIndex((h) => /^procedure$/i.test(h));
    if (procedureColumn >= 0 && headers.some((h) => /days\s*\/\s*units/i.test(h))) return { table, procedureColumn };
  }
  return null;
}

const treatmentRows = (t: { table: HTMLTableElement }) => Array.from(t.table.tBodies).flatMap((b) => Array.from(b.rows)).filter((r) => r.cells.length > 1);

/**
 * A table row that looks like this entry. The site shows only the first ~15
 * characters of a long name ("Haemodialysis /...Show More"), so a shortened
 * name that matches may still be a different procedure — exact: false.
 */
function rowLike(name: string): { shown: string; exact: boolean } | null {
  const t = treatmentTable();
  if (!t) return null;
  const wanted = norm(name).toLowerCase();
  for (const row of treatmentRows(t)) {
    const raw = norm(row.cells[t.procedureColumn]?.textContent);
    const shortened = /show\s*more\s*$/i.test(raw);
    const shown = raw.replace(/\.{2,}\s*show\s*more\s*$/i, '').replace(/[\s/(]+$/, '').toLowerCase();
    if (!shortened && shown === wanted) return { shown, exact: true };
    if (shortened && shown.length >= 4 && wanted.startsWith(shown)) return { shown, exact: false };
  }
  return null;
}

/** Not added because the table seems to have it — always shown to the person, never a quiet tick. */
function skippedAsPresent(code: string, like: { shown: string; exact: boolean }) {
  return {
    message: like.exact
      ? `${code} is already in the Treatment Plan — not added again`
      : `a row starting "${like.shown}…" is already in the Treatment Plan — it may be ${code}, so it was not added; check the table`,
    warn: true,
    skipped: true,
  };
}

/** Messages the site shows next to fields or as a pop-up — why "+" did not add a row. */
function problemsShown(): string {
  return Array.from(document.querySelectorAll<HTMLElement>(PROBLEM_TEXT))
    .filter((el) => isVisible(el) && textOf(el))
    .map((el) => textOf(el).slice(0, 120))
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 3)
    .join(' | ');
}

/**
 * The "+" that adds the treatment: the icon in the ICHI Code row after the ICHI
 * field, in its own column (PM-JAY draws it as a bare icon — no caption, and
 * hashed class names that say nothing). Outside the table, never in a dropdown.
 */
function addRowButton(): Element | null {
  const label = formLabel(ICHI_LABEL) ?? formLabel(UNITS_LABEL);
  if (!label) return null;
  const follows = (a: Node, el: Element) => !a.contains(el) && Boolean(a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  // The row: the nearest block around the label that also holds its field.
  let row: Element | null = label;
  let field: Element | undefined;
  for (let level = 1; level <= 4 && row && !field; level++) {
    row = row.parentElement;
    field = row ? Array.from(row.querySelectorAll('input:not([type=hidden]), select, textarea, [role="combobox"]')).find((el) => follows(label, el)) : undefined;
  }
  if (!row || !field) return null;
  // The field's own column (a dropdown's arrow lives there) is not the "+".
  let fieldCell: Element = field;
  while (fieldCell.parentElement && fieldCell.parentElement !== row) fieldCell = fieldCell.parentElement;
  const caption = (el: Element) => textOf(el);
  const candidates = Array.from(row.querySelectorAll<Element>('button, [role="button"], a, svg, img, i, span, div'))
    .filter((el) => follows(field!, el) && !fieldCell.contains(el) && isVisible(el) && !el.closest('table') && !isForbidden(el))
    .filter((el) => /^(\+|add(_circle(_outline)?|_box)?)?$/i.test(caption(el)))
    .filter((el) => el.matches('button, [role="button"], a, svg, img, i') || (el instanceof HTMLElement && hasPointer(el)));
  // Its markup says plus / add as a word ("fa-plus", "btn-add" — not "padding"), else a real button, else the first icon.
  return candidates.find((el) => /\b(plus|add)\b/i.test(el.outerHTML.slice(0, 400)))
    ?? candidates.find((el) => el.matches('button, [role="button"], a'))
    ?? candidates[0]
    ?? null;
}

/** Presses what is drawn at the middle of `el`, so whichever element listens (icon, its wrapper) hears it. */
function pressCentre(el: Element): void {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const target = at instanceof HTMLElement && (el.contains(at) || at.contains(el)) ? at : el;
  if (target instanceof HTMLElement) press(target);
  else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * Adds one procedure to the Treatment Plan: picks the entry ending "(code-…)"
 * in Procedure, types No. of Days/Units, presses "+" and waits for the new row.
 * A code with several entries (stratifications) is never guessed, and an entry
 * already in the table is not added twice.
 */
async function addProcedure(code: string, units: number): Promise<{ message: string; warn: boolean; skipped?: boolean }> {
  const label = await waitFor(() => formLabel(PROCEDURE_LABEL), 3000);
  const widget = label ? dropdownAfter(label) : null;
  if (!widget) {
    throw new StepStopped('The Treatment Plan\'s "Procedure" box was not found — open the case and expand "Treatment Plan" on the site, then press Fill again');
  }
  const entry = procedureEntry(code);
  let name: string;

  if (widget.kind === 'select') {
    const matches = Array.from(widget.el.options).filter((o) => o.value !== '' && entry.test(norm(o.text)));
    if (matches.length !== 1) {
      throw new Error(matches.length ? `${matches.length} entries for ${code}: ${matches.map((o) => norm(o.text)).join(' / ')} — choose one yourself` : `${code} is not in the site's Procedure list`);
    }
    name = norm(matches[0].text).replace(entry, '').trim();
    const like = rowLike(name);
    if (like) return skippedAsPresent(code, like);
    const e = fillControl(widget.el, matches[0].value);
    if (e) throw new Error(`Procedure: ${e}`);
  } else {
    openDropdown(widget.box);
    await sleep(PACE.part);
    // The search box is in the dropdown, or opens with it (focused).
    const active = document.activeElement;
    const search = widget.input ?? (active instanceof HTMLInputElement ? active : null);
    if (search) typeInto(search, code);
    // The list can be slow to filter on a busy day — a false "not in the list" is worse than a short wait.
    const options = await waitFor(() => {
      const hits = textLeaves(entry, 250).filter((el) => !el.closest('table'));
      return hits.length ? hits : null;
    }, 6000);
    const close = () => (search ?? widget.box).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (!options) {
      close();
      throw new Error(`${code} is not in the site's Procedure list${search ? '' : ' (no search box was found in the list)'}`);
    }
    const texts = [...new Set(options.map(textOf))];
    if (texts.length > 1) {
      close();
      throw new Error(`${texts.length} entries for ${code}: ${texts.join(' / ')} — choose one yourself`);
    }
    name = texts[0].replace(entry, '').trim();
    const like = rowLike(name);
    if (like) {
      close();
      return skippedAsPresent(code, like);
    }
    await sleep(PACE.part);
    const picked = options[0];
    press(picked);
    // Taken when the list has closed and the box shows the entry ("…(NU116-None)").
    const named = new RegExp(`\\(\\s*${escapeRx(code)}\\s*-`, 'i');
    const shows = await waitFor(() => !picked.isConnected && named.test(widget.area.textContent || ''), 2500);
    if (!shows) {
      close();
      throw new Error(`${code} was chosen in the Procedure list, but the box does not show it — nothing was added`);
    }
    await sleep(PACE.part);
  }

  // No. of Days/Units — some procedures are fixed at 1 by the site.
  const notes: string[] = [];
  const unitsLabel = formLabel(UNITS_LABEL);
  const unitsBox = unitsLabel ? controlNextTo(unitsLabel, 2) ?? controlNextTo(unitsLabel, 3) : null;
  if (unitsBox && !isLocked(unitsBox)) {
    const e = setValue(unitsBox, String(units));
    if (e) notes.push(`Days/Units: ${e}`);
  } else if (units !== 1) {
    notes.push(`Days/Units could not be typed (the site ${unitsBox ? 'locks it' : 'shows no such box'}) — the bill has ${units}`);
  }
  await sleep(PACE.part);

  const t = treatmentTable();
  const before = t ? treatmentRows(t).length : 0;
  const add = addRowButton();
  if (!add) throw new StepStopped('The "+" button next to ICHI Code was not found, so nothing was added (the page layout has been saved for the developer)');
  pressCentre(add);
  const grew = await waitFor(() => {
    const now = treatmentTable();
    return now && treatmentRows(now).length > before;
  }, 4000);
  if (!grew) {
    const shown = problemsShown();
    throw new Error(`"+" did not add ${code} to the table${shown ? ` — the site says: ${shown}` : ''}`);
  }
  return {
    message: `${code} ${name.slice(0, 60)} — ${units} unit(s)${notes.length ? ` — ${notes.join('; ')}` : ''}`,
    warn: notes.length > 0,
  };
}

// ------------------------------- Coal India Bill Details (CGHS / Unlisted rows)

/**
 * e-Arogya Suvidha lists its rows under red "Category -: CGHS List Items"
 * headings, outside the table that holds the column headings — so a section is
 * everything between its heading and the next one, and a row is the boxes on
 * one line. Left to right, the drop-down list left out: code, name, quantity,
 * rate, hospital amount, entitled amount, remarks.
 */
const CIL_HEADING = '^\\s*Category\\s*[-–:]+\\s*';
const CIL_SECTION = { cghs: 'CGHS\\s*List\\s*Items', unlisted: 'Unlisted\\s*Procedures' } as const;
const CIL_SECTION_NAME = { cghs: 'CGHS List Items', unlisted: 'Unlisted Procedures' } as const;
const CIL_COL = { code: 0, name: 1, qty: 2, rate: 3, hospital: 4, entitled: 5, remarks: 6 } as const;
const CIL_BOXES = 7;
/** What an icon's markup says: "+" adds a row, the red cross deletes one — and is never pressed. */
const ADD_ICON = /add|plus|insert/i;
const DELETE_ICON = /del|remov|cross|minus|trash|close|cancel|clear/i;

type TextBox = HTMLInputElement | HTMLTextAreaElement;
type CilSectionKey = keyof typeof CIL_SECTION;

interface CilSection {
  heading: HTMLElement;
  /** The next "Category -:" heading — where this section ends. */
  end: HTMLElement | null;
  rows: TextBox[][];
}

const isAfter = (a: Node, b: Node) => a !== b && !a.contains(b) && Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const within = (s: { heading: Element; end: Element | null }, el: Element) => isAfter(s.heading, el) && (!s.end || isAfter(el, s.end));

/** Elements grouped by the line they sit on, top to bottom, each line left to right. */
function byLine<T extends Element>(els: T[]): T[][] {
  const lines: { mid: number; items: T[] }[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const line = lines.find((l) => Math.abs(l.mid - mid) < Math.max(6, r.height / 2));
    if (line) line.items.push(el);
    else lines.push({ mid, items: [el] });
  }
  return lines
    .sort((a, b) => a.mid - b.mid)
    .map((l) => l.items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left));
}

function cilSection(key: CilSectionKey): CilSection | null {
  const heading = textLeaves(rx(CIL_HEADING + CIL_SECTION[key]), 80)[0];
  if (!heading) return null;
  const end = textLeaves(rx(CIL_HEADING), 80).find((el) => isAfter(heading, el)) ?? null;
  const section = { heading, end };
  const boxes = Array.from(document.querySelectorAll<Control>(CONTROL_SELECTOR)).filter(
    (c): c is TextBox => !(c instanceof HTMLSelectElement) && !/^(checkbox|radio)$/i.test(c.type) && isVisible(c) && within(section, c),
  );
  return { ...section, rows: byLine(boxes) };
}

/** An icon's own markup and that of the link or button around it (file name, alt, title, class, handler). */
function iconWords(el: Element): string {
  const attrs = (n: Element | null) =>
    n
      ? ['src', 'alt', 'title', 'id', 'class', 'name', 'aria-label', 'onclick', 'href']
        .map((a) => {
          const v = n.getAttribute(a) || '';
          if (a === 'src') return v.split(/[\\/]/).pop() || '';
          return a === 'href' && !/^javascript:/i.test(v) ? '' : v;
        })
        .join(' ')
      : '';
  return norm(`${attrs(el)} ${attrs(el.closest('a, button'))} ${attrs(el.querySelector('img'))}`).slice(0, 300);
}

/**
 * Blue or red, from the picture itself — the site draws "+" in a blue circle
 * and the delete cross in red. null for a picture that cannot be read (from
 * another site) or that is neither.
 */
function iconHue(el: Element): 'blue' | 'red' | null {
  const img = el instanceof HTMLImageElement ? el : el.querySelector('img');
  if (!img || !img.complete || !img.naturalWidth) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    const { data } = ctx.getImageData(0, 0, 16, 16);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Coloured pixels only: transparent, white and grey ones say nothing about the icon.
      if (data[i + 3] < 128 || Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) < 40) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    if (b > 1.3 * r && b > g) return 'blue';
    if (r > 1.3 * b && r > g) return 'red';
    return null;
  } catch {
    return null;
  }
}

/** Captionless icons right of `row`'s last box, on its line, innermost first. */
function iconsAfter(row: TextBox[], s: CilSection): HTMLElement[] {
  const last = row[row.length - 1].getBoundingClientRect();
  const icons = Array.from(document.querySelectorAll<HTMLElement>('img, input[type="image"], a, button, [role="button"], i, span'))
    .filter((el) => within(s, el) && isVisible(el) && !textOf(el) && !isForbidden(el))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      return r.left >= last.right - 2 && mid > last.top - 4 && mid < last.bottom + 4;
    });
  return icons.filter((el) => !icons.some((other) => other !== el && el.contains(other)));
}

/**
 * The "+" after `row`: the icon whose markup says add / plus; failing that the
 * blue one; failing that the only icon beside one whose markup says delete.
 * Never one whose markup says delete or that is drawn red.
 */
function addIconFor(row: TextBox[], s: CilSection): HTMLElement | null {
  const icons = iconsAfter(row, s);
  const safe = icons.filter((el) => !DELETE_ICON.test(iconWords(el)) && iconHue(el) !== 'red');
  return safe.find((el) => ADD_ICON.test(iconWords(el)))
    ?? safe.find((el) => iconHue(el) === 'blue')
    ?? (safe.length === 1 && icons.some((el) => DELETE_ICON.test(iconWords(el))) ? safe[0] : null);
}

/**
 * Clicks as the page's own code would. A link like <a href="javascript:addRow()">
 * does nothing when a content script clicks it (Chrome refuses the javascript:
 * address there), so the element is marked and the extension's service worker
 * makes the click in the page's world. Anything else may fall back to a plain
 * click; such a link never does — it would only be refused again.
 */
async function pageClick(el: HTMLElement): Promise<void> {
  const token = Math.random().toString(36).slice(2);
  const scripted = /^\s*javascript:/i.test(el.closest('a')?.getAttribute('href') ?? '');
  el.setAttribute('data-fillpilot-click', token);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  let answer: unknown;
  try {
    answer = await chrome.runtime.sendMessage({ type: 'fillpilot.pageClick', token });
  } catch (err) {
    answer = `the extension's background did not answer (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    el.removeAttribute('data-fillpilot-click');
  }
  if (answer === 'clicked') return;
  if (!scripted) {
    el.click();
    return;
  }
  throw new StepStopped(`the "+" is a link that runs the site's own script, and the click could not be made in the page (${String(answer)}) — `
    + 'reload FillPilot in chrome://extensions, reload this page, then press Fill again');
}

/** A key event as a keyboard sends it — older pages read keyCode / which / charCode, not key. */
function keyEvent(box: Element, type: 'keydown' | 'keypress' | 'keyup', ch: string): void {
  const upper = ch.toUpperCase().charCodeAt(0);
  const keyCode = type === 'keypress'
    ? ch.charCodeAt(0)
    : /[A-Za-z0-9 ]/.test(ch) ? upper : ({ '-': 189, '.': 190, ',': 188, '/': 191 } as Record<string, number>)[ch] ?? upper;
  const init: KeyboardEventInit & { keyCode?: number; which?: number; charCode?: number } = {
    bubbles: true, cancelable: true, key: ch, keyCode, which: keyCode, charCode: type === 'keypress' ? keyCode : 0,
  };
  box.dispatchEvent(new KeyboardEvent(type, init));
}

/**
 * Focuses a box and types into it key by key, as a person does — pages look a
 * code up or work an amount out from key handlers. While the side panel has
 * the keyboard focus, the page's window does not, and the browser then sends
 * the page no focus or blur at all: those are sent here (and in `leave`).
 */
function typeKeys(box: TextBox, value: string): void {
  box.focus({ preventScroll: true });
  if (!document.hasFocus()) {
    box.dispatchEvent(new FocusEvent('focus'));
    box.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  }
  setNativeValue(box, '');
  let typed = '';
  for (const ch of value) {
    keyEvent(box, 'keydown', ch);
    keyEvent(box, 'keypress', ch);
    typed += ch;
    setNativeValue(box, typed);
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    keyEvent(box, 'keyup', ch);
  }
  if (!value) box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
}

/** Leaves a box: change, then blur — where many pages look a code up or recalculate. */
function leave(box: TextBox): void {
  box.dispatchEvent(new Event('change', { bubbles: true }));
  if (!document.hasFocus()) {
    box.dispatchEvent(new FocusEvent('blur'));
    box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  box.blur();
}

/** Types a whole value and leaves the box. → error message, or null when it took. */
function enter(box: TextBox, value: string): string | null {
  typeKeys(box, value);
  leave(box);
  const ok = box.value === value || (value.trim() !== '' && box.value.trim() !== '' && Number(box.value) === Number(value));
  flash(box, ok ? OUTLINE.filled : OUTLINE.failed, 2500);
  return ok ? null : `the page changed the value to "${box.value}"`;
}

/**
 * Types a CIL code and waits for the site to name the item — the proof that it
 * knows the code. A page may offer the code in a list as it is typed (then the
 * entry is picked, as a person would) or look it up when the box is left.
 * → null once named, else what the page did, for the message.
 */
async function enterCilCode(codeBox: TextBox, code: string, named: () => string): Promise<string | null> {
  const appeared: HTMLElement[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) if (node instanceof HTMLElement) appeared.push(node);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  let picked = '';
  try {
    typeKeys(codeBox, code);
    const offer = await waitFor(() => (named() ? 'named' : findTariffResult(code, appeared, codeBox)), 2500);
    if (offer instanceof HTMLElement) {
      picked = textOf(offer).slice(0, 60);
      press(offer);
      await sleep(PACE.part);
    }
  } finally {
    observer.disconnect();
  }
  leave(codeBox);
  flash(codeBox, OUTLINE.filled, 2500);
  if (await waitFor(() => named(), 8000)) return null;
  return `the site did not fill in the item name for ${code}${picked ? ` after "${picked}" was picked from its list` : ''} (${describeAppeared(appeared)}; `
    + `the page ${document.hasFocus() ? 'had' : 'did not have'} the keyboard focus)`;
}

/** Long names are cut to what the box takes (maxlength), as typing would. */
const fit = (box: TextBox, text: string) => (box.maxLength > 0 ? text.slice(0, box.maxLength) : text);

/** The number in a box ("2,689.00" → 2689), or null when it is empty or not a number. */
function amountIn(box: Control | null | undefined): number | null {
  const text = (box?.value ?? '').replace(/,/g, '').trim();
  const n = Number(text);
  return text && Number.isFinite(n) ? n : null;
}

/**
 * Adds one Bill Details row: into the first empty row of its section, or a new
 * one from the "+" after the last row. CGHS rows: the code (the site fills in
 * the name), the quantity, the bill's rate only when the site gives none, the
 * service in Remarks. Unlisted rows: code, name, quantity, rate. A row already
 * entered for this code and service is not added twice.
 */
async function addCilRow(a: Extract<PageAction, { type: 'addCilRow' }>): Promise<{ message: string; warn: boolean; skipped?: boolean }> {
  const where = CIL_SECTION_NAME[a.section];
  const service = (a.section === 'cghs' ? a.remarks : a.name) ?? '';
  const serviceCol = a.section === 'cghs' ? CIL_COL.remarks : CIL_COL.name;

  const read = (s: CilSection | null) => {
    if (!s) throw new StepStopped(`"Category -: ${where}" was not found — open the Bill Details tab on the site, then press Fill again`);
    const odd = s.rows.find((r) => r.length !== CIL_BOXES);
    if (odd) throw new StepStopped(`A "${where}" row has ${odd.length} boxes where ${CIL_BOXES} were expected, so nothing was added (the page layout has been saved for the developer)`);
    return s;
  };
  const s = read(await waitFor(() => cilSection(a.section), 3000));

  const sameText = (box: TextBox, text: string) => {
    const have = norm(box.value).toLowerCase();
    const want = norm(text).toLowerCase();
    return have === want || (have.length >= 8 && want.startsWith(have));
  };
  const withCode = s.rows.filter((r) => norm(r[CIL_COL.code].value).toUpperCase() === a.code.toUpperCase());
  // A CIL code is one row for the whole bill: any row with it means it is entered.
  if (a.section === 'cghs' && withCode.length) {
    const qty = withCode.map((r) => r[CIL_COL.qty].value.trim() || '?').join(' + ');
    return { message: `${a.code} is already in ${where} (quantity ${qty}; the bill: ${a.qty}) — not added again; check that row`, warn: true, skipped: true };
  }
  if (service && withCode.some((r) => sameText(r[serviceCol], service))) {
    return { message: `${a.code} for "${service.slice(0, 50)}" is already in ${where} — not added again`, warn: true, skipped: true };
  }
  if (withCode.some((r) => !norm(r[serviceCol].value))) {
    return { message: `a ${a.code} row without the service is already in ${where} — not added; check that row against the bill`, warn: true, skipped: true };
  }

  const isEmpty = (r: TextBox[]) => !norm(r[CIL_COL.code].value) && !Number(r[CIL_COL.qty].value);
  let row = s.rows.find(isEmpty);
  if (!row) {
    const last = s.rows[s.rows.length - 1];
    if (!last) throw new StepStopped(`"${where}" has no row to type into, so nothing was added (the page layout has been saved for the developer)`);
    const plus = addIconFor(last, s);
    if (!plus) {
      const seen = iconsAfter(last, s).map((el) => `<${el.tagName.toLowerCase()}> ${iconWords(el) || '(no markup)'} ${iconHue(el) ?? ''}`.trim());
      throw new StepStopped(`The blue "+" after the last "${where}" row was not recognised (icons there: ${seen.join(' | ') || 'none'}), so nothing was added — the page layout has been saved for the developer`);
    }
    const before = s.rows.length;
    await pageClick(plus);
    row = (await waitFor(() => {
      const now = cilSection(a.section);
      return now && now.rows.length > before ? now.rows.find(isEmpty) : null;
    }, 4000)) ?? undefined;
    if (!row) {
      const shown = problemsShown();
      throw new StepStopped(`the blue "+" (<${plus.tagName.toLowerCase()}> ${iconWords(plus) || 'no markup'}) was pressed but no new "${where}" row appeared`
        + `${shown ? ` — the site says: ${shown}` : ''}; the page layout has been saved for the developer`);
    }
    read(cilSection(a.section));
    await sleep(PACE.part);
  }

  const box = (col: number) => row![col];
  if (isLocked(box(CIL_COL.code))) {
    throw new Error(a.section === 'unlisted'
      ? 'the Unlisted Procedures row is locked on the site — tick "Prior approval has already taken" there if it applies, then press Fill again'
      : `the "${where}" row is locked on the site`);
  }

  let e: string | null;
  if (a.section === 'cghs') {
    const notNamed = await enterCilCode(box(CIL_COL.code), a.code, () => norm(box(CIL_COL.name).value));
    if (notNamed) {
      enter(box(CIL_COL.code), '');
      throw new Error(`${notNamed} — the code was cleared again; enter this line yourself`);
    }
  } else {
    e = enter(box(CIL_COL.code), a.code);
    if (e) throw new Error(`Item Code: ${e}`);
  }

  const problems: string[] = [];
  if (a.section === 'unlisted' && a.name) {
    e = enter(box(CIL_COL.name), fit(box(CIL_COL.name), a.name));
    if (e) problems.push(`Item Name: ${e}`);
  }
  await sleep(PACE.part);
  e = enter(box(CIL_COL.qty), String(a.qty));
  if (e) problems.push(`Quantity: ${e}`);

  // CGHS: the site prices its own items — its rate is kept. Typed only when it gives none.
  const rateBox = box(CIL_COL.rate);
  const siteRate = a.section === 'cghs' ? await waitFor(() => ((amountIn(rateBox) ?? 0) > 0 ? amountIn(rateBox) : null), 2000) : null;
  if (siteRate == null) {
    if (a.rate == null) problems.push('Rate: not readable on the bill — type it yourself');
    else if (isLocked(rateBox)) problems.push(`Rate: the box is locked on the site (the bill's rate is ${a.rate})`);
    else {
      e = enter(rateBox, String(a.rate));
      if (e) problems.push(`Rate: ${e}`);
    }
  }
  if (a.remarks) {
    e = enter(box(CIL_COL.remarks), fit(box(CIL_COL.remarks), a.remarks));
    if (e) problems.push(`Remarks: ${e}`);
  }
  if (problems.length) throw new Error(`${a.code} was typed, but ${problems.join('; ')}`);

  const hospital = box(CIL_COL.hospital);
  const siteAmount = await waitFor(() => ((amountIn(hospital) ?? 0) > 0 ? amountIn(hospital) : null), 2000);
  if (siteAmount == null) {
    return { message: `${a.code} × ${a.qty} typed — the site shows no Hospital Amount yet; check the row (the bill: ${a.amount})`, warn: true };
  }
  if (Math.abs(siteAmount - a.amount) > 0.5) {
    return { message: `${a.code} × ${a.qty}: the site's amount is ${siteAmount}${siteRate ? ` at its rate ${siteRate}` : ''}, the bill's is ${a.amount} — check it`, warn: true };
  }
  return { message: `${a.code} × ${a.qty} = ${siteAmount}`, warn: false };
}

/** Boxes on the same line as `label`, after it. */
function boxesBeside(label: HTMLElement): Control[] {
  const r = label.getBoundingClientRect();
  return Array.from(document.querySelectorAll<Control>(CONTROL_SELECTOR))
    .filter((c) => {
      if (!isVisible(c) || !isAfter(label, c)) return false;
      const b = c.getBoundingClientRect();
      const mid = b.top + b.height / 2;
      return mid >= r.top - 6 && mid <= r.bottom + 6;
    })
    .slice(0, 4);
}

/**
 * The site's Pharmacy Amount and Grand Total (Hospital Amount column) against
 * the bill. The Grand Total may fall short by exactly what is left for the
 * person (room rent, doctor fees) — that is said, not flagged.
 */
async function checkCilTotals(netAmount: number | null, pharmacy: number | null, notFilled: number): Promise<{ message: string; warn: boolean }> {
  await sleep(PACE.part);
  const problems: string[] = [];
  const fine: string[] = [];

  if (pharmacy != null) {
    const label = formLabel('^\\s*Pharmacy\\s*Amount\\s*:?\\s*$');
    const site = label ? amountIn(boxesBeside(label)[0]) : null;
    if (site == null) problems.push(`Pharmacy Amount not found on the page (the bill's pharmacy: ${pharmacy})`);
    else if (Math.abs(site - pharmacy) > 1) problems.push(`Pharmacy Amount on the site is ${site}, the bill's pharmacy is ${pharmacy} — check the Pharmacy/Consumable tab`);
    else fine.push(`Pharmacy ${site} matches the bill`);
  }

  const label = formLabel('^\\s*Grand\\s*Total\\s*:?\\s*$');
  const boxes = label ? boxesBeside(label) : [];
  // The Hospital Amount column: the box under that heading, else the one before the last (Entitled Amount).
  const header = textLeaves(rx('^\\s*Hospital\\s*Amount\\s*$'), 40)[0];
  const centre = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  };
  const totalBox = header && boxes.length
    ? boxes.reduce((best, b) => (Math.abs(centre(b) - centre(header)) < Math.abs(centre(best) - centre(header)) ? b : best))
    : boxes[boxes.length - 2] ?? boxes[0];
  const site = amountIn(totalBox);
  if (site == null) problems.push('Grand Total not found on the page');
  else if (netAmount != null) {
    const gap = Math.round((netAmount - site) * 100) / 100;
    if (Math.abs(gap) <= 1) fine.push(`Grand Total ${site} = the bill's net amount ${netAmount}`);
    else if (notFilled > 0 && Math.abs(gap - notFilled) <= 1) fine.push(`Grand Total ${site} — with the ${notFilled} left for you (room rent, doctor fees…) it comes to the bill's ${netAmount}`);
    else problems.push(`Grand Total on the site is ${site}, the bill's net amount is ${netAmount} — ${gap} apart${notFilled ? ` (${notFilled} of the bill is left for you to enter)` : ''}; check the rows`);
  }
  return { message: [...problems, ...fine].join('. '), warn: problems.length > 0 };
}

export async function runActions(actions: PageAction[]): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const [index, a] of actions.entries()) {
    try {
      let message: string;
      let warn = false;
      let skipped: boolean | undefined;
      switch (a.type) {
        case 'clickTab': message = await clickTab(a.text, a.next); break;
        case 'clickButton': message = await clickButton(a.text); break;
        case 'setField': message = await setField(a.field, a.value, a.id, a.calendar); break;
        case 'ensureRows': message = await ensureRows(a.headers, a.count, a.addButton); break;
        case 'setCell': message = await setCell(a.headers, a.row, a.column, a.value, a.optionMatch); break;
        case 'addTariffItem': ({ message, warn } = await addTariffItem(a.code, a.tariff, a.qty, a.amountClaimed, a.tariffOption, a.alternatives)); break;
        case 'addProcedure': ({ message, warn, skipped } = await addProcedure(a.code, a.units)); break;
        case 'addCilRow': ({ message, warn, skipped } = await addCilRow(a)); break;
        case 'checkCilTotals': ({ message, warn } = await checkCilTotals(a.netAmount, a.pharmacy, a.notFilled)); break;
        default: throw new Error('Unknown action');
      }
      results.push({ index, label: a.label, ok: true, message, ...(warn ? { warn } : {}), ...(skipped ? { skipped } : {}) });
    } catch (err) {
      results.push({ index, label: a.label, ok: false, message: err instanceof Error ? err.message : String(err), ...(err instanceof StepStopped ? { stopped: true } : {}) });
      // Fewer results than actions tells the panel the step stopped. A tab that
      // would not open or a row that could not be added does not stop it: the
      // person may have the tab open already, and the rows that exist still fill.
      if (err instanceof StepStopped) break;
    }
    await sleep(PACE.step);
  }
  return results;
}

// ------------------------------------------------------- read-only helpers

/** IP number / admission number / patient name as printed anywhere on the page (hidden tabs included). */
export function readIdentity(): PageIdentity {
  const text = (document.body.textContent || '').replace(/\s+/g, ' ');
  const ip = /IP\s*(?:Number|No\.?)\s*[:\-]?\s*(\d{4,})/i.exec(text);
  const admission = /Admission\s*No\.?\s*[:\-]?\s*(\d{4,})/i.exec(text);
  const name = /Patient\s*Name\s*[:\-]?\s*([A-Z][A-Z .]{2,60}?)(?=\s*(?:Employee|IP|Date|Patient|Admission|Claim|$))/.exec(text);
  return { ipNumber: ip ? ip[1] : null, admissionNumber: admission ? admission[1] : null, patientName: name ? norm(name[1]) : null };
}

/** "div.step.active[role=tab] < ul.steps < …" — the element and up to five ancestors. */
function domPath(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== document.body && parts.length < 6; node = node.parentElement) {
    const classes = typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean).slice(0, 4).map((c) => `.${c.slice(0, 30)}`).join('') : '';
    const role = node.getAttribute('role');
    parts.push(`${node.tagName.toLowerCase()}${classes}${role ? `[role=${role}]` : ''}`);
  }
  return parts.join(' < ');
}

/**
 * Structure only — labels, captions, headings, option texts. Never the values
 * typed into fields. `probes` are captions the site profile looks for; where
 * each one sits in the page shows how the site builds its tabs and buttons.
 */
export function describePage(probes: string[] = []): PageOutline {
  const visible = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel)).filter(isVisible);
  const standard = 'button, a, input, select, textarea, label, option';
  const pointerRoots = visible<HTMLElement>('body *')
    .filter((el) => !el.matches(standard) && !el.closest('button, a, label') && hasPointer(el) && !(el.parentElement && hasPointer(el.parentElement)))
    .map((el) => ({ text: textOf(el).slice(0, 60), path: domPath(el) }))
    .filter((c) => c.text);
  const labelFor = (c: Element) => {
    const id = c.getAttribute('id');
    const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : c.closest('label');
    return norm(l?.textContent).slice(0, 80);
  };
  // The page's own handlers (onblur="getItem(this)") show what a box reacts to — a lookup on blur, a sum on keyup.
  const attrsOf = (c: Element) => ['role', 'list', 'autocomplete', 'aria-autocomplete', 'aria-controls', 'aria-haspopup', 'data-bs-toggle',
    'onblur', 'onchange', 'onkeyup', 'onkeypress', 'onkeydown', 'onfocus', 'oninput']
    .map((a) => (c.hasAttribute(a) ? `${a}=${(c.getAttribute(a) || '').slice(0, 80)}` : ''))
    .filter(Boolean)
    .join(' ');
  return {
    url: location.origin + location.pathname,
    title: document.title,
    tabs: visible('[role="tab"], .nav-link, .nav-tabs li, .tab, .step-tab').map((e) => textOf(e)).filter(Boolean).slice(0, 30),
    headings: visible('h1, h2, h3, h4, h5, h6, legend, .card-header, .card-title').map((e) => textOf(e).slice(0, 80)).filter(Boolean).slice(0, 40),
    buttons: visible<HTMLElement>('button, input[type="button"], a.btn').map((e) => textOf(e)).filter(Boolean).slice(0, 60),
    labels: visible('label').map((e) => norm(e.textContent).slice(0, 80)).filter(Boolean).slice(0, 80),
    fields: visible<HTMLInputElement | HTMLTextAreaElement>('input:not([type=hidden]), textarea').slice(0, 120).map((c) => ({
      tag: c.tagName.toLowerCase(),
      type: (c as HTMLInputElement).type || '',
      name: c.getAttribute('name') || '',
      id: c.getAttribute('id') || '',
      placeholder: c.getAttribute('placeholder') || '',
      label: labelFor(c),
      state: `${c.disabled ? 'disabled ' : ''}${c.readOnly ? 'readonly' : ''}`.trim(),
      attrs: attrsOf(c),
      path: domPath(c).split(' < ').slice(0, 4).join(' < '),
    })),
    selects: visible<HTMLSelectElement>('select').slice(0, 40).map((s) => ({
      name: s.getAttribute('name') || '',
      id: s.getAttribute('id') || '',
      label: labelFor(s),
      options: Array.from(s.options).map((o) => norm(o.text)).slice(0, 30),
    })),
    tables: visible<HTMLTableElement>('table').slice(0, 20).map((t) => {
      const cells = Array.from((t.tHead?.rows[0] ?? t.rows[0])?.cells ?? []);
      // Only real column headings: the first row of a table without them is data (a patient's name, an amount).
      const headed = Boolean(t.tHead) || (cells.length > 0 && cells.every((c) => c.tagName === 'TH'));
      return {
        headers: headed ? cells.map((c) => norm(c.textContent)) : cells.map(() => '(data)'),
        rows: Array.from(t.tBodies).reduce((n, b) => n + b.rows.length, 0),
      };
    }),
    captions: probes.flatMap((probe) =>
      textLeaves(rx(probe), 80).slice(0, 4).map((el) => ({ probe, text: textOf(el).slice(0, 80), path: domPath(el), pointer: hasPointer(el) })),
    ),
    clickables: pointerRoots.slice(0, 60),
    icons: visible<HTMLElement>('img, input[type="image"], i, span[class*="icon" i], a[onclick], a[href^="javascript"]')
      .filter((el) => !textOf(el))
      .slice(0, 60)
      .map((el) => ({ tag: el.tagName.toLowerCase(), attrs: iconWords(el), path: domPath(el).split(' < ').slice(0, 4).join(' < ') })),
    frames: document.querySelectorAll('iframe, frame').length,
    shadowHosts: Array.from(document.querySelectorAll('*')).filter((el) => el.shadowRoot).length,
  };
}
