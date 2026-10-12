// Puts values into page controls the way a person typing would look to the
// page's own code: native value setter + input/change/blur events, so React /
// Angular / Vue controlled fields register the value. Never submits anything.

import type { FillAssignment, FillOutcome } from '../../../web/projects/shared/src/page-contract';
import { getTarget, type Target } from './scan';

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

/**
 * The prototype's setter, not the element's: frameworks (React) shadow `value`
 * on the instance to track changes; going through the prototype makes the page
 * see a genuine change and fire its onChange.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Sets one control (or radio group) like a typing user would. → error message, or null when it took. */
export function fillControl(target: Target, value: string): string | null {
  if (Array.isArray(target)) {
    const radio = target.find((r) => r.value === value);
    if (!radio) return `No option "${value}" on the page`;
    if (!radio.checked) radio.click();
    return radio.checked ? null : 'The page did not accept the selection';
  }

  const el = target;
  if (!el.isConnected) return 'The field is no longer on the page';

  if (el instanceof HTMLSelectElement) {
    if (!Array.from(el.options).some((o) => o.value === value)) return `No option "${value}" on the page`;
    el.focus();
    setNativeValue(el, value);
    fire(el, 'input');
    fire(el, 'change');
    el.blur();
    return el.value === value ? null : 'The page did not accept the selection';
  }

  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    const want = value === 'true';
    if (el.checked !== want) el.click();
    return el.checked === want ? null : 'The page did not accept the change';
  }

  el.focus();
  setNativeValue(el, value);
  fire(el, 'input');
  fire(el, 'change');
  el.blur();
  // Some inputs normalise (e.g. maxlength truncation, type=number) — report it.
  return el.value === value ? null : `The page changed the value to "${el.value}"`;
}

export const OUTLINE = { filled: '2px solid #14b8a6', failed: '2px solid #ef4444', focus: '3px solid #f59e0b' };
const restore = new Map<HTMLElement, { outline: string; offset: string; timer: number }>();

export function flash(el: HTMLElement, outline: string, ms: number): void {
  const prev = restore.get(el);
  if (prev) window.clearTimeout(prev.timer);
  const original = prev ?? { outline: el.style.outline, offset: el.style.outlineOffset, timer: 0 };
  el.style.outline = outline;
  el.style.outlineOffset = '2px';
  original.timer = window.setTimeout(() => {
    el.style.outline = original.outline;
    el.style.outlineOffset = original.offset;
    restore.delete(el);
  }, ms);
  restore.set(el, original);
}

function visualOf(target: Target): HTMLElement {
  if (Array.isArray(target)) return (target[0].closest('fieldset') as HTMLElement) || target[0];
  return target;
}

export function fillFields(assignments: FillAssignment[]): FillOutcome[] {
  return assignments.map(({ ref, value }) => {
    const target = getTarget(ref);
    if (!target) return { ref, ok: false, error: 'Field not found — scan the page again' };
    let error: string | null;
    try {
      error = fillControl(target, value);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not fill this field';
    }
    flash(visualOf(target), error ? OUTLINE.failed : OUTLINE.filled, 2500);
    return error ? { ref, ok: false, error } : { ref, ok: true };
  });
}

export function highlightField(ref: string | null): void {
  if (!ref) return;
  const target = getTarget(ref);
  if (!target) return;
  const el = visualOf(target);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash(el, OUTLINE.focus, 1500);
}
