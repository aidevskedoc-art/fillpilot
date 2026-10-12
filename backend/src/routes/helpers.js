const db = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wraps an async handler so a rejected promise reaches Express's error handler. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** The caller's own document, or a 404 — never reveals that someone else's id exists. */
async function loadOwnDocument(req, id) {
  if (!UUID_RE.test(String(id))) throw httpError(404, 'Document not found');
  const { rows } = await db.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, req.user.sub]);
  if (!rows[0]) throw httpError(404, 'Document not found');
  return rows[0];
}

function documentToApi(d) {
  return {
    id: d.id,
    fileName: d.file_name,
    fileSize: d.file_size,
    pageCount: d.page_count,
    status: d.status,
    failureReason: d.failure_reason,
    warnings: d.warnings || [],
    fieldCount: d.field_count,
    avgConfidence: d.avg_confidence === null ? null : Number(d.avg_confidence),
    docType: d.doc_type ?? null,
    ipNo: d.structured?.patient?.ipNo ?? null,
    fileKept: d.file_kept !== false,
    uploadedAt: d.uploaded_at,
    processedAt: d.processed_at,
    retentionExpiresAt: d.retention_expires_at,
  };
}

function fieldToApi(f) {
  return {
    id: f.id,
    documentId: f.document_id,
    fieldKey: f.field_key,
    canonicalKey: f.canonical_key,
    label: f.label,
    valueRaw: f.value_raw,
    valueNormalized: f.value_normalized,
    valueType: f.value_type,
    confidence: Number(f.confidence),
    method: f.method,
    page: f.page,
    validation: f.validation || {},
    edited: Boolean(f.edited_at),
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

module.exports = { route, httpError, loadOwnDocument, documentToApi, fieldToApi, clampInt, UUID_RE };
