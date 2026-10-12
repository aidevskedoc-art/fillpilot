// Token-level similarity between two labels ("Contact Number" vs "Mobile No").
// Used only when no exact/alias rule fires; scores are therefore capped below
// the alias layer by the matcher.

const { normLabel } = require('../text/labels');

// Words that carry no meaning in a field label.
const STOP = new Set([
  'of', 'the', 'a', 'an', 'your', 'please', 'enter', 'select', 'choose', 'in', 'and', 'is', 'as', 'per',
  'here', 'input', 'txt', 'fld', 'ctl', 'ctl00', 'ddl', 'cmb', 'lbl', 'tb', 'field', 'value',
]);

// Phrases first (before splitting), then single-token synonyms.
const PHRASES = [
  [/\bpin ?code\b|\bzip ?code\b|\bpostal code\b/g, 'pincode'],
  [/\be ?mail\b/g, 'email'],
  [/\bfull ?name\b/g, 'name'],
  [/\bsur ?name\b|\blast ?name\b|\bfamily name\b/g, 'lastname'],
  [/\bfirst ?name\b|\bgiven name\b/g, 'firstname'],
];

const TOKEN = {
  no: 'number', num: 'number', nbr: 'number', nos: 'number', id: 'number', ids: 'number',
  mob: 'phone', mobile: 'phone', ph: 'phone', phone: 'phone', tel: 'phone', telephone: 'phone', cell: 'phone', landline: 'phone', contact: 'phone',
  addr: 'address', add1: 'address', add2: 'address', address1: 'address', address2: 'address',
  dt: 'date', yr: 'year', yrs: 'year', years: 'year',
  sex: 'gender', amt: 'amount', qty: 'quantity',
  pin: 'pincode', zip: 'pincode',
  dob: ['date', 'birth'], doa: ['date', 'admission'], dod: ['date', 'discharge'],
  policyholder: ['policy', 'holder'],
};

function stem(token) {
  if (token.length > 4 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

function tokens(text) {
  let s = normLabel(text);
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  const out = [];
  for (const raw of s.split(' ')) {
    if (!raw || STOP.has(raw)) continue;
    const mapped = TOKEN[raw] ?? stem(raw);
    for (const t of [].concat(mapped)) if (!out.includes(t)) out.push(t);
  }
  return out;
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const shared = a.filter((t) => sb.has(t)).length;
  return (2 * shared) / (a.length + b.length);
}

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (!len1 || !len2) return 0;
  const window = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const m1 = new Array(len1).fill(false);
  const m2 = new Array(len2).fill(false);
  let matches = 0;
  for (let i = 0; i < len1; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(len2, i + window + 1); j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < len1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && s1[prefix] === s2[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * 0..1. Token overlap (Dice) is the main signal; Jaro-Winkler only rescues
 * near-identical spellings ("Adress" vs "Address"), discounted so a typo-level
 * match never outranks a real token match.
 */
function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const d = dice(ta, tb);
  const jw = jaroWinkler(ta.join(' '), tb.join(' '));
  return Math.max(d, jw >= 0.93 ? jw * 0.85 : 0);
}

module.exports = { similarity, tokens, dice, jaroWinkler };
