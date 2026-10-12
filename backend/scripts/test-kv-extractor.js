// node scripts/test-kv-extractor.js — extraction against REAL sample PDFs.
// test-fixtures/ is gitignored (patient data). expected.json lists values read
// by hand from each PDF; a key is checked by canonical key (best-confidence
// field with that key) or by field key.
const fs = require('fs');
const path = require('path');
const { extractDocument } = require('../src/extraction/extract');
const { buildAliasIndex, seedAliases } = require('../src/alias-index');
const { check, done } = require('./lib/check');

process.env.DATE_ORDER = 'DMY';
const FIXTURES = path.join(__dirname, '..', 'test-fixtures');
const expectedFile = path.join(FIXTURES, 'expected.json');

(async () => {
  if (!fs.existsSync(expectedFile)) {
    console.log('SKIP  test-fixtures/expected.json not found (fixtures are local-only; see README).');
    return;
  }
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  const aliasIndex = buildAliasIndex(seedAliases());

  const only = process.argv[2]; // optional: substring of a fixture file name
  for (const [file, spec] of Object.entries(expected)) {
    if (file.startsWith('_') || (only && !file.includes(only))) continue;
    const { fields } = await extractDocument(fs.readFileSync(path.join(FIXTURES, file)), aliasIndex);
    const value = (f) => (f ? f.valueNormalized || f.valueRaw : null);

    for (const [canonicalKey, want] of Object.entries(spec.canonical || {})) {
      const best = fields.filter((f) => f.canonicalKey === canonicalKey).sort((a, b) => b.confidence - a.confidence)[0];
      check(`${file} canonical ${canonicalKey}`, value(best), want);
    }
    for (const [fieldKey, want] of Object.entries(spec.fields || {})) {
      check(`${file} field ${fieldKey}`, value(fields.find((f) => f.fieldKey === fieldKey)), want);
    }
    for (const fieldKey of spec.absent || []) {
      check(`${file} no junk field ${fieldKey}`, fields.some((f) => f.fieldKey === fieldKey), false);
    }
  }
  done('kv-extractor');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
