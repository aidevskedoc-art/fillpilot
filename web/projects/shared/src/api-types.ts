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
      items: { code: string | null; tariff: string | null; description: string; qty: number; amountClaimed: number; lines: number; review: boolean; manual: boolean; notes: string[] }[];
      implants: { amount: number; note: string } | null;
    };
    pharmacy: { total: number | null; rows: unknown[]; note: string | null };
    summary: { employeePaid: number | null; concession: number; hospitalBillNumber: string | null };
  };
  totals: { billTotal: number; netAmount: number | null; filledByExtension: number; leftForManualEntry: number };
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

export interface DashboardStats {
  documents: { total: number; processed: number; pending: number; failed: number; avgConfidence: number | null };
  recent: DocumentDto[];
  last30Days: { fillSessions: number; fieldsFilled: number; fieldsDetected: number };
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

export interface ManagedUser extends User {
  isActive: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
