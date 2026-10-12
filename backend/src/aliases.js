// field_aliases table ↔ in-memory index. Cached; any alias edit invalidates it.

const db = require('./db');
const { buildAliasIndex, seedAliases } = require('./alias-index');

let cache = null;

async function getAliasIndex() {
  if (!cache) {
    const { rows } = await db.query('SELECT canonical_key, alias FROM field_aliases');
    cache = buildAliasIndex(rows);
  }
  return cache;
}

function invalidateAliases() {
  cache = null;
}

/** Fills an empty field_aliases table from seed/field-aliases.json. Returns rows added. */
async function seedAliasTable() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM field_aliases');
  if (rows[0].n > 0) return 0;
  const keys = [];
  const aliases = [];
  for (const [canonicalKey, list] of Object.entries(seedAliases())) {
    if (canonicalKey.startsWith('_')) continue;
    for (const alias of [canonicalKey.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), ...list]) {
      keys.push(canonicalKey);
      aliases.push(alias);
    }
  }
  const result = await db.query(
    `INSERT INTO field_aliases (canonical_key, alias)
     SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT DO NOTHING`,
    [keys, aliases],
  );
  invalidateAliases();
  return result.rowCount;
}

module.exports = { getAliasIndex, invalidateAliases, seedAliasTable };
