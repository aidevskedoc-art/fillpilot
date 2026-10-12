const bcrypt = require('bcryptjs');
const db = require('./db');

/** Creates the first Admin from .env when the users table is empty. */
async function seedAdmin() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return false;

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!password) {
    console.warn('No users exist and ADMIN_PASSWORD is not set — no admin created. Set it in .env and restart.');
    return false;
  }
  if (password.length < 8) console.warn('ADMIN_PASSWORD is shorter than 8 characters — fine on your own machine, change it before others can reach this server.');
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, 'Admin')`,
    [username, hash, process.env.ADMIN_FULL_NAME || 'Administrator'],
  );
  console.log(`Created first Admin user "${username}".`);
  return true;
}

module.exports = { seedAdmin };
