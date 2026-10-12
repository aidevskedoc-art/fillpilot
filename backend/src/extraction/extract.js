// PDF buffer -> { pageCount, fields, tables, warnings, docType, structured }.
// Pure (no DB), so the fixture tests run it directly.
//
// fields      generic label/value pairs (every document)
// structured  a known layout parsed into its real shape — e.g. a Yashoda
//             final bill's sections and items (formats/), else null

const { readPdf, PdfReadError } = require('./pdf-text');
const { buildLines } = require('./lines');
const { extractPage } = require('./kv-extractor');
const { typeValue } = require('./normalize');
const { detectFormat, parseStructured } = require('./formats/yashoda');
const { normLabel, toFieldKey } = require('../text/labels');
const { ocrAvailable } = require('../ocr');

class ExtractionError extends Error {}

const ISSUER_PENALTY = 0.8;
/** Pairs read by OCR count for a little less than real text. */
const OCR_PENALTY = 0.9;

/** Domains of websites printed in the document (www.x.in, https://x.in) — the issuer's own. */
function websiteDomains(pages) {
  const domains = new Set();
  const re = /(?:https?:\/\/)?www\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)|https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
  for (const page of pages) {
    const text = page.items.map((it) => it.str).join(' ');
    let m;
    while ((m = re.exec(text))) domains.add((m[1] || m[2]).toLowerCase());
  }
  return domains;
}

/**
 * aliasIndex: Map<normalized alias, canonicalKey> (see src/aliases.js).
 * Each field: { fieldKey, canonicalKey, label, valueRaw, valueNormalized,
 * valueType, confidence, method, page, bbox, validation, sortOrder }.
 */
async function extractDocument(buffer, aliasIndex = new Map(), { ocr = true } = {}) {
  const { pageCount, pages } = await readPdf(buffer, { ocr });
  const warnings = [];

  const scanned = pages.filter((p) => p.scanned).map((p) => p.page);
  const ocrErrors = [...new Set(pages.map((p) => p.ocrError).filter(Boolean))];
  if (scanned.length === pages.length) {
    const why = ocrErrors.length ? ` OCR failed: ${ocrErrors.join('; ')}` : !ocrAvailable() ? ' OCR is not available on this server.' : '';
    throw new ExtractionError(
      (pages.length === 1
        ? 'The page has no readable text — it looks scanned.'
        : `None of the ${pages.length} pages has readable text — the PDF looks scanned.`) + why,
    );
  }
  if (scanned.length) warnings.push(`Page(s) ${scanned.join(', ')} have no readable text and were skipped.`);
  const ocrPages = pages.filter((p) => p.ocr).map((p) => p.page);
  if (ocrPages.length) {
    warnings.push(`Page(s) ${ocrPages.join(', ')} are images and were read with OCR — check the amounts flagged for review.`);
  }
  for (const e of ocrErrors) warnings.push(`OCR problem: ${e}`);

  const isKnownLabel = (text) => aliasIndex.has(normLabel(text));
  const issuerDomains = websiteDomains(pages);
  const candidates = [];
  const tables = [];
  const pageLines = [];
  for (const page of pages) {
    if (page.scanned) continue;
    const lines = buildLines(page);
    pageLines.push({ page: page.page, width: page.width, height: page.height, lines });
    const result = extractPage(lines, { isKnownLabel, pageHeight: page.height });
    for (const pair of result.pairs) {
      // support@insurer.in on a document that also prints www.insurer.in is the
      // issuer's contact, not the customer's.
      const domain = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(pair.value)?.[1]?.toLowerCase();
      if (domain && issuerDomains.has(domain)) pair.confidence = Number((pair.confidence * ISSUER_PENALTY).toFixed(3));
      if (page.ocr) pair.confidence = Number((pair.confidence * OCR_PENALTY).toFixed(3));
      candidates.push(pair);
    }
    for (const t of result.tables) tables.push({ page: t.page, headers: t.headers, rows: t.rows });
  }

  const docType = detectFormat(pageLines.flatMap((p) => p.lines));
  const structured = docType ? parseStructured(docType, pageLines) : null;

  const fields = dedupe(candidates).map((c, i) => {
    const typed = typeValue(c.label, c.value);
    return {
      fieldKey: c.fieldKey,
      canonicalKey: aliasIndex.get(normLabel(c.label)) || null,
      label: c.label,
      valueRaw: c.value,
      valueNormalized: typed.normalized,
      valueType: typed.valueType,
      confidence: c.confidence,
      method: c.method,
      page: c.page,
      bbox: c.bbox,
      validation: { ...typed.validation, ...(c.alternates.length ? { alternates: c.alternates } : {}) },
      sortOrder: i,
    };
  });

  if (fields.length === 0 && !structured) warnings.push('No label/value pairs were recognised in this document.');
  return { pageCount, fields, tables, warnings, docType, structured };
}

/**
 * One field per key: the most confident occurrence wins (earliest on ties).
 * Other occurrences with a *different* value are kept as alternates so the
 * user can see the PDF disagreed with itself.
 */
function dedupe(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const fieldKey = toFieldKey(c.label);
    const group = byKey.get(fieldKey) || [];
    group.push({ ...c, fieldKey });
    byKey.set(fieldKey, group);
  }
  const winners = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => b.confidence - a.confidence || a.page - b.page || a.order - b.order);
    const best = sorted[0];
    const seen = new Set([best.value.toLowerCase()]);
    const alternates = [];
    for (const other of sorted.slice(1)) {
      const v = other.value.toLowerCase();
      if (seen.has(v)) continue;
      seen.add(v);
      alternates.push({ value: other.value, page: other.page });
    }
    winners.push({ ...best, alternates: alternates.slice(0, 5) });
  }
  // Reading order: page, then position on the page.
  return winners.sort((a, b) => a.page - b.page || a.order - b.order);
}

module.exports = { extractDocument, ExtractionError, PdfReadError };
