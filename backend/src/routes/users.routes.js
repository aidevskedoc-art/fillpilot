// User management: the Main Admin for every unit, a Unit Admin for their own
// unit's Users (src/user-scope.js says who may do what).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireManager, unitCodes } = require('../middleware/scope');
const { canSee, checkNewUser, checkUserUpdate } = require('../user-scope');
const { logAction } = require('../audit-log');
const { route } = require('./helpers');

const router = express.Router();
router.use(requireManager);

function toApi(u) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    role: u.role,
    unit: u.unit_code ?? null,
    isActive: u.is_active,
    locked: Boolean(u.locked_until && new Date(u.locked_until) > new Date()),
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

// GET — the Main Admin: everyone; a Unit Admin: their unit's people.
router.get('/', route(async (req, res) => {
  const { rows } = req.scope.all
    ? await db.query('SELECT * FROM users ORDER BY LOWER(username)')
    : await db.query('SELECT * FROM users WHERE unit_code = $1 ORDER BY LOWER(username)', [req.scope.unit]);
  res.json(rows.map(toApi));
}));

// POST { username, fullName, password, role?, unit? }
router.post('/', route(async (req, res) => {
  const { username, fullName, password } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(name)) return res.status(400).json({ error: 'Username: 3–80 letters, digits, dot, dash or underscore' });
  if (!String(fullName || '').trim()) return res.status(400).json({ error: 'Full name is required' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const checked = checkNewUser(req.scope, req.body || {}, await unitCodes());
  if (checked.error) return res.status(400).json({ error: checked.error });

  const hash = await bcrypt.hash(String(password), 12);
  try {
    const { rows } = await db.query(
      'INSERT INTO users (username, password_hash, full_name, role, unit_code) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, hash, String(fullName).trim(), checked.role, checked.unit],
    );
    await logAction({ actorUserId: req.user.sub, targetUserId: rows[0].id, action: 'USER_CREATED', details: { role: checked.role, unit: checked.unit }, req });
    res.status(201).json(toApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    throw err;
  }
}));

// PATCH { fullName?, role?, unit?, isActive?, password?, unlock? }
router.patch('/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  const { fullName, isActive, password, unlock } = req.body || {};
  if (password !== undefined && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { rows: found } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  const target = found[0];
  if (!target || !canSee(req.scope, target)) return res.status(404).json({ error: 'User not found' });
  const checked = checkUserUpdate(req.scope, req.user.sub, target, req.body || {}, await unitCodes());
  if (checked.error) return res.status(checked.status).json({ error: checked.error });

  const sets = [];
  const params = [id];
  const set = (sql, value) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (fullName !== undefined) set('full_name', String(fullName).trim());
  if (checked.role !== undefined) set('role', checked.role);
  if (checked.unit !== undefined) set('unit_code', checked.unit);
  if (isActive !== undefined) set('is_active', Boolean(isActive));
  if (password !== undefined) set('password_hash', await bcrypt.hash(String(password), 12));
  if (unlock) sets.push('locked_until = NULL', 'failed_login_attempts = 0');
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  const { rows } = await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  const changed = Object.keys(req.body || {}).filter((k) => k !== 'password' && (k !== 'role' || checked.role !== undefined) && (k !== 'unit' || checked.unit !== undefined));
  if (password !== undefined) changed.push('password');
  await logAction({ actorUserId: req.user.sub, targetUserId: id, action: 'USER_UPDATED', details: { changed }, req });
  res.json(toApi(rows[0]));
}));

module.exports = router;
