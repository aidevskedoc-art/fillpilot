// Called by the extension: web form field descriptors in → proposed mappings out.
// Descriptors carry page labels only; values never leave the server except as
// the fill values for fields on an approved website.

const express = require('express');
const db = require('../db');
const { getAliasIndex } = require('../aliases');
const { matchForm, formKeyFor } = require('../matching/matcher');
const { formatFor } = require('../matching/value-formatter');
const { route, httpError, fieldToApi, UUID_RE } = require('./helpers');

const router = express.Router();

const MAX_DOCUMENTS = 5;
const MAX_FIELDS = 500;

/** The site must be on the admin-approved list — the extension checks too, this is the real gate. */
async function requireAllowedSite(origin) {
  const { rows } = await db.query('SELECT id FROM allowed_sites WHERE origin = $1 AND is_active', [String(origin || '')]);
  if (!rows[0]) throw httpError(403, `${origin || 'This website'} is not approved for form filling. Ask an administrator to add it under Mappings → Allowed sites.`);
}

async function loadFields(userId, documentIds) {
  const { rows: docs } = await db.query(
    `SELECT id, file_name, status FROM documents WHERE id = ANY($1::uuid[]) AND user_id = $2`,
    [documentIds, userId],
  );
  if (docs.length !== documentIds.length) throw httpError(404, 'Document not found');
  const notReady = docs.find((d) => d.status !== 'completed');
  if (notReady) throw httpError(409, `"${notReady.file_name}" has not finished processing`);
  const { rows } = await db.query(
    'SELECT * FROM extracted_fields WHERE document_id = ANY($1::uuid[]) ORDER BY document_id, sort_order, id',
    [documentIds],
  );
  return { docs, fields: rows.map(fieldToApi) };
}

function sanitizeDescriptor(d) {
  const str = (v, max = 300) => (v === undefined || v === null ? undefined : String(v).slice(0, max));
  return {
    ref: str(d.ref, 64),
    frameId: Number.isInteger(d.frameId) ? d.frameId : 0,
    tag: str(d.tag, 16)?.toLowerCase(),
    type: str(d.type, 32)?.toLowerCase(),
    name: str(d.name),
    id: str(d.id),
    label: str(d.label),
    ariaLabel: str(d.ariaLabel),
    placeholder: str(d.placeholder),
    nearbyText: str(d.nearbyText),
    legend: str(d.legend),
    pattern: str(d.pattern),
    required: Boolean(d.required),
    maxLength: Number.isInteger(d.maxLength) && d.maxLength > 0 ? d.maxLength : undefined,
    options: Array.isArray(d.options) ? d.options.slice(0, 500).map((o) => ({ value: str(o.value), text: str(o.text) })) : undefined,
  };
}

function parseDocumentIds(body) {
  const ids = Array.isArray(body?.documentIds) ? body.documentIds.map(String) : [];
  if (!ids.length || ids.length > MAX_DOCUMENTS || !ids.every((id) => UUID_RE.test(id))) {
    throw httpError(400, `Choose 1–${MAX_DOCUMENTS} documents`);
  }
  return [...new Set(ids)];
}

// POST /api/match { documentIds, page: { origin, path, title }, fields: [descriptor] }
router.post('/', route(async (req, res) => {
  const documentIds = parseDocumentIds(req.body);
  const page = req.body?.page || {};
  const descriptors = Array.isArray(req.body?.fields) ? req.body.fields : [];
  if (!descriptors.length) return res.status(400).json({ error: 'No form fields were sent' });
  if (descriptors.length > MAX_FIELDS) return res.status(400).json({ error: `Too many fields (max ${MAX_FIELDS})` });
  await requireAllowedSite(page.origin);

  const { docs, fields } = await loadFields(req.user.sub, documentIds);
  const formKey = formKeyFor(page.path);
  const { rows: savedRows } = await db.query(
    'SELECT web_field_signature, field_key, canonical_key FROM form_mappings WHERE origin = $1 AND form_key = $2',
    [page.origin, formKey],
  );
  const saved = new Map(savedRows.map((r) => [r.web_field_signature, r]));

  const result = matchForm({
    descriptors: descriptors.map(sanitizeDescriptor).filter((d) => d.ref),
    fields,
    aliasIndex: await getAliasIndex(),
    saved,
  });

  res.json({
    formKey,
    documents: docs.map((d) => ({ id: d.id, fileName: d.file_name })),
    ...result,
    // Everything the user may pick from when mapping a field by hand.
    availableFields: fields.map((f) => ({
      fieldId: f.id,
      documentId: f.documentId,
      fieldKey: f.fieldKey,
      canonicalKey: f.canonicalKey,
      label: f.label,
      value: f.valueRaw,
      confidence: f.confidence,
    })),
  });
}));

// POST /api/match/format { fieldId, descriptor, origin } — the fill value after a manual mapping.
router.post('/format', route(async (req, res) => {
  await requireAllowedSite(req.body?.origin);
  const fieldId = Number(req.body?.fieldId);
  const { rows } = await db.query(
    `SELECT f.* FROM extracted_fields f JOIN documents d ON d.id = f.document_id
      WHERE f.id = $1 AND d.user_id = $2`,
    [fieldId, req.user.sub],
  );
  if (!rows[0]) throw httpError(404, 'Field not found');
  const descriptor = sanitizeDescriptor(req.body?.descriptor || {});
  const field = fieldToApi(rows[0]);
  const formatted = formatFor(descriptor, field);
  res.json({ fieldId, originalValue: field.valueRaw, ...formatted });
}));

module.exports = router;
module.exports.requireAllowedSite = requireAllowedSite;
