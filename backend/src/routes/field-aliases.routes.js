// The alias dictionary ("configured field-mapping rules"). Read: everyone. Edit: Admin.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { invalidateAliases } = require('../aliases');
const { normLabel } = require('../text/labels');
const { route, httpError } = require('./helpers');

const router = express.Router();

router.get('/', route(async (req, res) => {
  const { rows } = await db.query('SELECT id, canonical_key, alias FROM field_aliases ORDER BY canonical_key, alias');
  res.json(rows.map((r) => ({ id: r.id, canonicalKey: r.canonical_key, alias: r.alias })));
}));

router.post('/', requireAdmin, route(async (req, res) => {
  const canonicalKey = String(req.body?.canonicalKey || '').trim();
  const alias = String(req.body?.alias || '').trim();
  if (!/^[a-z][A-Za-z0-9]{1,79}$/.test(canonicalKey)) return res.status(400).json({ error: 'Canonical key must be camelCase, e.g. patientName' });
  if (!normLabel(alias)) return res.status(400).json({ error: 'Alias must contain letters or digits' });

  const { rows: clash } = await db.query('SELECT canonical_key FROM field_aliases WHERE LOWER(alias) = LOWER($1)', [alias]);
  if (clash[0]) return res.status(409).json({ error: `"${alias}" is already an alias of ${clash[0].canonical_key}` });

  const { rows } = await db.query(
    'INSERT INTO field_aliases (canonical_key, alias, created_by) VALUES ($1, $2, $3) RETURNING id, canonical_key, alias',
    [canonicalKey, alias, req.user.sub],
  );
  invalidateAliases();
  await logAction({ actorUserId: req.user.sub, entityType: 'field_alias', entityId: rows[0].id, action: 'ALIAS_ADDED', details: { canonicalKey, alias }, req });
  res.status(201).json({ id: rows[0].id, canonicalKey: rows[0].canonical_key, alias: rows[0].alias });
}));

router.delete('/:id', requireAdmin, route(async (req, res) => {
  const { rows } = await db.query('DELETE FROM field_aliases WHERE id = $1 RETURNING canonical_key, alias', [Number(req.params.id)]);
  if (!rows[0]) throw httpError(404, 'Alias not found');
  invalidateAliases();
  await logAction({ actorUserId: req.user.sub, entityType: 'field_alias', entityId: req.params.id, action: 'ALIAS_DELETED', details: rows[0], req });
  res.status(204).end();
}));

module.exports = router;
