// node scripts/diagnose-login.js — why can't the Admin sign in?
// Checks the API is up, what the users table holds, whether ADMIN_PASSWORD in
// .env matches the stored hash, and what POST /api/auth/login answers.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const API = `http://localhost:${Number(process.env.PORT) || 4100}`;

(async () => {
  try {
    const health = await fetch(`${API}/api/health`).then((r) => r.status);
    console.log(`API ${API}: health ${health}`);
  } catch (err) {
    console.log(`API ${API}: NOT REACHABLE (${err.cause?.code || err.message}) — is "npm start" running?`);
  }

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const { rows } = await db.query(
    'SELECT id, username, role, is_active, failed_login_attempts, locked_until, password_hash, created_at FROM users ORDER BY id',
  );
  console.log(`users in ${process.env.PGDATABASE}: ${rows.length}`);
  for (const u of rows) {
    const isEnvAdmin = u.username.toLowerCase() === username.toLowerCase();
    const matches = isEnvAdmin ? await bcrypt.compare(process.env.ADMIN_PASSWORD || '', u.password_hash) : null;
    console.log(
      `  #${u.id} "${u.username}" ${u.role} active=${u.is_active} failedAttempts=${u.failed_login_attempts}` +
        ` lockedUntil=${u.locked_until ? u.locked_until.toISOString() : '-'}` +
        (isEnvAdmin ? ` .env ADMIN_PASSWORD matches=${matches}` : ''),
    );
  }

  const { rows: logins } = await db.query(
    `SELECT a.action, a.details, a.created_at, u.username FROM audit_logs a
       LEFT JOIN users u ON u.id = COALESCE(a.target_user_id, a.actor_user_id)
      WHERE a.action LIKE 'LOGIN%' OR a.action = 'ACCOUNT_LOCKED'
      ORDER BY a.id DESC LIMIT 10`,
  );
  console.log(`recent login attempts recorded: ${logins.length}`);
  for (const l of logins) console.log(`  ${l.created_at.toISOString()} ${l.action} ${l.username || ''} ${l.details ? JSON.stringify(l.details) : ''}`);

  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: process.env.ADMIN_PASSWORD }),
    });
    const body = await res.json();
    console.log(`login as "${username}" with .env password: HTTP ${res.status} ${res.ok ? 'OK — token issued for ' + body.user.fullName : body.error}`);
  } catch (err) {
    console.log(`login request failed: ${err.message}`);
  }
  await db.pool.end();
})().catch(async (err) => {
  console.error('diagnose failed:', err.message);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
