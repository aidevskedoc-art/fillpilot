// What counts as a label, a value, and an inline "Label : Value" pair.

const MAX_LABEL_WORDS = 6;
const MAX_LABEL_CHARS = 48;
const MAX_VALUE_CHARS = 200;

function cleanLabel(text) {
  return String(text || '')
    .replace(/^[\s:#\-–*]+/, '')
    .replace(/[\s:#\-–*]+$/, '')
    .trim();
}

function cleanValue(text) {
  return String(text || '')
    .replace(/^[\s:#\-–]+/, '')
    .replace(/[\s,;]+$/, '')
    .trim();
}

/** Short, mostly letters, starts with a letter, not a sentence/URL. */
function isLabelText(text) {
  const raw = String(text || '').trim();
  const t = cleanLabel(raw);
  if (t.length < 3 || t.length > MAX_LABEL_CHARS) return false;
  if (!/^[A-Za-z]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > MAX_LABEL_WORDS) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (digits > letters / 3) return false;
  if (/,/.test(t) && words.length > 2) return false;
  if (/[!?,]$/.test(raw) || (/\.$/.test(raw) && words.length > 3)) return false;
  if (/@|https?:|www\./i.test(t)) return false;
  // Sentences in letters and policy wording, not labels.
  if (/^(this|that|we|you|i|it|the|please|kindly|dear|if|in case|for any)\b/i.test(t) && words.length > 2) return false;
  return true;
}

/** A table header cell: label-like and digit-free. */
function isHeaderCell(text) {
  return isLabelText(text) && !/\d/.test(text) && !/:\s*\S/.test(text);
}

function isValueText(text) {
  const v = cleanValue(text);
  if (v.length === 0 || v.length > MAX_VALUE_CHARS || !/[A-Za-z0-9]/.test(v)) return false;
  if (/^page \d+( of \d+)?$/i.test(v)) return false;
  return true;
}

/**
 * Splits "Label : Value" / "Label # Value" at the first separator that isn't
 * part of a time (10:30) or a URL (https://). Returns { label, value, sep } —
 * value may be '' ("Communication Address:") — or null if the text before the
 * separator isn't a label.
 */
function splitInline(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== ':' && ch !== '#') continue;
    if (ch === ':' && /\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '')) continue;
    if (ch === ':' && s.slice(i, i + 3) === '://') continue;
    const label = s.slice(0, i);
    if (!isLabelText(label)) return null;
    return { label: cleanLabel(label), value: cleanValue(cutAtNextPair(s.slice(i + 1))), sep: ch };
  }
  return null;
}

/**
 * Footers pack several pairs into one run of text:
 * "support@x.in Website :www.x.in IRDAI Regn.no: 129" → "support@x.in".
 */
function cutAtNextPair(value) {
  const re = /[\s,]+([A-Z][A-Za-z.()/&' -]{1,40}?)\s*[:#]\s*\S/g;
  let m;
  while ((m = re.exec(value))) {
    if (/\d/.test(value[m.index + m[0].length - 1] || '') && /\d\s*$/.test(m[1])) continue;
    if (isLabelText(m[1])) return value.slice(0, m.index);
  }
  return value;
}

module.exports = { cleanLabel, cleanValue, isLabelText, isHeaderCell, isValueText, splitInline };
