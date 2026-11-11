const express = require('express');
const db = require('../db');
const { requireManager } = require('../middleware/scope');
const { unitFilter } = require('../user-scope');
const { route, clampInt } = require('./helpers');

const router = express.Router();
router.use(requireManager);

// GET ?action=&unit=&limit=&offset= — the Main Admin: everything (or one unit's
// people); a Unit Admin: what their unit's people did, or had done to them.
router.get('/', route(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.action) {
    params.push(String(req.query.action));
    where.push(`a.action = $${params.length}`);
  }
  const unit = unitFilter(req.scope, req.query.unit);
  if (unit) {
    params.push(unit);
    where.push(`(actor.unit_code = $${params.length} OR target.unit_code = $${params.length})`);
  }
  const limit = clampInt(req.query.limit, 1, 500, 200);
  const offset = clampInt(req.query.offset, 0, 1e9, 0);
  const { rows } = await db.query(
    `SELECT a.*, actor.username AS actor_username, target.username AS target_username
       FROM audit_logs a
       LEFT JOIN users actor ON actor.id = a.actor_user_id
       LEFT JOIN users target ON target.id = a.target_user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json(rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    actor: r.actor_username,
    target: r.target_username,
    entityType: r.entity_type,
    entityId: r.entity_id,
    details: r.details,
    ipAddress: r.ip_address,
    createdAt: r.created_at,
  })));
}));

module.exports = router;
