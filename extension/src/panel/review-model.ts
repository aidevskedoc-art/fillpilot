// Panel-side state for one web field in the review list.
import type { AvailableField, MatchCandidate, MatchStatus, MatchedField } from '../../../web/projects/shared/src/api-types';

export interface OptionGroup {
  label: string;
  items: { label: string; value: number }[];
}

export interface ReviewRow {
  ref: string;
  label: string;
  webType: string;
  required: boolean;
  signature: string;
  /** Status the matcher gave — kept for the audit's "auto-matched" count. */
  initialStatus: MatchStatus;
  status: MatchStatus;
  include: boolean;
  selected: MatchCandidate | null;
  warnings: string[];
  options: OptionGroup[];
  /** The user picked the PDF field themselves. */
  manual: boolean;
  /** Save the manual choice for this website + form. */
  save: boolean;
  outcome?: 'filled' | 'failed' | 'skipped';
  error?: string;
}

function optionLabel(label: string, value: string): string {
  const v = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return `${label} — ${v}`;
}

export function toRow(f: MatchedField, available: AvailableField[]): ReviewRow {
  const suggested = f.candidates.map((c) => ({
    label: `${optionLabel(c.label, c.originalValue)} (${Math.round(c.confidence * 100)}%)`,
    value: c.fieldId,
  }));
  const suggestedIds = new Set(f.candidates.map((c) => c.fieldId));
  const others = available.filter((a) => !suggestedIds.has(a.fieldId)).map((a) => ({ label: optionLabel(a.label, a.value), value: a.fieldId }));
  const options: OptionGroup[] = [];
  if (suggested.length) options.push({ label: 'Suggested', items: suggested });
  options.push({ label: 'All PDF fields', items: others });

  return {
    ref: f.ref,
    label: f.label,
    webType: f.webType,
    required: f.required,
    signature: f.signature,
    initialStatus: f.status,
    status: f.status,
    include: f.include,
    selected: f.selected,
    warnings: f.warnings,
    options,
    manual: false,
    save: false,
  };
}
