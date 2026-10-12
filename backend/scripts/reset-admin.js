// npm run reset-admin — (re)creates the Admin from ADMIN_USERNAME / ADMIN_PASSWORD in .env:
// sets that password, makes the account an active Admin, and clears any lockout.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

(async () => {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!password) throw new Error('Set ADMIN_PASSWORD in backend/.env first.');
  if (password.length < 8) console.warn('ADMIN_PASSWORD is shorter than 8 characters — fine on your own machine, change it before others can reach this server.');

  await db.ensureDatabase();
  await db.ensureSchema();
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await db.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  if (rows[0]) {
    await db.query(
      `UPDATE users SET password_hash = $2, role = 'Admin', is_active = TRUE, failed_login_attempts = 0,
              locked_until = NULL, updated_at = now() WHERE id = $1`,
      [rows[0].id, hash],
    );
    console.log(`Admin "${username}": password reset from .env, account active and unlocked.`);
  } else {
    await db.query(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, 'Admin')`,
      [username, hash, process.env.ADMIN_FULL_NAME || 'Administrator'],
    );
    console.log(`Admin "${username}" created with the password from .env.`);
  }
  await db.pool.end();
})().catch(async (err) => {
  console.error('Reset failed:', err.message);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
