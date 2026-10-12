// Value typing + normalization. The raw value is never replaced — callers
// store both, so a user can always see what the PDF actually said.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function pad(n) {
  return String(n).padStart(2, '0');
}

function fullYear(y) {
  const n = Number(y);
  if (String(y).length === 4) return n;
  // Two-digit years: 00–(current+1) → 20xx, otherwise 19xx (dates of birth).
  const pivot = (new Date().getFullYear() % 100) + 1;
  return n <= pivot ? 2000 + n : 1900 + n;
}

function isoIfValid(y, m, d) {
  const year = fullYear(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const DATE_PATTERNS = [
  // 2026-05-06, 2026/05/06
  { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/, parse: (m) => isoIfValid(m[1], m[2], m[3]) },
  // 06/05/2026, 06-05-2026, 06.05.26 — order depends on DATE_ORDER
  {
    re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/,
    parse: (m, order) => (order === 'MDY' ? isoIfValid(m[3], m[1], m[2]) : isoIfValid(m[3], m[2], m[1])),
  },
  // 10-Jun-2026, 10 June 2026, 10th May, 2026
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.]*(${MONTH_NAMES})[a-z]*\\.?[\\s\\-/.,]*(\\d{4}|\\d{2})\\b`, 'i'),
    parse: (m) => isoIfValid(m[3], MONTHS[m[2].toLowerCase()], m[1]),
  },
  // Jun 24, 2026 / June 24 2026
  {
    re: new RegExp(`\\b(${MONTH_NAMES})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'),
    parse: (m) => isoIfValid(m[3], MONTHS[m[1].toLowerCase()], m[2]),
  },
];

/** First date found in text → { iso, match } or null. */
function findDate(text, order = process.env.DATE_ORDER || 'DMY') {
  const s = String(text || '');
  for (const { re, parse } of DATE_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      const iso = parse(m, order);
      if (iso) return { iso, match: m[0], index: m.index };
    }
  }
  return null;
}

/** The whole value is a date (allowing a trailing time / "hrs") → ISO, else null. */
function parseWholeDate(text, order) {
  const s = String(text || '').trim();
  const found = findDate(s, order);
  if (!found) return null;
  const rest = (s.slice(0, found.index) + s.slice(found.index + found.match.length))
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm|hrs?|ist)?\b/gi, '')
    .replace(/[\s,.\-:]+/g, '');
  return rest.length === 0 ? found.iso : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function normalizePhone(text) {
  let digits = String(text || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

const AMOUNT_RE = /^(?:₹|rs\.?|inr|\$)?\s*-?[\d,]+(?:\.\d+)?\s*(?:\/-|inr|rs\.?)?$/i;

function normalizeAmount(text) {
  const s = String(text || '')
    .replace(/₹|rs\.?|inr|\/-|\(.*?\)/gi, '')
    .replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

const GENDERS = { m: 'Male', male: 'Male', f: 'Female', female: 'Female', o: 'Other', other: 'Other', others: 'Other', transgender: 'Other' };

function normalizeGender(text) {
  return GENDERS[String(text || '').trim().toLowerCase().replace(/\.$/, '')] || null;
}

const LABEL_HINTS = {
  date: /\b(date|dob|d\.o\.b|birth|from|to|till|upto|expiry|inception|issued|admission|discharge)\b/i,
  phone: /\b(mobile|phone|contact|tel|telephone|cell|landline|whatsapp)\b/i,
  amount: /\b(amount|premium|sum|fee|fees|total|price|cost|charges|insured|assured|paid|balance|due|discount|gst|tax)\b/i,
  gender: /\b(gender|sex)\b/i,
  email: /\b(e-?mail|mail)\b/i,
};

/**
 * Detects the value's type from the value itself, helped by the label.
 * Returns { valueType, normalized, validation } — validation lists problems
 * (flags, never drops: a suspicious value is still shown for the user to fix).
 */
function typeValue(label, raw) {
  const value = String(raw || '').trim();
  const lbl = String(label || '');
  const problems = [];

  if (EMAIL_RE.test(value)) return { valueType: 'email', normalized: value.toLowerCase(), validation: {} };
  if (LABEL_HINTS.email.test(lbl) && value.includes('@')) {
    return { valueType: 'email', normalized: value, validation: { problems: ['Not a valid email address'] } };
  }

  // "M" or "Other" are genders only under a gender label; "Male"/"Female" are unambiguous anywhere.
  const gender = normalizeGender(value);
  if (gender && (LABEL_HINTS.gender.test(lbl) || /^(male|female)$/i.test(value))) {
    return { valueType: 'gender', normalized: gender, validation: {} };
  }

  const wholeDate = parseWholeDate(value);
  if (wholeDate) return { valueType: 'date', normalized: wholeDate, validation: {} };
  if (LABEL_HINTS.date.test(lbl)) {
    const found = findDate(value);
    if (found) return { valueType: 'date', normalized: found.iso, validation: {} };
  }

  if (LABEL_HINTS.phone.test(lbl) || /^(\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/.test(value)) {
    const digits = normalizePhone(value);
    if (digits.length >= 10 && digits.length <= 12 && /^[\d\s+\-()/]+$/.test(value)) {
      if (digits.length !== 10) problems.push('Expected a 10-digit phone number');
      return { valueType: 'phone', normalized: digits, validation: problems.length ? { problems } : {} };
    }
  }

  if (/[₹]|^rs\.?\s*\d|^inr\s*\d/i.test(value) || (LABEL_HINTS.amount.test(lbl) && /^[\d,]+\.\d{2}$/.test(value))) {
    const amount = normalizeAmount(value);
    if (amount !== null) return { valueType: 'amount', normalized: amount, validation: {} };
  }

  // Short plain numbers only. Long digit strings (policy, receipt, UHID numbers)
  // stay text so nothing ever rounds or strips their leading zeros.
  if (/^\d{1,7}(\.\d+)?$/.test(value) && !/^0\d/.test(value)) {
    return { valueType: 'number', normalized: value, validation: {} };
  }

  return { valueType: 'text', normalized: null, validation: {} };
}

module.exports = {
  findDate,
  parseWholeDate,
  normalizePhone,
  normalizeAmount,
  normalizeGender,
  typeValue,
  isoIfValid,
  AMOUNT_RE,
  EMAIL_RE,
};
