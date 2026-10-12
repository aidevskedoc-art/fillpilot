// Label text helpers shared by extraction (PDF labels) and matching (web
// form labels). One normalization, so "POLICY NO." in a PDF and "Policy No"
// on a website compare equal.

/** Lowercase, drop parentheticals, required-markers and punctuation; '/' and '&' become word breaks. */
function normLabel(text) {
  return String(text || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/['’`]s\b/g, '')
    .replace(/\bd\.o\.b\b\.?/g, 'dob')
    .replace(/[/_\-\\|]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Patient Name" -> "patientName", "POLICY NO." -> "policyNo". */
function toFieldKey(label) {
  const words = normLabel(label).split(' ').filter(Boolean).slice(0, 8);
  if (words.length === 0) return 'field';
  const key = words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');
  return /^[0-9]/.test(key) ? `f${key}` : key.slice(0, 120);
}

/** "dateOfBirth" / "date_of_birth" / "txtDOB" -> "date of birth" / "date of birth" / "txt dob". */
function splitIdentifier(id) {
  return String(id || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.[\]$:]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normLabel, toFieldKey, splitIdentifier };
