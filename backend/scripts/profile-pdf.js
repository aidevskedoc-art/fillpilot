// npm run profile-pdf -- <file.pdf> [page|all]
// Prints each page's positional lines (segments split at column gaps) and the
// key-value pairs the extractor takes from them — the tool for tuning rules
// against a new document layout.
const fs = require('fs');
const { readPdf } = require('../src/extraction/pdf-text');
const { buildLines } = require('../src/extraction/lines');
const { extractPage } = require('../src/extraction/kv-extractor');
const { buildAliasIndex, seedAliases } = require('../src/alias-index');
const { normLabel } = require('../src/text/labels');

(async () => {
  const [file, which = '1'] = process.argv.slice(2);
  if (!file) {
    console.log('Usage: npm run profile-pdf -- <file.pdf> [page|all]');
    process.exit(1);
  }
  const aliasIndex = buildAliasIndex(seedAliases());
  const isKnownLabel = (t) => aliasIndex.has(normLabel(t));
  const { pages } = await readPdf(fs.readFileSync(file));
  console.log(`${file}: ${pages.length} page(s), chars/page ${pages.map((p) => p.charCount).join(',')}`);

  for (const page of pages) {
    if (which !== 'all' && Number(which) !== page.page) continue;
    const lines = buildLines(page);
    console.log(`\n--- page ${page.page}${page.scanned ? ' (no text — scanned?)' : ''}`);
    for (const l of lines) console.log(`  y${Math.round(l.y)} x[${l.segments.map((s) => Math.round(s.x0)).join(',')}] ${l.segments.map((s) => s.text).join(' || ')}`);
    const { pairs, tables } = extractPage(lines, { isKnownLabel, pageHeight: page.height });
    console.log(`\n  pairs (${pairs.length}):`);
    for (const p of pairs) console.log(`    ${p.confidence.toFixed(2)} ${p.method.padEnd(12)} [${p.label}] = ${p.value}`);
    for (const t of tables) console.log(`  table: ${JSON.stringify(t.headers)} × ${t.rows.length} row(s)`);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
