// Response shapes of the backend API (backend/src/routes/*). Shared by the
// dashboard and the extension panel.

export type DocumentStatus = 'uploaded' | 'processing' | 'extracting' | 'validating' | 'completed' | 'failed';

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: 'Admin' | 'User';
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

export interface ClaimCheck {
  level: 'error' | 'warning' | 'info';
  message: string;
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
    pharmacy: { total: number | null; rows: unknown[]; note: string | null };
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
export type BillSite = 'tgnpdcl' | 'pmjay' | 'cil';

/** GET /api/dashboard/stats — the caller's own work; one final + summary bill read = 1 bill. */
export interface DashboardStats {
  today: { bills: number; pdfs: number };
  last30Days: {
    bills: { tgnpdcl: number; pmjay: number; cil: number; total: number };
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
  role: 'Admin' | 'User';
  isActive: boolean;
  /** Patients' bills read (one final + summary bill = 1), per site. */
  bills: { tgnpdcl: number; pmjay: number; cil: number; total: number };
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
  rows: TeamReportRow[];
}

export interface ManagedUser extends User {
  isActive: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
