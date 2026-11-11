// Response shapes of the backend API (backend/src/routes/*). Shared by the
// dashboard and the extension panel.

export type DocumentStatus = 'uploaded' | 'processing' | 'extracting' | 'validating' | 'completed' | 'failed';

/** Admin = the Main Admin (every unit); UnitAdmin manages one unit; User their own work. */
export type Role = 'Admin' | 'UnitAdmin' | 'User';

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  /** The hospital unit's code (HTC, SMJ, SEC, MLK); null for the Main Admin or a user not yet given one. */
  unit?: string | null;
}

/** GET /api/units — the hospital's units. */
export interface Unit {
  code: string;
  name: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface DocumentDto {
  id: string;
  fileName: string;
  fileSize: number;
  pageCount: number | null;
  status: DocumentStatus;
  failureReason: string | null;
  warnings: string[];
  fieldCount: number;
  avgConfidence: number | null;
  uploadedAt: string;
  processedAt: string | null;
  retentionExpiresAt: string | null;
  duplicateOf?: string | null;
  /** Recognised layout, e.g. 'yashoda-final-bill' / 'yashoda-summary-bill'. */
  docType: string | null;
  /** IP number read from a recognised bill. */
  ipNo: string | null;
  /** False once the PDF was deleted after reading (KEEP_PDF=false): no preview, no retry. */
  fileKept: boolean;
}

/** Where on the bill a check is about: which PDF, and its page (1 = first; null = the bill as a whole). */
export interface BillPlace {
  doc: 'final' | 'summary' | 'pharmacy';
  page: number | null;
}

/** One row of the TGNPDCL Pharmacy tab: an item issued (returns taken off), as the site's upload Excel has it. */
export interface TgnpdclPharmacyRow {
  /** yyyy-mm-dd: the indent's date. */
  date: string | null;
  name: string;
  /** Amount per item = the bill's Value ÷ Qty, to the paisa. */
  rate: number;
  qty: number;
  amount: number;
  /** ₹2,000 or more each: its physical pouches go with the original bill (the site's rule). */
  pouch: boolean;
  /** Page of the pharmacy bill PDF it is on (null from the Excel). */
  page: number | null;
}

export interface ClaimCheck {
  level: 'error' | 'warning' | 'info';
  message: string;
  /** Where on the bill — the panel opens that PDF there when the check is clicked. */
  at?: BillPlace;
}

/**
 * POST /api/claims/tgnpdcl (the bill PDFs, multipart) — what each TGNPDCL
 * bill-entry tab needs (backend/src/claims/tgnpdcl.js). The server keeps
 * neither the PDFs nor this result; the panel holds it while it fills.
 */
export interface TgnpdclClaim {
  /** The PDFs that were read. */
  documents: { fileName: string; docType: string | null; pageCount: number | null; error?: string }[];
  patient: { name?: string; ipNo?: string; consultant?: string; consultantSpeciality?: string; admission?: { date: string | null; time: string | null } | null; discharge?: { date: string | null; time: string | null } | null };
  hospitalBillNumber: string | null;
  tabs: {
    room: {
      /** Days charged as room rent (all wards); ICU days are separate. */
      roomDays: number;
      icuDays: number;
      wards: { ratePerDay: number; days: number; amount: number }[];
      doctors: { name: string; days: number; amount: number; review: boolean; notes: string[] }[];
      numberOfDoctors: number;
    };
    investigations: {
      /** One row per tariff code (repeated tests merged: qty and amount summed). manual = not searchable on the site. */
      items: {
        code: string | null; tariff: string | null; description: string; qty: number; amountClaimed: number; lines: number; review: boolean; manual: boolean; notes: string[];
        /** Other readings of the code's last character, where OCR cannot tell I from 1 (78I / 781) — the site's tariff list decides. */
        alternatives?: string[];
      }[];
      implants: { amount: number; note: string } | null;
      /** The hospital's own codes (YSSH): in no tariff list — entered on the site as non-tariff items. Identical lines are one row. */
      ownItems?: { code: string; description: string; qty: number; rate: number | null; amountClaimed: number; lines: number; notes: string[] }[];
    };
    /**
     * total: the final bill's PHARMACY amount. rows: from the pharmacy bill (PDF or the HIS Excel), when one
     * was chosen; file: those rows as the site's own upload Excel (base64), which "Fill" gives to the tab.
     */
    pharmacy: {
      total: number | null;
      rows: TgnpdclPharmacyRow[];
      note: string | null;
      bill: { issued: number | null; returned: number | null; net: number | null; source: 'pdf' | 'excel' } | null;
      file?: { fileName: string; base64: string };
    };
    summary: { employeePaid: number | null; concession: number; hospitalBillNumber: string | null };
  };
  totals: { billTotal: number; netAmount: number | null; filledByExtension: number; leftForManualEntry: number };
  checks: ClaimCheck[];
}

/**
 * POST /api/claims/pmjay (the bill PDFs, multipart) — the PM-JAY Treatment Plan
 * rows (backend/src/claims/pmjay.js): one per package code; the site prices them.
 * Kept by neither the server nor the panel beyond the browser session.
 */
export interface PmjayClaim {
  documents: { fileName: string; docType: string | null; pageCount: number | null; error?: string }[];
  patient: { name?: string; ipNo?: string; consultant?: string };
  hospitalBillNumber: string | null;
  /** units = how many times the bill charges the code; amountOnBill is for reference — the site uses its own rate. */
  procedures: { code: string; units: number; lines: number; amountOnBill: number; description: string; section: string; notes: string[] }[];
  /** Bill lines that cannot be picked by code (no code, or a combined one) — for the person. */
  manual: { section: string; description: string; count: number; amount: number; reason: string }[];
  totals: { billTotal: number; coded: number; notCoded: number };
  checks: ClaimCheck[];
}

/** One Bill Details row of the Coal India claim (backend/src/claims/cil.js). rate is the bill's (null when unreadable). */
export interface CilRow {
  code: string;
  description: string;
  /** Typed in Remarks of an Unlisted row (room rent: "ROOM RENT" — the site does not take it empty). */
  remarks?: string;
  qty: number;
  rate: number | null;
  amount: number;
  lines: number;
  section: string;
  notes: string[];
}

/**
 * POST /api/claims/cil (the bill PDFs, multipart) — the Bill Details tab of the
 * Coal India IP claim on e-Arogya Suvidha. Kept by neither the server nor the
 * panel beyond the browser session.
 */
export interface CilClaim {
  documents: { fileName: string; docType: string | null; pageCount: number | null; error?: string }[];
  patient: { name?: string; ipNo?: string; company?: string; consultant?: string };
  hospitalBillNumber: string | null;
  /** The discharge date as the site writes it, dd-mm-yyyy. */
  billDate: string | null;
  /** CGHS List Items: CIL codes — the site names and prices them; the service goes in Remarks. */
  cghs: CilRow[];
  /** Unlisted Procedures: the hospital's own code (YSSH), the codes CIL takes as unlisted (BC002, BC006) and room rent (code "ROOM RENT") — code, name, quantity and rate typed. */
  unlisted: CilRow[];
  /** Doctor fees, lines without a code — for the person. */
  manual: { section: string; description: string; count: number; amount: number; reason: string }[];
  /** Room rent on the bill: filled under Unlisted Procedures, and entered by the person in Room Details on the Admission tab. */
  room: { days: number; amount: number } | null;
  /** Reaches Bill Details from the site's Pharmacy tab — only compared. */
  pharmacy: number | null;
  totals: { billTotal: number; netAmount: number | null; cghs: number; unlisted: number; manual: number };
  checks: ClaimCheck[];
}

/** One Bill Details row of the BHEL Upload Bill screen (backend/src/claims/bhel.js): a Service Type and the bill's total for it. */
export interface BhelRow {
  /** As the site's Service Type list writes it ("Pathology BHEL"). */
  serviceType: string;
  /** The fixed text the client types for this type ("LAB INVESTIGATIONS"). */
  remarks: string;
  qty: number;
  /** Whole rupees, as typed in Amount. */
  amount: number;
  /** The bill's exact total for the sections in this row. */
  billAmount: number;
  /** The bill's sections in this row ("LABORATORY / HAEMATOLOGY"). */
  sections: string[];
  /** One of several rows of its Service Type (Other Unlisted Item): told apart from the others by Remarks. */
  byRemarks?: boolean;
}

/**
 * POST /api/claims/bhel (the bill PDFs, multipart) — the BHEL claim's Upload Bill screen on KareXpert:
 * Patient Details and one Bill Details row per Service Type. Kept by neither the server nor the
 * panel beyond the browser session.
 */
export interface BhelClaim {
  documents: { fileName: string; docType: string | null; pageCount: number | null; error?: string }[];
  patient: { name?: string; ipNo?: string; company?: string; consultant?: string };
  /** The IP number. */
  visitId: string | null;
  /** The summary bill's invoice number (ICO…). */
  billNo: string | null;
  /** dd/mm/yyyy hh:mm, as the site's date boxes show it: D.O.A, D.O.D, and D.O.D again for the bill. */
  visitDateTime: string | null;
  dischargeDateTime: string | null;
  billDateTime: string | null;
  rows: BhelRow[];
  /** Sections left for the person — none since 2026-11-11 (the rest go under Other Unlisted Item); kept for bills read before. */
  manual: { section: string; amount: number; reason: string }[];
  totals: { billTotal: number; netAmount: number | null; rows: number; manual: number };
  checks: ClaimCheck[];
}

/**
 * POST /api/claims/tgnpdcl-pharmacy (the pharmacy bill alone: its PDF or the HIS Excel) — TGNPDCL's own
 * pharmacy upload Excel and what is in it, for the site's "Upload Excel" on "3. Pharmacy". The same rows
 * as the TGNPDCL bill view's Pharmacy tab. Kept by neither the server nor the panel.
 */
export interface TgnpdclPharmacySheet {
  documents: { fileName: string; docType: string | null; pageCount: number | null }[];
  patient: { name?: string | null; ipNo?: string | null };
  rows: TgnpdclPharmacyRow[];
  bill: { issued: number | null; returned: number | null; net: number | null; source: 'pdf' | 'excel' };
  checks: ClaimCheck[];
  /** The upload Excel (base64); absent when the bill has no item to enter. */
  file?: { fileName: string; base64: string };
}

/** TARIFF_TYPE of the SPDCL upload file (column A), as the template's dropdown lists them. */
export type SpdclTariff = 'CGHS' | 'EHS' | 'NIMS_2015' | 'COVID_TARIFF';

/** One row of the SPDCL upload file (backend/src/claims/spdcl.js). Amount = rate × qty. */
export interface SpdclRow {
  /** Service_Type, spelled as SPDCL's "Heads" list ("Emergency  " has two trailing spaces). */
  head: string;
  code: string | null;
  description: string;
  /** dd/mm/yyyy; null only when no date could be worked out. */
  date: string | null;
  rate: number;
  qty: number;
  amount: number;
  /** The final-bill section it came from, or "Pharmacy". */
  section: string;
}

/**
 * POST /api/claims/spdcl (the HIS final bill and pharmacy bill .xlsx, multipart;
 * optional admissionDate and tariffType) — the SPDCL upload file, ready to save,
 * and what is in it. Kept by neither the server nor the panel.
 */
export interface SpdclSheet {
  documents: { fileName: string; kind: 'final-bill' | 'pharmacy-bill' }[];
  patient: { name: string | null; ipNo: string | null };
  tariffType: SpdclTariff;
  /** dd/mm/yyyy: typed by the person, or (admissionAssumed) the earliest date on the bills. */
  admissionDate: string | null;
  admissionAssumed: boolean;
  lastDate: string | null;
  /** ICU + room-rent days: what "N Time(s)" lines are spread over. */
  stayDays: number;
  rows: SpdclRow[];
  heads: { head: string; rows: number; amount: number }[];
  /** excel: the file's Total Amount (returns taken off); hisBill: the final bill's Grand Total; difference = hisBill − excel. */
  totals: { excel: number; hisBill: number | null; netAmount: number | null; pharmacyBill: number | null; difference: number };
  checks: ClaimCheck[];
  fileName: string;
  fileBase64: string;
}

/** TARIFF_TYPE of TG Transco's bill template (column B), as its dropdown lists them. */
export type TgTranscoTariff =
  | 'CGHS NABH' | 'CGHS NON-NABH' | 'CGHS SUPERSPECIALITY' | 'EHS SUPERSPECIALITY'
  | 'EHS NON-SUPERSPECIALITY' | 'NIMS 2015' | 'TATAMEMORIAL' | 'NOT LISTED';

/** One row of TG Transco's bill file (backend/src/claims/tgtransco.js). Amount = rate × qty. */
export interface TgTranscoRow {
  /** Service_Type, as the template's list: ROOM RENT, CONSULTATION, INVESTIGATIONS, SURGERY CHARGES, PHARMACY, OTHERS… */
  head: string;
  /** PACKAGE for surgery and implants and for rows on or after the date of surgery. */
  packageType: 'PACKAGE' | 'NON PACKAGE';
  /** The bill's code without its tariff mark (3055/NIMS → 3055). */
  code: string | null;
  description: string;
  /** dd.mm.yyyy; null when not known (surgery rows before the date of surgery is given). */
  date: string | null;
  rate: number;
  qty: number;
  amount: number;
  /** The final-bill section it came from, or "Pharmacy". */
  section: string;
}

/**
 * POST /api/claims/tgtransco (the HIS final bill and pharmacy bill .xlsx, multipart;
 * optional admissionDate, dischargeDate, surgeryDate as dd/mm/yyyy, and tariffType) —
 * TG Transco's bill file, ready to save, and what is in it. Kept by neither the server nor the panel.
 */
export interface TgTranscoSheet {
  documents: { fileName: string; kind: 'final-bill' | 'pharmacy-bill' }[];
  patient: { name: string | null; ipNo: string | null };
  tariffType: TgTranscoTariff;
  /** dd.mm.yyyy: typed by the person, or (admissionAssumed) the earliest date on the bills. */
  admissionDate: string | null;
  admissionAssumed: boolean;
  /** dd.mm.yyyy as typed; the bills do not have it. */
  dischargeDate: string | null;
  /** dd.mm.yyyy: typed, or (surgeryAssumed) the date on the bill's surgery lines. */
  surgeryDate: string | null;
  surgeryAssumed: boolean;
  lastDate: string | null;
  stayDays: number;
  rows: TgTranscoRow[];
  heads: { head: string; rows: number; amount: number }[];
  /** excel: the file's total (returns taken off); package: its PACKAGE rows; hisBill: the final bill's Grand Total; difference = hisBill − excel. */
  totals: { excel: number; package: number; hisBill: number | null; netAmount: number | null; pharmacyBill: number | null; difference: number };
  checks: ClaimCheck[];
  fileName: string;
  fileBase64: string;
}

export interface UploadResponse {
  documents: DocumentDto[];
  rejected: { fileName: string; error: string }[];
}

export type ValueType = 'text' | 'date' | 'phone' | 'email' | 'amount' | 'number' | 'gender';

export interface ExtractedField {
  id: number;
  documentId: string;
  fieldKey: string;
  canonicalKey: string | null;
  label: string;
  valueRaw: string;
  valueNormalized: string | null;
  valueType: ValueType;
  confidence: number;
  method: string;
  page: number | null;
  validation: { problems?: string[]; alternates?: { value: string; page: number }[] };
  edited: boolean;
}

export interface ExtractedTable {
  id: number;
  page: number;
  headers: string[];
  rows: string[][];
}

/** The sites whose bills FillPilot reads (BILLS_READ in the activity log). */
export type BillSite = 'tgnpdcl' | 'pmjay' | 'cil' | 'bhel' | 'spdcl' | 'tgnpdcl-pharmacy' | 'tgtransco';

/** GET /api/dashboard/stats — the caller's own work; one final + summary bill read = 1 bill. */
export interface DashboardStats {
  today: { bills: number; pdfs: number };
  last30Days: {
    bills: { tgnpdcl: number; pmjay: number; cil: number; bhel: number; total: number };
    pdfs: number;
    pages: number;
    fills: number;
    stepsDone: number;
    stepsFailed: number;
  };
  recentBills: { site: BillSite; pdfs: number; pages: number; at: string }[];
}

export type MatchSource = 'saved' | 'exact' | 'alias' | 'similar' | 'manual';
export type MatchStatus = 'matched' | 'review' | 'unmatched';

export interface MatchCandidate {
  fieldId: number;
  documentId: string;
  fieldKey: string;
  label: string;
  originalValue: string;
  confidence: number;
  source: MatchSource;
  fillValue?: string | null;
}

export interface MatchedField {
  ref: string;
  frameId: number;
  label: string;
  webType: string;
  required: boolean;
  signature: string;
  status: MatchStatus;
  include: boolean;
  selected: MatchCandidate | null;
  candidates: MatchCandidate[];
  warnings: string[];
}

export interface AvailableField {
  fieldId: number;
  documentId: string;
  fieldKey: string;
  canonicalKey: string | null;
  label: string;
  value: string;
  confidence: number;
}

export interface MatchResponse {
  formKey: string;
  documents: { id: string; fileName: string }[];
  summary: { detected: number; matched: number; review: number; unmatched: number };
  fields: MatchedField[];
  notFound: { fieldId: number; fieldKey: string; label: string }[];
  availableFields: AvailableField[];
}

export interface FormatResponse {
  fieldId: number;
  originalValue: string;
  fillValue: string | null;
  warnings: string[];
  problem: string | null;
}

export interface AllowedSite {
  id: number;
  origin: string;
  displayName: string;
  isActive: boolean;
  createdAt: string;
}

export interface FormMapping {
  id: number;
  origin: string;
  formKey: string;
  webFieldSignature: string;
  webFieldLabel: string;
  fieldKey: string;
  canonicalKey: string | null;
  useCount: number;
  createdBy: string | null;
  createdAt: string;
}

export interface FieldAlias {
  id: number;
  canonicalKey: string;
  alias: string;
}

export interface FillSession {
  id: number;
  user: string | null;
  /** The user's unit. */
  unit?: string | null;
  documentIds: string[];
  documentNames: string[];
  origin: string;
  path: string | null;
  formTitle: string | null;
  detected: number;
  autoMatched: number;
  reviewed: number;
  filled: number;
  failed: number;
  skipped: number;
  createdAt: string;
  fields?: { label: string; fieldKey: string | null; confidence: number | null; source: string | null; outcome: string }[];
}

export interface AuditLogEntry {
  id: number;
  action: string;
  actor: string | null;
  target: string | null;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

/** GET /api/reports/team — one row per person, counts only. */
export interface TeamReportRow {
  userId: number;
  username: string;
  fullName: string;
  role: Role;
  unit: string | null;
  isActive: boolean;
  /** Patients' bills read (one final + summary bill = 1), per site. */
  bills: { tgnpdcl: number; pmjay: number; cil: number; bhel: number; total: number };
  pdfs: number;
  pages: number;
  /** PDFs uploaded for the other (any-PDF) mode. */
  uploads: number;
  /** Times Fill was pressed, and the steps it did and could not do. */
  fills: number;
  stepsDone: number;
  stepsFailed: number;
  lastActive: string | null;
}

export interface TeamReport {
  from: string;
  to: string;
  /** The unit reported on; null = every unit. */
  unit?: string | null;
  rows: TeamReportRow[];
}

export interface ManagedUser extends User {
  isActive: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
