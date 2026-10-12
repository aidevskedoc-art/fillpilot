// node scripts/allow-site.js <origin> "<display name>" — approves a website for form filling
// (same as Dashboard → Mappings → Allowed sites).
require('dotenv').config();
const db = require('../src/db');
const { normalizeOrigin } = require('../src/routes/allowed-sites.routes');

(async () => {
  const [input, name] = process.argv.slice(2);
  const origin = normalizeOrigin(input);
  if (!origin || !name) throw new Error('Usage: node scripts/allow-site.js https://site.example.com "Display name"');
  const { rowCount } = await db.query(
    `INSERT INTO allowed_sites (origin, display_name) VALUES ($1, $2)
     ON CONFLICT (origin) DO UPDATE SET is_active = TRUE`,
    [origin, name],
  );
  console.log(rowCount ? `Approved ${origin} (${name}).` : `${origin} was already approved.`);
  await db.pool.end();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
