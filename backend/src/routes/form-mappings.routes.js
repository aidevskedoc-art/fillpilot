// Website + form + web field → PDF field, saved when a user confirms a manual
// mapping. Shared by everyone using that website: the next user gets it as a
// 100% "saved" match.

const express = require('express');
const db = require('../db');
const { logAction } = require('../audit-log');
const { formKeyFor } = require('../matching/matcher');
const { requireAllowedSite } = require('./match.routes');
const { route, httpError } = require('./helpers');

const router = express.Router();

function toApi(r) {
  return {
    id: r.id,
    origin: r.origin,
    formKey: r.form_key,
    webFieldSignature: r.web_field_signature,
    webFieldLabel: r.web_field_label,
    fieldKey: r.field_key,
    canonicalKey: r.canonical_key,
    useCount: r.use_count,
    createdBy: r.created_by_name || null,
    createdAt: r.created_at,
  };
}

router.get('/', route(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.origin) {
    params.push(String(req.query.origin));
    where = 'WHERE m.origin = $1';
  }
  const { rows } = await db.query(
    `SELECT m.*, u.full_name AS created_by_name FROM form_mappings m
       LEFT JOIN users u ON u.id = m.created_by ${where}
      ORDER BY m.origin, m.form_key, m.web_field_label`,
    params,
  );
  res.json(rows.map(toApi));
}));

// POST { origin, path, signature, webFieldLabel, fieldKey, canonicalKey }
router.post('/', route(async (req, res) => {
  const { origin, path, signature, webFieldLabel, fieldKey, canonicalKey } = req.body || {};
  if (!/^[0-9a-f]{16}$/.test(String(signature || ''))) return res.status(400).json({ error: 'Invalid field signature' });
  if (!fieldKey) return res.status(400).json({ error: 'fieldKey is required' });
  await requireAllowedSite(origin);
  const formKey = formKeyFor(path);

  const { rows } = await db.query(
    `INSERT INTO form_mappings (origin, form_key, web_field_signature, web_field_label, field_key, canonical_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (origin, form_key, web_field_signature)
     DO UPDATE SET field_key = EXCLUDED.field_key, canonical_key = EXCLUDED.canonical_key,
                   web_field_label = EXCLUDED.web_field_label, created_by = EXCLUDED.created_by, created_at = now()
     RETURNING *`,
    [origin, formKey, signature, String(webFieldLabel || '').slice(0, 300), String(fieldKey).slice(0, 120), canonicalKey || null, req.user.sub],
  );
  await logAction({ actorUserId: req.user.sub, entityType: 'form_mapping', entityId: rows[0].id, action: 'MAPPING_SAVED', details: { origin, formKey, webFieldLabel, fieldKey }, req });
  res.status(201).json(toApi(rows[0]));
}));

// POST /api/form-mappings/used { origin, path, signatures[] } — counts how often saved mappings were filled.
router.post('/used', route(async (req, res) => {
  const signatures = Array.isArray(req.body?.signatures) ? req.body.signatures.map(String).slice(0, 500) : [];
  if (signatures.length) {
    await db.query(
      `UPDATE form_mappings SET use_count = use_count + 1
        WHERE origin = $1 AND form_key = $2 AND web_field_signature = ANY($3::text[])`,
      [String(req.body?.origin || ''), formKeyFor(req.body?.path), signatures],
    );
  }
  res.status(204).end();
}));

router.delete('/:id', route(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM form_mappings WHERE id = $1', [Number(req.params.id)]);
  const mapping = rows[0];
  if (!mapping) throw httpError(404, 'Mapping not found');
  if (req.user.role !== 'Admin' && mapping.created_by !== req.user.sub) throw httpError(403, 'Only the creator or an Admin can delete this mapping');
  await db.query('DELETE FROM form_mappings WHERE id = $1', [mapping.id]);
  await logAction({ actorUserId: req.user.sub, entityType: 'form_mapping', entityId: mapping.id, action: 'MAPPING_DELETED', details: { origin: mapping.origin, fieldKey: mapping.field_key }, req });
  res.status(204).end();
}));

module.exports = router;
