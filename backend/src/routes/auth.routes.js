const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../middleware/auth');
const { logAction } = require('../audit-log');
const { route } = require('./helpers');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 30;

function userToApi(u) {
  return { id: u.id, username: u.username, fullName: u.full_name, role: u.role };
}

// POST /api/auth/login
router.post('/login', route(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required' });
  if (!password) return res.status(400).json({ error: 'Password is required' });

  const { rows } = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [String(username).trim()]);
  const user = rows[0];

  if (!user || !user.is_active) {
    if (user) await logAction({ targetUserId: user.id, action: 'LOGIN_FAILED', details: { reason: 'inactive' }, req });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await logAction({ targetUserId: user.id, action: 'LOGIN_FAILED', details: { reason: 'account_locked' }, req });
    return res.status(401).json({ error: 'Account locked after too many failed attempts. Try again later or ask an administrator.' });
  }

  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) {
    const { rows: updated } = await db.query(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE WHEN failed_login_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END,
              updated_at = now()
        WHERE id = $1
    RETURNING locked_until`,
      [user.id, MAX_FAILED_ATTEMPTS, String(LOCK_MINUTES)],
    );
    await logAction({ targetUserId: user.id, action: 'LOGIN_FAILED', details: { reason: 'bad_password' }, req });
    if (updated[0]?.locked_until) await logAction({ targetUserId: user.id, action: 'ACCOUNT_LOCKED', req });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  await db.query(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1',
    [user.id],
  );
  await logAction({ actorUserId: user.id, action: 'LOGIN', details: { client: req.get('X-Client') || 'web' }, req });
  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: userToApi(user) });
}));

// GET /api/auth/me
router.get('/me', route(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND is_active', [req.user.sub]);
  if (!rows[0]) return res.status(401).json({ error: 'Account no longer active' });
  res.json(userToApi(rows[0]));
}));

// POST /api/auth/logout — JWTs are stateless; this records the event.
router.post('/logout', route(async (req, res) => {
  await logAction({ actorUserId: req.user.sub, action: 'LOGOUT', details: { client: req.get('X-Client') || 'web' }, req });
  res.status(204).end();
}));

module.exports = router;
