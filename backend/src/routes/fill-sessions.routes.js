// Audit of form-filling activity, written by the extension after "Fill Form".
// Labels, keys, confidences and outcomes only — never the values filled.
// A failed step also carries its reason and, for site profiles, the page's
// structure at that moment (captions, labels, column headings).
const express = require('express');
const db = require('../db');
const { logAction } = require('../audit-log');
const { route, httpError, clampInt, UUID_RE } = require('./helpers');

const router = express.Router();

const OUTCOMES = ['filled', 'failed', 'skipped'];
const MAX_OUTLINE_CHARS = 400_000;

/** The outline as JSON text, or null when absent or implausibly large. */
function outlineJson(outline) {
  if (!outline || typeof outline !== 'object') return null;
  const json = JSON.stringify(outline);
  return json.length <= MAX_OUTLINE_CHARS ? json : null;
}

function toApi(r) {
  return {
    id: r.id,
    user: r.full_name || null,
    documentIds: r.document_ids,
    documentNames: r.document_names || [],
    origin: r.origin,
    path: r.path,
    formTitle: r.form_title,
    detected: r.detected,
    autoMatched: r.auto_matched,
    reviewed: r.reviewed,
    filled: r.filled,
    failed: r.failed,
    skipped: r.skipped,
    createdAt: r.created_at,
  };
}

// POST { documentIds, origin, path, formTitle, detected, autoMatched, pageOutline?,
//        fields: [{ label, fieldKey, confidence, source, outcome, message? }] }
router.post('/', route(async (req, res) => {
  const b = req.body || {};
  const documentIds = Array.isArray(b.documentIds) ? b.documentIds.map(String).filter((id) => UUID_RE.test(id)) : [];
  const fields = Array.isArray(b.fields) ? b.fields.slice(0, 500) : [];
  // documentIds may be empty: a site profile fills from bills that were read without being stored.
  if (!b.origin) return res.status(400).json({ error: 'origin is required' });
  if (fields.some((f) => !OUTCOMES.includes(f.outcome))) return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });

  const count = (o) => fields.filter((f) => f.outcome === o).length;
  const session = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO fill_sessions (user_id, document_ids, origin, path, form_title, detected, auto_matched, reviewed, filled, failed, skipped, page_outline)
       VALUES ($1, $2::uuid[], $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) RETURNING *`,
      [
        req.user.sub,
        documentIds,
        String(b.origin).slice(0, 255),
        b.path ? String(b.path).slice(0, 1000) : null,
        b.formTitle ? String(b.formTitle).slice(0, 300) : null,
        Number(b.detected) || fields.length,
        Number(b.autoMatched) || 0,
        fields.filter((f) => f.source === 'manual' || f.reviewed).length,
        count('filled'),
        count('failed'),
        count('skipped'),
        outlineJson(b.pageOutline),
      ],
    );
    if (fields.length) {
      await client.query(
        `INSERT INTO fill_session_fields (session_id, web_field_label, field_key, confidence, source, outcome, message)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::numeric[], $5::text[], $6::text[], $7::text[])`,
        [
          rows[0].id,
          fields.map((f) => String(f.label || '').slice(0, 300)),
          fields.map((f) => (f.fieldKey ? String(f.fieldKey).slice(0, 120) : null)),
          fields.map((f) => (Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null)),
          fields.map((f) => (f.source ? String(f.source).slice(0, 20) : null)),
          fields.map((f) => f.outcome),
          fields.map((f) => (f.message ? String(f.message).slice(0, 1500) : null)),
        ],
      );
    }
    return rows[0];
  });

  await logAction({
    actorUserId: req.user.sub,
    entityType: 'fill_session',
    entityId: session.id,
    action: 'FORM_FILLED',
    details: { origin: session.origin, path: session.path, filled: session.filled, failed: session.failed, skipped: session.skipped },
    req,
  });
  res.status(201).json(toApi(session));
}));

const LIST_SQL = `
  SELECT s.*, u.full_name,
         (SELECT array_agg(d.file_name) FROM documents d WHERE d.id = ANY(s.document_ids)) AS document_names
    FROM fill_sessions s JOIN users u ON u.id = s.user_id`;

// GET ?limit= — own sessions; an Admin sees everyone's with ?all=true.
router.get('/', route(async (req, res) => {
  const all = req.user.role === 'Admin' && req.query.all === 'true';
  const limit = clampInt(req.query.limit, 1, 500, 100);
  const { rows } = await db.query(
    `${LIST_SQL} ${all ? '' : 'WHERE s.user_id = $1'} ORDER BY s.created_at DESC LIMIT ${limit}`,
    all ? [] : [req.user.sub],
  );
  res.json(rows.map(toApi));
}));

router.get('/:id', route(async (req, res) => {
  const { rows } = await db.query(`${LIST_SQL} WHERE s.id = $1`, [Number(req.params.id)]);
  const session = rows[0];
  if (!session || (session.user_id !== req.user.sub && req.user.role !== 'Admin')) throw httpError(404, 'Session not found');
  const { rows: fields } = await db.query(
    'SELECT web_field_label, field_key, confidence, source, outcome, message FROM fill_session_fields WHERE session_id = $1 ORDER BY id',
    [session.id],
  );
  res.json({
    ...toApi(session),
    pageOutline: session.page_outline,
    fields: fields.map((f) => ({
      label: f.web_field_label,
      fieldKey: f.field_key,
      confidence: f.confidence === null ? null : Number(f.confidence),
      source: f.source,
      outcome: f.outcome,
      message: f.message,
    })),
  });
}));

module.exports = router;
