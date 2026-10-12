// Admin-only user management.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { route } = require('./helpers');

const router = express.Router();
router.use(requireAdmin);

const ROLES = ['Admin', 'User'];

function toApi(u) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    role: u.role,
    isActive: u.is_active,
    locked: Boolean(u.locked_until && new Date(u.locked_until) > new Date()),
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

router.get('/', route(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users ORDER BY LOWER(username)');
  res.json(rows.map(toApi));
}));

router.post('/', route(async (req, res) => {
  const { username, fullName, password, role = 'User' } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(name)) return res.status(400).json({ error: 'Username: 3–80 letters, digits, dot, dash or underscore' });
  if (!String(fullName || '').trim()) return res.status(400).json({ error: 'Full name is required' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of ${ROLES.join(', ')}` });

  const hash = await bcrypt.hash(String(password), 12);
  try {
    const { rows } = await db.query(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, hash, String(fullName).trim(), role],
    );
    await logAction({ actorUserId: req.user.sub, targetUserId: rows[0].id, action: 'USER_CREATED', details: { role }, req });
    res.status(201).json(toApi(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    throw err;
  }
}));

router.patch('/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  const { fullName, role, isActive, password, unlock } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of ${ROLES.join(', ')}` });
  if (password !== undefined && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (id === req.user.sub && (isActive === false || (role && role !== 'Admin'))) {
    return res.status(400).json({ error: 'You cannot deactivate or demote your own account' });
  }

  const sets = [];
  const params = [id];
  const set = (sql, value) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (fullName !== undefined) set('full_name', String(fullName).trim());
  if (role !== undefined) set('role', role);
  if (isActive !== undefined) set('is_active', Boolean(isActive));
  if (password !== undefined) set('password_hash', await bcrypt.hash(String(password), 12));
  if (unlock) sets.push('locked_until = NULL', 'failed_login_attempts = 0');
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  const { rows } = await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const changed = Object.keys(req.body || {}).filter((k) => k !== 'password');
  if (password !== undefined) changed.push('password');
  await logAction({ actorUserId: req.user.sub, targetUserId: id, action: 'USER_UPDATED', details: { changed }, req });
  res.json(toApi(rows[0]));
}));

module.exports = router;
