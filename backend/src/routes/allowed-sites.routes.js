// Websites the extension may scan and fill. Read: everyone (the extension needs
// the list). Edit: Admin.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { route, httpError } = require('./helpers');

const router = express.Router();

function toApi(r) {
  return { id: r.id, origin: r.origin, displayName: r.display_name, isActive: r.is_active, createdAt: r.created_at };
}

/** "https://portal.example.com/path" → "https://portal.example.com"; anything else → null. */
function normalizeOrigin(input) {
  try {
    const url = new URL(String(input || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

router.get('/', route(async (req, res) => {
  const all = req.user.role === 'Admin' && req.query.all === 'true';
  const { rows } = await db.query(`SELECT * FROM allowed_sites ${all ? '' : 'WHERE is_active'} ORDER BY display_name`);
  res.json(rows.map(toApi));
}));

router.post('/', requireAdmin, route(async (req, res) => {
  const origin = normalizeOrigin(req.body?.origin);
  const displayName = String(req.body?.displayName || '').trim();
  if (!origin) return res.status(400).json({ error: 'Enter a full website address, e.g. https://portal.example.com' });
  if (!displayName) return res.status(400).json({ error: 'Display name is required' });
  try {
    const { rows } = await db.query(
      'INSERT INTO allowed_sites (origin, display_name, created_by) VALUES ($1, $2, $3) RETURNING *',
      [origin, displayName, req.user.sub],
    );
    await logAction({ actorUserId: req.user.sub, entityType: 'allowed_site', entityId: rows[0].id, action: 'SITE_ALLOWED', details: { origin }, req });
    res.status(201).json(toApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `${origin} is already on the list` });
    throw err;
  }
}));

router.patch('/:id', requireAdmin, route(async (req, res) => {
  const { displayName, isActive } = req.body || {};
  const { rows } = await db.query(
    `UPDATE allowed_sites SET display_name = COALESCE($2, display_name), is_active = COALESCE($3, is_active)
      WHERE id = $1 RETURNING *`,
    [Number(req.params.id), displayName ? String(displayName).trim() : null, typeof isActive === 'boolean' ? isActive : null],
  );
  if (!rows[0]) throw httpError(404, 'Site not found');
  await logAction({ actorUserId: req.user.sub, entityType: 'allowed_site', entityId: rows[0].id, action: 'SITE_UPDATED', details: { origin: rows[0].origin, isActive: rows[0].is_active }, req });
  res.json(toApi(rows[0]));
}));

router.delete('/:id', requireAdmin, route(async (req, res) => {
  const { rows } = await db.query('DELETE FROM allowed_sites WHERE id = $1 RETURNING origin', [Number(req.params.id)]);
  if (!rows[0]) throw httpError(404, 'Site not found');
  await logAction({ actorUserId: req.user.sub, entityType: 'allowed_site', entityId: req.params.id, action: 'SITE_REMOVED', details: rows[0], req });
  res.status(204).end();
}));

module.exports = router;
module.exports.normalizeOrigin = normalizeOrigin;
