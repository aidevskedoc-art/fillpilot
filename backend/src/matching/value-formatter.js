// Converts an extracted value into what a specific web field accepts:
// ISO for <input type=date>, the page's own format for a text date field,
// digits for tel/number, and an existing option for select/radio — never a
// guessed option. The original value always travels alongside.

const { findDate, normalizePhone, normalizeAmount } = require('../extraction/normalize');

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function webTypeOf(d) {
  if (d.tag === 'select') return 'select';
  if (d.tag === 'textarea') return 'textarea';
  return String(d.type || 'text').toLowerCase();
}

/** "dd/mm/yyyy", "DD-MMM-YYYY", "yyyy-mm-dd" … found in placeholder/pattern/label → token list. */
function dateFormatHint(d) {
  const sources = [d.placeholder, d.label, d.ariaLabel, d.nearbyText, d.pattern].filter(Boolean).join(' ');
  const m = /\b(dd|mm|mmm|yyyy|yy)([/\-. ])(dd|mm|mmm)\2(yyyy|yy|dd)\b/i.exec(sources);
  if (!m) return null;
  return { parts: [m[1], m[3], m[4]].map((p) => p.toLowerCase()), sep: m[2] };
}

function formatDate(iso, hint) {
  const [y, m, d] = iso.split('-');
  const parts = hint.parts.map((p) => {
    if (p === 'dd') return d;
    if (p === 'mm') return m;
    if (p === 'mmm') return MONTHS_SHORT[Number(m) - 1];
    if (p === 'yyyy') return y;
    if (p === 'yy') return y.slice(2);
    return '';
  });
  return parts.join(hint.sep);
}

function isoOf(field) {
  if (field.valueType === 'date' && field.valueNormalized) return field.valueNormalized;
  return findDate(field.valueRaw)?.iso || null;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const SYNONYMS = [
  ['male', 'm', 'man', 'boy'],
  ['female', 'f', 'woman', 'girl'],
  ['other', 'o', 'others', 'transgender', 'tg'],
  ['yes', 'y', 'true', '1'],
  ['no', 'n', 'false', '0'],
];

function isPlaceholderOption(o) {
  return o.value === '' || /^(-+\s*)?(select|choose|please select|--)/i.test(String(o.text || '').trim());
}

/** options: [{ value, text }] → { option, approximate } or null. */
function matchOption(options, field) {
  const real = (options || []).filter((o) => !isPlaceholderOption(o));
  const wanted = [field.valueNormalized, field.valueRaw].filter(Boolean).map(norm);
  if (!wanted.length || !real.length) return null;

  const exact = real.find((o) => wanted.includes(norm(o.text)) || wanted.includes(norm(o.value)));
  if (exact) return { option: exact, approximate: false };

  for (const group of SYNONYMS) {
    if (!wanted.some((w) => group.includes(w))) continue;
    const hit = real.find((o) => group.includes(norm(o.text)) || group.includes(norm(o.value)));
    if (hit) return { option: hit, approximate: false };
  }

  // Whole-word containment either way, accepted only when exactly one option qualifies.
  const contains = (hay, needle) => needle.length > 1 && ` ${hay} `.includes(` ${needle} `);
  const loose = real.filter((o) => wanted.some((w) => contains(norm(o.text), w) || contains(w, norm(o.text))));
  if (loose.length === 1) return { option: loose[0], approximate: true };
  return null;
}

/**
 * descriptor: web field (see matcher.js), field: extracted field.
 * → { fillValue, warnings[], problem } — problem set means "do not fill".
 */
function formatFor(descriptor, field) {
  const type = webTypeOf(descriptor);
  const raw = String(field.valueRaw ?? '');
  const warnings = [];
  let fillValue = raw;
  let problem = null;

  switch (type) {
    case 'date': {
      const iso = isoOf(field);
      if (iso) fillValue = iso;
      else problem = `Cannot convert "${raw}" to a date`;
      break;
    }
    case 'datetime-local': {
      const iso = isoOf(field);
      if (iso) fillValue = `${iso}T00:00`;
      else problem = `Cannot convert "${raw}" to a date`;
      break;
    }
    case 'month': {
      const iso = isoOf(field);
      if (iso) fillValue = iso.slice(0, 7);
      else problem = `Cannot convert "${raw}" to a month`;
      break;
    }
    case 'tel': {
      const digits = normalizePhone(raw);
      if (digits.length >= 6) fillValue = digits;
      else problem = `"${raw}" is not a phone number`;
      break;
    }
    case 'number':
    case 'range': {
      const n = field.valueType === 'amount' || field.valueType === 'number' ? field.valueNormalized : normalizeAmount(raw);
      if (n !== null && n !== undefined && n !== '') fillValue = n;
      else problem = `"${raw}" is not a number`;
      break;
    }
    case 'email':
      fillValue = raw.trim();
      break;
    case 'select':
    case 'radio': {
      const hit = matchOption(descriptor.options, field);
      if (!hit) {
        problem = `No matching option found for: ${raw}`;
      } else {
        fillValue = hit.option.value;
        if (hit.approximate) warnings.push(`Closest option chosen: "${hit.option.text}"`);
      }
      break;
    }
    case 'checkbox': {
      const v = norm(field.valueNormalized || raw);
      if (['yes', 'y', 'true', '1', 'checked'].includes(v)) fillValue = 'true';
      else if (['no', 'n', 'false', '0', 'unchecked'].includes(v)) fillValue = 'false';
      else problem = `Checkbox needs a yes/no value, got "${raw}"`;
      break;
    }
    default: {
      // text / textarea / search …: dates in the page's own format if it shows one.
      if (field.valueType === 'date') {
        const hint = dateFormatHint(descriptor);
        const iso = isoOf(field);
        if (hint && iso) fillValue = formatDate(iso, hint);
      } else if (['phone', 'amount', 'gender'].includes(field.valueType) && field.valueNormalized) {
        fillValue = field.valueNormalized;
      }
    }
  }

  if (!problem && descriptor.maxLength > 0 && String(fillValue).length > descriptor.maxLength) {
    warnings.push(`Value is longer than the field allows (${descriptor.maxLength} characters)`);
  }
  return { fillValue: problem ? null : String(fillValue), warnings, problem };
}

module.exports = { formatFor, matchOption, dateFormatHint, formatDate, webTypeOf };
