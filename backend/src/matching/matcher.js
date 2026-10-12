// Web form fields × extracted PDF fields → proposed mappings with confidence.
// Pure: the route loads documents, aliases and saved mappings, this decides.
//
// Layers (the best one wins per pair):
//   saved    a mapping the user confirmed for this website + form + field   1.00
//   exact    normalized label equality                                       0.98
//   alias    both labels resolve to the same canonical key                   0.95
//   similar  token similarity (similarity.js)                           0.30–0.90
// then a type-fit adjustment (an email box never gets a non-email value), and
// scaled by the extraction confidence (0.7 + 0.3 × conf).

const crypto = require('crypto');
const { normLabel, splitIdentifier } = require('../text/labels');
const { similarity } = require('./similarity');
const { formatFor, webTypeOf } = require('./value-formatter');

const THRESHOLDS = { matched: 0.85, review: 0.6, candidate: 0.4 };
const AMBIGUITY_GAP = 0.05;
const SKIP_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'image', 'reset', 'color']);
const ID_PREFIX = /^(txt|ddl|cmb|chk|rdo|rb|rbl|tb|lbl|inp|input|sel|fld|ctl)(?=[A-Z_])/;

/** "ctl00$Main$txtPatientName" → "patient name". */
function identifierText(id) {
  const last = String(id || '').split(/[$:]/).pop();
  return splitIdentifier(last.replace(ID_PREFIX, ''));
}

/** Everything the page says about a web field, strongest first. */
function webTexts(d) {
  const out = [];
  const seen = new Set();
  const add = (text, weight) => {
    const t = String(text || '').trim();
    const n = normLabel(t);
    if (!n || t.length > 150 || seen.has(n)) return;
    seen.add(n);
    out.push({ text: t, norm: n, weight });
  };
  add(d.label, 1);
  add(d.ariaLabel, 1);
  add(d.legend, 1);
  add(d.placeholder, 0.95);
  add(d.nearbyText, 0.9);
  add(identifierText(d.name), 0.9);
  add(identifierText(d.id), 0.85);
  return out;
}

function displayLabel(d) {
  return d.label || d.ariaLabel || d.legend || d.placeholder || d.nearbyText || identifierText(d.name) || identifierText(d.id) || '(unlabelled field)';
}

