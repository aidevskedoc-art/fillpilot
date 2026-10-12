const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { logAction } = require('../audit-log');
const { saveFile, absolutePath } = require('../storage');
const { removeDocument } = require('../retention');
const { enqueue } = require('../extraction/pipeline');
const { typeValue } = require('../extraction/normalize');
const { getAliasIndex } = require('../aliases');
const { normLabel, toFieldKey } = require('../text/labels');
const { route, httpError, loadOwnDocument, documentToApi, fieldToApi } = require('./helpers');

const router = express.Router();

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 20;
const MAX_FILES = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FILES },
});

const STATUSES = ['uploaded', 'processing', 'extracting', 'validating', 'completed', 'failed'];
const IN_PROGRESS = ['uploaded', 'processing', 'extracting', 'validating'];

function retentionDate() {
  const days = Number(process.env.RETENTION_DAYS) || 0;
  return days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
}

// POST /api/documents — multipart "files" (1..10 PDFs). 202: processing continues in the background.
router.post('/', upload.array('files', MAX_FILES), route(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Attach at least one PDF in the "files" field' });

  const accepted = [];
  const rejected = [];
  for (const file of files) {
    const fileName = String(file.originalname || 'document.pdf').slice(0, 255);
    // Trust the bytes, not the extension or the browser's mime type.
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      rejected.push({ fileName, error: 'Not a PDF file' });
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const { rows: dupes } = await db.query(
      'SELECT id FROM documents WHERE user_id = $1 AND sha256 = $2 ORDER BY uploaded_at DESC LIMIT 1',
      [req.user.sub, sha256],
    );
    const id = crypto.randomUUID();
    const storagePath = await saveFile(`${id}.pdf`, file.buffer);
    const { rows } = await db.query(
      `INSERT INTO documents (id, user_id, file_name, file_size, sha256, storage_path, retention_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, req.user.sub, fileName, file.size, sha256, storagePath, retentionDate()],
    );
    await logAction({ actorUserId: req.user.sub, entityType: 'document', entityId: id, action: 'DOCUMENT_UPLOADED', details: { fileName, size: file.size }, req });
    enqueue(id);
    accepted.push({ ...documentToApi(rows[0]), duplicateOf: dupes[0]?.id || null });
  }
  res.status(accepted.length ? 202 : 400).json({ documents: accepted, rejected });
}));

// GET /api/documents?status=&q=&limit=
router.get('/', route(async (req, res) => {
  const params = [req.user.sub];
  const where = ['user_id = $1'];
  if (req.query.status) {
    const statuses = String(req.query.status).split(',').filter((s) => STATUSES.includes(s));
    if (statuses.length) {
      params.push(statuses);
      where.push(`status = ANY($${params.length})`);
    }
  }
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where.push(`file_name ILIKE $${params.length}`);
  }
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const { rows } = await db.query(
    `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY uploaded_at DESC LIMIT ${limit}`,
    params,
  );
  res.json(rows.map(documentToApi));
}));

router.get('/:id', route(async (req, res) => {
  res.json(documentToApi(await loadOwnDocument(req, req.params.id)));
}));

// The PDF itself, for side-by-side review in the dashboard.
router.get('/:id/file', route(async (req, res) => {
  const doc = await loadOwnDocument(req, req.params.id);
  if (!doc.file_kept) throw httpError(404, 'The PDF is not kept once its data has been read. Upload it again if you need it.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.file_name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(absolutePath(doc.storage_path));
}));

router.get('/:id/fields', route(async (req, res) => {
  await loadOwnDocument(req, req.params.id);
  const { rows } = await db.query('SELECT * FROM extracted_fields WHERE document_id = $1 ORDER BY sort_order, id', [req.params.id]);
  res.json(rows.map(fieldToApi));
}));

// The document in its real shape when its layout is known (e.g. a Yashoda
// final bill's sections and items, with the arithmetic checks), else 404.
router.get('/:id/structured', route(async (req, res) => {
  const doc = await loadOwnDocument(req, req.params.id);
  if (!doc.structured) throw httpError(404, 'This document has no recognised layout');
  res.json({ docType: doc.doc_type, ...doc.structured });
}));

router.get('/:id/tables', route(async (req, res) => {
  await loadOwnDocument(req, req.params.id);
  const { rows } = await db.query('SELECT id, page, headers, rows FROM extracted_tables WHERE document_id = $1 ORDER BY page, id', [req.params.id]);
  res.json(rows);
}));

// The structured JSON view: { patientName: "…", policyNumber: "…", … }.
// Canonical key when the label is a known alias, otherwise the PDF's own label as camelCase.
router.get('/:id/json', route(async (req, res) => {
  await loadOwnDocument(req, req.params.id);
  const { rows } = await db.query(
    'SELECT * FROM extracted_fields WHERE document_id = $1 ORDER BY confidence DESC, sort_order',
    [req.params.id],
  );
  const json = {};
  for (const f of rows) {
    const key = f.canonical_key || f.field_key;
    if (!(key in json)) json[key] = f.value_normalized || f.value_raw;
  }
  res.json(json);
}));

async function typedFieldValues(label, value) {
  const aliasIndex = await getAliasIndex();
  const typed = typeValue(label, value);
  return {
    canonicalKey: aliasIndex.get(normLabel(label)) || null,
    valueNormalized: typed.normalized,
    valueType: typed.valueType,
    validation: typed.validation,
  };
}

// PATCH /api/documents/:id/fields/:fieldId { label?, value? } — a user correction (confidence becomes 1).
router.patch('/:id/fields/:fieldId', route(async (req, res) => {
  await loadOwnDocument(req, req.params.id);
  const { rows: existing } = await db.query('SELECT * FROM extracted_fields WHERE id = $1 AND document_id = $2', [Number(req.params.fieldId), req.params.id]);
  const field = existing[0];
  if (!field) throw httpError(404, 'Field not found');

  const label = req.body?.label !== undefined ? String(req.body.label).trim() : field.label;
  const value = req.body?.value !== undefined ? String(req.body.value).trim() : field.value_raw;
  if (!label) return res.status(400).json({ error: 'Label cannot be empty' });
  const typed = await typedFieldValues(label, value);

  const { rows } = await db.query(
    `UPDATE extracted_fields
        SET label = $2, field_key = $3, canonical_key = $4, value_raw = $5, value_normalized = $6, value_type = $7,
            validation = $8::jsonb, confidence = 1, edited_by = $9, edited_at = now()
      WHERE id = $1 RETURNING *`,
    [field.id, label, toFieldKey(label), typed.canonicalKey, value, typed.valueNormalized, typed.valueType, JSON.stringify(typed.validation), req.user.sub],
  );
  await logAction({ actorUserId: req.user.sub, entityType: 'document', entityId: req.params.id, action: 'FIELD_EDITED', details: { fieldId: field.id, label }, req });
  res.json(fieldToApi(rows[0]));
}));

// POST /api/documents/:id/fields { label, value } — add a field the extractor missed.
router.post('/:id/fields', route(async (req, res) => {
  const doc = await loadOwnDocument(req, req.params.id);
  if (doc.status !== 'completed') return res.status(409).json({ error: 'Wait for processing to finish before adding fields' });
  const label = String(req.body?.label || '').trim();
  const value = String(req.body?.value || '').trim();
  if (!label || !value) return res.status(400).json({ error: 'Label and value are required' });
  const typed = await typedFieldValues(label, value);

  const { rows } = await db.query(
    `INSERT INTO extracted_fields
       (document_id, field_key, canonical_key, label, value_raw, value_normalized, value_type, confidence, method, validation, sort_order, edited_by, edited_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'manual', $8::jsonb,
             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM extracted_fields WHERE document_id = $1), $9, now())
     RETURNING *`,
    [doc.id, toFieldKey(label), typed.canonicalKey, label, value, typed.valueNormalized, typed.valueType, JSON.stringify(typed.validation), req.user.sub],
  );
  await db.query('UPDATE documents SET field_count = field_count + 1 WHERE id = $1', [doc.id]);
  await logAction({ actorUserId: req.user.sub, entityType: 'document', entityId: doc.id, action: 'FIELD_ADDED', details: { label }, req });
  res.status(201).json(fieldToApi(rows[0]));
}));

router.delete('/:id/fields/:fieldId', route(async (req, res) => {
  await loadOwnDocument(req, req.params.id);
  const { rowCount } = await db.query('DELETE FROM extracted_fields WHERE id = $1 AND document_id = $2', [Number(req.params.fieldId), req.params.id]);
  if (!rowCount) throw httpError(404, 'Field not found');
  await db.query('UPDATE documents SET field_count = GREATEST(field_count - 1, 0) WHERE id = $1', [req.params.id]);
  await logAction({ actorUserId: req.user.sub, entityType: 'document', entityId: req.params.id, action: 'FIELD_DELETED', details: { fieldId: Number(req.params.fieldId) }, req });
  res.status(204).end();
}));

// POST /api/documents/:id/retry — re-runs extraction (also picks up alias dictionary changes).
router.post('/:id/retry', route(async (req, res) => {
  const doc = await loadOwnDocument(req, req.params.id);
  if (IN_PROGRESS.includes(doc.status)) return res.status(409).json({ error: 'The document is already being processed' });
  if (!doc.file_kept) return res.status(409).json({ error: 'The PDF was not kept after it was read — upload it again to read it again' });
  const { rows } = await db.query(
    `UPDATE documents SET status = 'uploaded', failure_reason = NULL WHERE id = $1 RETURNING *`,
    [doc.id],
  );
  await logAction({ actorUserId: req.user.sub, entityType: 'document', entityId: doc.id, action: 'DOCUMENT_RETRIED', req });
  enqueue(doc.id);
  res.status(202).json(documentToApi(rows[0]));
}));

// Removes the document and everything read from it. The log keeps that a
// document was deleted, not its name.
router.delete('/:id', route(async (req, res) => {
  const doc = await loadOwnDocument(req, req.params.id);
  await removeDocument(doc);
  await logAction({ actorUserId: req.user.sub, entityType: 'document', entityId: doc.id, action: 'DOCUMENT_DELETED', req });
  res.status(204).end();
}));

module.exports = router;
