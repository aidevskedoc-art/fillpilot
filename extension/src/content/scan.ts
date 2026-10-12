// Finds fillable controls and everything the page says about each one.
// Element references stay in this isolated world's memory (never written to the
// DOM), keyed by a ref the panel uses to address fields.

import type { FieldDescriptor } from '../../../web/projects/shared/src/page-contract';

const SKIP_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'image', 'reset', 'color']);
const MAX_TEXT = 150;

export type Target = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLInputElement[];

const refs = new Map<string, Target>();
let counter = 0;

export function getTarget(ref: string): Target | undefined {
  return refs.get(ref);
}

export function clearRefs(): void {
  refs.clear();
}

function clean(text: string | null | undefined): string {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:*]+$/, '')
    .trim()
    .slice(0, MAX_TEXT);
}

/** Text of a node without the text of form controls inside it (a <select>'s options, etc.). */
function textWithoutControls(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll('input, select, textarea, button, script, style').forEach((n) => n.remove());
  return clean(clone.textContent);
}

function isVisible(el: Element): boolean {
  if ((el as HTMLElement).closest('[hidden]')) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function labelElementText(el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (forLabel) return textWithoutControls(forLabel);
  }
  const wrapping = el.closest('label');
  return wrapping ? textWithoutControls(wrapping) : '';
}

function ariaLabelledByText(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  return clean(ids.map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' '));
}

/**
 * Label-like text near a control that has no <label>: the previous table cell,
 * a <dt> before its <dd>, or a short text element just before it (or before
 * its wrapper) — the common div-grid and table form layouts.
 */
function nearbyText(el: Element): string {
  const cell = el.closest('td, th');
  if (cell?.previousElementSibling) {
    const t = textWithoutControls(cell.previousElementSibling);
    if (t) return t;
  }
  const dd = el.closest('dd');
  if (dd?.previousElementSibling?.tagName === 'DT') return textWithoutControls(dd.previousElementSibling);

  let node: Element | null = el;
  for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    let sib = node.previousElementSibling;
    for (let hops = 0; sib && hops < 2; hops++, sib = sib.previousElementSibling) {
      if (sib.matches('input, select, textarea, button')) break;
      const t = textWithoutControls(sib);
      if (t && t.length <= 60) return t;
      if (t) break;
    }
  }
  return '';
}

function legendText(el: Element): string {
  const legend = el.closest('fieldset')?.querySelector(':scope > legend');
  return legend ? clean(legend.textContent) : '';
}

function nextRef(): string {
  counter += 1;
  return `f${counter}`;
}

function base(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): Omit<FieldDescriptor, 'ref' | 'frameId' | 'tag' | 'type'> {
  const input = el as HTMLInputElement;
  return {
    name: el.getAttribute('name') || undefined,
    id: el.getAttribute('id') || undefined,
    label: labelElementText(el) || ariaLabelledByText(el) || undefined,
    ariaLabel: clean(el.getAttribute('aria-label')) || undefined,
    placeholder: clean(el.getAttribute('placeholder')) || undefined,
    nearbyText: nearbyText(el) || undefined,
    pattern: el.getAttribute('pattern') || undefined,
    required: el.required || el.getAttribute('aria-required') === 'true',
    maxLength: input.maxLength > 0 ? input.maxLength : undefined,
  };
}

export function scanPage(frameId = 0): FieldDescriptor[] {
  refs.clear();
  const out: FieldDescriptor[] = [];
  const radioGroups = new Map<string, HTMLInputElement[]>();

  const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'));
  for (const el of controls) {
    if (el.disabled || (el as HTMLInputElement).readOnly) continue;
    const tag = el.tagName.toLowerCase() as FieldDescriptor['tag'];
    const type = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : tag === 'select' ? 'select' : 'textarea';
    if (SKIP_TYPES.has(type)) continue;

    if (type === 'radio') {
      // Custom-styled radios are often visually hidden; the label is what shows.
      if (!isVisible(el) && !(el.closest('label') && isVisible(el.closest('label')!))) continue;
      const key = `${(el as HTMLInputElement).form ? 'form' : 'doc'}:${el.getAttribute('name') || el.id}`;
      if (!radioGroups.has(key)) radioGroups.set(key, []);
      radioGroups.get(key)!.push(el as HTMLInputElement);
      continue;
    }
    if (!isVisible(el)) continue;

    const ref = nextRef();
    refs.set(ref, el);
    const descriptor: FieldDescriptor = { ref, frameId, tag, type, ...base(el) };
    if (tag === 'select') {
      descriptor.options = Array.from((el as HTMLSelectElement).options)
        .slice(0, 500)
        .map((o) => ({ value: o.value, text: clean(o.text) }));
    }
    out.push(descriptor);
  }

  for (const radios of radioGroups.values()) {
    const first = radios[0];
    const ref = nextRef();
    refs.set(ref, radios);
    const legend = legendText(first);
    out.push({
      ref,
      frameId,
      tag: 'input',
      type: 'radio',
      name: first.getAttribute('name') || undefined,
      legend: legend || undefined,
      label: legend || nearbyText(first.closest('label') || first) || undefined,
      required: radios.some((r) => r.required),
      options: radios.map((r) => ({ value: r.value, text: labelElementText(r) || r.value })),
    });
  }
  return out;
}
