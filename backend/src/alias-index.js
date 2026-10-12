// The alias dictionary as a lookup: normalized label -> canonical key.
// Pure (no DB) so extraction/matching tests can build it from the seed file.

const { normLabel } = require('./text/labels');

/** rows: [{ canonical_key, alias }] or the seed object { canonicalKey: [aliases] }. */
function buildAliasIndex(rows) {
  const index = new Map();
  const add = (canonicalKey, alias) => {
    const key = normLabel(alias);
    if (key && !index.has(key)) index.set(key, canonicalKey);
  };
  if (Array.isArray(rows)) {
    for (const r of rows) add(r.canonical_key, r.alias);
  } else {
    for (const [canonicalKey, aliases] of Object.entries(rows)) {
      if (canonicalKey.startsWith('_')) continue;
      add(canonicalKey, canonicalKey.replace(/([a-z])([A-Z])/g, '$1 $2'));
      for (const alias of aliases) add(canonicalKey, alias);
    }
  }
  return index;
}

function seedAliases() {
  return require('../seed/field-aliases.json');
}

module.exports = { buildAliasIndex, seedAliases };
