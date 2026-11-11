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
  | {
    type: 'setField'; field: string; value: string; label: string;
    /** The control's id on the site, tried before the label. */ id?: string;
    /** A date box locked for typing because a calendar fills it: the value is written as the calendar would. */ calendar?: boolean;
  }
  | { type: 'ensureRows'; headers: string[]; count: number; addButton?: string; label: string }
  | { type: 'setCell'; headers: string[]; row: number; column: string; value: string; optionMatch?: string; label: string }
  | { type: 'addTariffItem'; code: string; tariff: string | null; /** Pattern for the site's tariff-type option; null = not known, never guessed. */ tariffOption?: string | null;
      /** Further tariff types to search, in order, when the code is not in the first (EHS codes: Ax-III, then Ax-II). */ moreTariffOptions?: string[];
      qty: number; amountClaimed: number; label: string;
      /** Other readings of the code (78I / 781): tried when the bill's reading is not in the list or its price is not the bill's rate. */ alternatives?: string[] }
  /** PM-JAY Treatment Plan: pick the procedure listed as "Name(code-…)", set Days/Units, press "+". */
  | { type: 'addProcedure'; code: string; units: number; label: string }
  /**
   * Coal India Bill Details: one row under the "Category -: …" heading that `section`
   * names. CGHS rows: the site names and prices the code; `remarks` gets the service.
   * Unlisted rows: `name` and the bill's `rate` are typed. `amount` is the bill's, to compare.
   */
  | { type: 'addCilRow'; section: 'cghs' | 'unlisted'; code: string; qty: number; rate: number | null; amount: number; name?: string; remarks?: string; label: string }
  /** Coal India Bill Details: the site's Pharmacy Amount and Grand Total against the bill. */
  | { type: 'checkCilTotals'; netAmount: number | null; pharmacy: number | null; notFilled: number; label: string }
  /**
   * TGNPDCL Pharmacy tab: gives the upload Excel (base64) to the tab's file box, as choosing the file after
   * "Upload Excel" does — that button is never pressed — then checks the table under `headers` shows `rows`
   * items worth `total`. Not done when the table has items already, so nothing goes in twice.
   */
  | { type: 'loadPharmacyExcel'; fileName: string; base64: string; rows: number; total: number; headers: string[]; label: string }
  /**
   * A date-and-time box with a calendar (BHEL KareXpert): typed as a person types it, then the
   * calendar's own Apply, which is what puts the date into the site's form. `value` as the box shows it.
   */
  | { type: 'setDateTime'; field: string; id?: string; value: string; label: string }
  /**
   * BHEL KareXpert Bill Details: choose the Service Type (Service Item and Priority stay empty), type
   * Quantity (when the site shows it — not for Pharmacy), Amount, Discount 0 and Remarks, press that
   * section's "Add". Not added when the table below has a row of this Service Type already — with
   * these Remarks too when `byRemarks` (Other Unlisted Item: one row per bill section).
   */
  | { type: 'addBhelRow'; serviceType: string; qty: number; amount: number; remarks: string; byRemarks?: boolean; label: string }
  /** BHEL Billing Summary: the site's Total Amount against the rows filled and the bill's net amount. */
  | { type: 'checkBhelTotals'; rowsTotal: number; netAmount: number | null; notFilled: number; label: string };

/**
 * Where a step's work is on the page, found again by its labels and codes when
 * the person asks to see it — the site may have redrawn the page since.
 */
export type PageSpot =
  | { kind: 'field'; field: string; id?: string }
  | { kind: 'cell'; headers: string[]; row: number; column: string }
  /** A row of entered items with a Code column (TGNPDCL Investigations): the first of these readings that is there. */
  | { kind: 'codeRow'; codes: string[] }
  /** A PM-JAY Treatment Plan row, by the procedure's name as the site lists it. */
  | { kind: 'procedure'; name: string }
  /** A Coal India Bill Details row; `service` tells apart rows with the same code (YSSH). */
  | { kind: 'cilRow'; section: 'cghs' | 'unlisted'; code: string; service?: string }
  | { kind: 'cilTotals' }
  /** A whole table, by its column headings (the TGNPDCL pharmacy table). */
  | { kind: 'table'; headers: string[] }
  /** A row of the BHEL Bill Details table, by its Service Type (and its Remarks, where one type has several rows). */
  | { kind: 'bhelRow'; serviceType: string; remarks?: string };

export interface ActionResult {
  index: number;
  label: string;
  ok: boolean;
  message: string;
  /** Done, but the message says something the person should check. */
  warn?: boolean;
  /** Nothing was added: the row looked to be on the page already (the message says which). */
  skipped?: boolean;
  /** The page is not as the site profile expects — the steps after this one would fail the same way. */
  stopped?: boolean;
  /** Where the step's row or field is — the panel scrolls the page there when the result is clicked. */
  spot?: PageSpot;
}

/** Identity of the record open on the page, read from its text (any tab). */
export interface PageIdentity {
  ipNumber: string | null;
  /** "Admission No" — the IP number under another name (Coal India's e-Arogya Suvidha). */
  admissionNumber?: string | null;
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
  /** Captionless icons (images, icon fonts) — what tells an "add row" icon from a "delete row" one. */
  icons?: { tag: string; attrs: string; path: string }[];
  /** File boxes, hidden ones too, and the captions beside them — which one an "Upload Excel" button opens. */
  fileBoxes?: { accept: string; id: string; name: string; multiple: boolean; hidden: boolean; attrs: string; path: string; near: string }[];
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
  /** Scrolls to a step's row or field and outlines it. → false when it is not on the page now. */
  show(spot: PageSpot): boolean;
  readIdentity(): PageIdentity;
  describePage(probes?: string[]): PageOutline;
}
