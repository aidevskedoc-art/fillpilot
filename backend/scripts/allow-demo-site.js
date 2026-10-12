// node scripts/allow-demo-site.js — approves this backend's own origin (where the
// synthetic demo forms are served) so the extension can be tried locally.
require('dotenv').config();
const db = require('../src/db');

(async () => {
  const origin = `http://localhost:${Number(process.env.PORT) || 4100}`;
  const { rowCount } = await db.query(
    `INSERT INTO allowed_sites (origin, display_name) VALUES ($1, 'Local demo forms') ON CONFLICT (origin) DO NOTHING`,
    [origin],
  );
  console.log(rowCount ? `Approved ${origin} (demo forms).` : `${origin} was already approved.`);
  await db.pool.end();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