/** Stable per-field id for saved mappings: same field on the same form → same signature. */
function fieldSignature(d) {
  const parts = [d.tag, String(d.type || '').toLowerCase(), d.name || '', d.id || '', normLabel(displayLabel(d))];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** Path with record ids replaced, so /patients/123/edit and /patients/456/edit are one form. */
function formKeyFor(path) {
  const clean = String(path || '/').split(/[?#]/)[0];
  const segs = clean.split('/').map((s) => (/^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) ? ':id' : s));
  return segs.join('/').replace(/\/+$/, '') || '/';
}

function typeFit(webType, field) {
  const t = field.valueType;
  switch (webType) {
    case 'email':
      return t === 'email' ? 0.02 : -0.4;
    case 'date':
    case 'datetime-local':
    case 'month':
      return t === 'date' ? 0.03 : -0.3;
    case 'tel':
      return t === 'phone' ? 0.02 : /\d{6,}/.test(field.valueRaw) ? 0 : -0.3;
    case 'number':
      return ['number', 'amount'].includes(t) ? 0 : /^[\d,.\s₹]+$/.test(field.valueRaw) ? 0 : -0.3;
    default:
      return 0;
  }
}

function scorePair(texts, field, aliasIndex) {
  const fieldNorm = normLabel(field.label);
  let best = { score: 0, source: null };
  const take = (score, source) => {
    if (score > best.score) best = { score, source };
  };
  for (const wt of texts) {
    const strong = wt.weight >= 0.95 ? 1 : 0.95;
    if (wt.norm === fieldNorm) take(0.98 * strong, 'exact');
    const webCanonical = aliasIndex.get(wt.norm);
    if (webCanonical && webCanonical === field.canonicalKey) take(0.95 * strong, 'alias');
    // The PDF's own label only: a canonical key's name ("emailAddress") would
    // lend its words to unrelated web labels ("Residential Address").
    const s = similarity(wt.text, field.label);
    if (s >= 0.2) take((0.3 + 0.6 * s) * wt.weight, 'similar');
  }
  return best;
}

/**
 * Several documents → one field list. The same key with different values in
 * different documents is a conflict the user must see; the most confident
 * value is proposed.
 */
function consolidate(fields) {
  const groups = new Map();
  for (const f of fields) {
    const key = f.canonicalKey || f.fieldKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const out = [];
  for (const group of groups.values()) {
    const docs = [...new Set(group.map((f) => f.documentId))];
    if (docs.length === 1) {
      // One document: keep every field (same canonical key, different labels).
      out.push(...group.map((f) => ({ ...f, conflicts: [] })));
      continue;
    }
    // Several documents: the most confident document's fields win the key.
    const bestPerDoc = docs
      .map((doc) => group.filter((f) => f.documentId === doc).sort((a, b) => b.confidence - a.confidence)[0])
      .sort((a, b) => b.confidence - a.confidence);
    const winner = bestPerDoc[0];
    const distinct = new Set(bestPerDoc.map((f) => normLabel(f.valueNormalized || f.valueRaw)));
    const conflicts = distinct.size > 1 ? bestPerDoc.map((f) => ({ documentId: f.documentId, value: f.valueRaw })) : [];
    out.push(...group.filter((f) => f.documentId === winner.documentId).map((f) => ({ ...f, conflicts })));
  }
  return out;
}

/**
 * descriptors: web fields from the content script
 *   { ref, frameId, tag, type, name, id, label, ariaLabel, placeholder, nearbyText,
 *     legend, required, maxLength, pattern, options: [{ value, text }] }
 * fields: extracted fields { id, documentId, fieldKey, canonicalKey, label,
 *   valueRaw, valueNormalized, valueType, confidence }
 * saved: Map<signature, { field_key, canonical_key }> for this origin + form.
 */
function matchForm({ descriptors, fields, aliasIndex, saved = new Map() }) {
  const pool = consolidate(fields);
  const results = [];

  for (const d of descriptors) {
    const webType = webTypeOf(d);
    if (SKIP_TYPES.has(webType)) continue;
    const texts = webTexts(d);
    const signature = fieldSignature(d);
    const savedHit = saved.get(signature);

    const scored = [];
    for (const f of pool) {
      let pair;
      if (savedHit && (f.fieldKey === savedHit.field_key || (savedHit.canonical_key && f.canonicalKey === savedHit.canonical_key))) {
        pair = { score: 1, source: 'saved' };
      } else {
        pair = scorePair(texts, f, aliasIndex);
        if (!pair.source) continue;
        // A shaky extraction (footer boilerplate, label-below guess) lowers the mapping too.
        const extractionFactor = 0.7 + 0.3 * Math.min(1, Number(f.confidence ?? 1));
        pair.score = Math.max(0, Math.min(0.99, (pair.score + typeFit(webType, f)) * extractionFactor));
      }
      scored.push({ field: f, score: Number(pair.score.toFixed(3)), source: pair.source });
    }
    scored.sort((a, b) => b.score - a.score || b.field.confidence - a.field.confidence);

    const candidates = scored.filter((c) => c.score >= THRESHOLDS.candidate).slice(0, 3);
    results.push({ d, webType, signature, candidates });
  }

  // Same PDF field proposed for several web fields with near-equal scores
  // (Address → Current / Permanent / Communication): the user must choose.
  const topByField = new Map();
  for (const r of results) {
    const top = r.candidates[0];
    if (!top || top.score < THRESHOLDS.review || top.source === 'saved') continue;
    const key = top.field.id;
    if (!topByField.has(key)) topByField.set(key, []);
    topByField.get(key).push(r);
  }

  const out = results.map((r) => {
    const { d, webType, candidates } = r;
    const warnings = [];
    const top = candidates[0] || null;
    let status = 'unmatched';
    let selected = null;
    let problem = null;

    if (top && top.score >= THRESHOLDS.review) {
      const formatted = formatFor(d, top.field);
      selected = toCandidate(top, formatted);
      warnings.push(...formatted.warnings);
      problem = formatted.problem;
      status = top.score >= THRESHOLDS.matched ? 'matched' : 'review';

      const second = candidates[1];
      if (second && top.source !== 'saved' && top.score - second.score < AMBIGUITY_GAP
        && normLabel(second.field.valueRaw) !== normLabel(top.field.valueRaw)) {
        warnings.push(`Multiple possible PDF fields: ${candidates.slice(0, 3).map((c) => c.field.label).join(', ')}`);
        status = 'review';
      }
      const rivals = (topByField.get(top.field.id) || []).filter((o) => o !== r && Math.abs(o.candidates[0].score - top.score) < AMBIGUITY_GAP);
      if (rivals.length) {
        warnings.push(`"${top.field.label}" also fits: ${rivals.map((o) => displayLabel(o.d)).join(', ')}`);
        status = 'review';
      }
      if (top.field.conflicts?.length) {
        warnings.push(`Conflicting values across documents: ${top.field.conflicts.map((c) => c.value).join(' / ')}`);
        status = 'review';
      }
      if (problem) {
        warnings.push(problem);
        status = 'review';
      }
    }

    return {
      ref: d.ref,
      frameId: d.frameId ?? 0,
      label: displayLabel(d),
      webType,
      required: Boolean(d.required),
      signature: r.signature,
      status,
      include: status === 'matched' && !problem,
      selected,
      candidates: candidates.map((c) => toCandidate(c, null)),
      warnings,
    };
  });

  const usedIds = new Set(out.filter((o) => o.selected).map((o) => o.selected.fieldId));
  const notFound = pool
    .filter((f) => f.canonicalKey && !usedIds.has(f.id))
    .map((f) => ({ fieldId: f.id, fieldKey: f.fieldKey, label: f.label }));

  return {
    summary: {
      detected: out.length,
      matched: out.filter((o) => o.status === 'matched').length,
      review: out.filter((o) => o.status === 'review').length,
      unmatched: out.filter((o) => o.status === 'unmatched').length,
    },
    fields: out,
    notFound,
  };
}

function toCandidate(c, formatted) {
  const base = {
    fieldId: c.field.id,
    documentId: c.field.documentId,
    fieldKey: c.field.fieldKey,
    label: c.field.label,
    originalValue: c.field.valueRaw,
    confidence: c.score,
    source: c.source,
  };
  return formatted ? { ...base, fillValue: formatted.fillValue } : base;
}

module.exports = { matchForm, fieldSignature, formKeyFor, webTexts, displayLabel, THRESHOLDS };
