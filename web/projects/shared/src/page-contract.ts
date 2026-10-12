// Contract between the extension panel and the content script it injects into
// the target page. Framework-free so the content script bundle can import it.

/** One fillable control (or radio group) on the page, as the matcher sees it. */
export interface FieldDescriptor {
  ref: string;
  frameId: number;
  tag: 'input' | 'select' | 'textarea';
  type: string;
  name?: string;
  id?: string;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  nearbyText?: string;
  legend?: string;
  pattern?: string;
  required?: boolean;
  maxLength?: number;
  options?: { value: string; text: string }[];
}

export interface FillAssignment {
  ref: string;
  value: string;
}

export interface FillOutcome {
  ref: string;
  ok: boolean;
  error?: string;
}

export interface PageInfo {
  origin: string;
  path: string;
  title: string;
}

/**
 * A step of a multi-step form fill (site profiles such as TGNPDCL). Text
 * patterns are case-insensitive regular-expression sources matched against
 * the visible text, so they survive class/id changes on the site.
 * Clicking anything whose text says save / submit / remove / delete is refused.
 */
export type PageAction =
  | { type: 'clickTab'; text: string; label: string; /** Caption of the site's Next button, pressed to reach the tab when tabs do not open on a click. */ next?: string }
  | { type: 'clickButton'; text: string; label: string }
  | { type: 'setField'; field: string; value: string; label: string; /** The control's id on the site, tried before the label. */ id?: string }
  | { type: 'ensureRows'; headers: string[]; count: number; addButton?: string; label: string }
  | { type: 'setCell'; headers: string[]; row: number; column: string; value: string; optionMatch?: string; label: string }
  | { type: 'addTariffItem'; code: string; tariff: string | null; /** Pattern for the site's tariff-type option; null = not known, never guessed. */ tariffOption?: string | null; qty: number; amountClaimed: number; label: string };

export interface ActionResult {
  index: number;
  label: string;
  ok: boolean;
  message: string;
  /** Done, but the message says something the person should check. */
  warn?: boolean;
}

/** Identity of the record open on the page, read from its text (any tab). */
export interface PageIdentity {
  ipNumber: string | null;
  patientName: string | null;
}

/** The page's structure without any field values — for diagnosing a site profile. */
export interface PageOutline {
  url: string;
  title: string;
  tabs: string[];
  headings: string[];
  buttons: string[];
  labels: string[];
  fields: { tag: string; type: string; name: string; id: string; placeholder: string; label: string; state: string; attrs: string; path: string }[];
  selects: { name: string; id: string; label: string; options: string[] }[];
  tables: { headers: string[]; rows: number }[];
  /** Where each caption the site profile looks for sits in the page (element + ancestors). */
  captions: { probe: string; text: string; path: string; pointer: boolean }[];
  /** Things the page marks clickable that are not ordinary buttons or links. */
  clickables: { text: string; path: string }[];
  frames: number;
  shadowHosts: number;
}

/** What content.js installs on its isolated-world global (never visible to page scripts). */
export interface PageAgent {
  scan(): FieldDescriptor[];
  fill(assignments: FillAssignment[]): FillOutcome[];
  highlight(ref: string | null): void;
  clear(): void;
  runActions(actions: PageAction[]): Promise<ActionResult[]>;
  readIdentity(): PageIdentity;
  describePage(probes?: string[]): PageOutline;
}
