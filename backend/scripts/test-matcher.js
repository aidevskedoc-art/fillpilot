// node scripts/test-matcher.js — the requirement document's matching examples.
const { matchForm, formKeyFor, fieldSignature } = require('../src/matching/matcher');
const { buildAliasIndex, seedAliases } = require('../src/alias-index');
const { typeValue } = require('../src/extraction/normalize');
const { check, checkTrue, done } = require('./lib/check');

process.env.DATE_ORDER = 'DMY';
const aliasIndex = buildAliasIndex(seedAliases());
const { normLabel, toFieldKey } = require('../src/text/labels');

let nextId = 1;
function pdfField(label, value, documentId = 'doc-1') {
  const typed = typeValue(label, value);
  return {
    id: nextId++,
    documentId,
    fieldKey: toFieldKey(label),
    canonicalKey: aliasIndex.get(normLabel(label)) || null,
    label,
    valueRaw: value,
    valueNormalized: typed.normalized,
    valueType: typed.valueType,
    confidence: 0.95,
  };
}

let ref = 0;
function web(label, extra = {}) {
  return { ref: `f${ref++}`, frameId: 0, tag: 'input', type: 'text', label, ...extra };
}

const pdf = [
  pdfField('Patient Name', 'Rahul Kumar'),
  pdfField('Patient ID', 'YH12345'),
  pdfField('Date of Birth', '10/02/1990'),
  pdfField('Gender', 'Male'),
  pdfField('Mobile Number', '9876543210'),
  pdfField('Address', 'Hyderabad'),
];

const run = (descriptors, fields = pdf, saved) => matchForm({ descriptors, fields, aliasIndex, saved });
const byLabel = (result, label) => result.fields.find((f) => f.label === label);

// Section 5: different wording on the website.
{
  const r = run([
    web('Name of Patient'),
    web('Patient Full Name'),
    web('Contact Number'),
    web('DOB'),
    web('Residential Address'),
  ]);
  for (const [webLabel, pdfLabel] of [
    ['Name of Patient', 'Patient Name'],
    ['Contact Number', 'Mobile Number'],
    ['DOB', 'Date of Birth'],
    ['Residential Address', 'Address'],
  ]) {
    const f = byLabel(r, webLabel);
    check(`${webLabel} → ${pdfLabel}`, f.selected?.label, pdfLabel);
    checkTrue(`${webLabel} confidence ≥ 0.85`, f.selected?.confidence >= 0.85, String(f.selected?.confidence));
  }
}

// Section 4: the full example form, all six auto-matched.
{
  const r = run([
    web('Patient Name'),
    web('Patient ID'),
    web('Date of Birth', { type: 'date' }),
    web('Gender', { tag: 'select', type: 'select-one', options: [{ value: '', text: 'Select Gender' }, { value: 'M', text: 'Male' }, { value: 'F', text: 'Female' }, { value: 'O', text: 'Other' }] }),
    web('Mobile Number', { type: 'tel' }),
    web('Address', { tag: 'textarea' }),
  ]);
  check('example form: 6 matched', r.summary, { detected: 6, matched: 6, review: 0, unmatched: 0 });
  // Section 8: date conversion, original kept.
  const dob = byLabel(r, 'Date of Birth');
  check('date input gets ISO', dob.selected.fillValue, '1990-02-10');
  check('original date kept', dob.selected.originalValue, '10/02/1990');
  // Section 7: dropdown picks the existing option's value.
  check('gender select → option value M', byLabel(r, 'Gender').selected.fillValue, 'M');
}

// Section 7: no matching option → not filled, never a random pick.
{
  const r = run([web('Gender', { tag: 'select', options: [{ value: '', text: 'Select' }, { value: 'F', text: 'Female' }, { value: 'O', text: 'Other' }] })]);
  const g = r.fields[0];
  check('no option: fill value is null', g.selected.fillValue, null);
  check('no option: not included', g.include, false);
  checkTrue('no option: message', g.warnings.includes('No matching option found for: Male'), JSON.stringify(g.warnings));
}

// Section 24: one PDF address, three website address fields → user must choose.
{
  const r = run([web('Current Address'), web('Permanent Address'), web('Communication Address')]);
  checkTrue('multiple address fields all need review', r.fields.every((f) => f.status === 'review'), JSON.stringify(r.fields.map((f) => f.status)));
  checkTrue('multiple address fields warn', r.fields.every((f) => f.warnings.some((w) => w.includes('also fits'))));
}

// Section 11: low confidence — not auto-filled, candidates offered.
{
  const fields = [pdfField('Contact Person', 'Suresh'), pdfField('Relative Name', 'Lakshmi'), pdfField('Emergency Contact Name', 'Lakshmi K')];
  const r = run([web('Emergency Contact')], fields);
  const f = r.fields[0];
  checkTrue('low confidence is not included', !f.include);
  checkTrue('low confidence offers candidates', f.candidates.length >= 2, JSON.stringify(f.candidates));
}

// An email box never receives a non-email value.
{
  const r = run([web('Contact', { type: 'email' })]);
  checkTrue('email box rejects phone', !r.fields[0].include, JSON.stringify(r.fields[0].selected));
}

// Text field with a visible date format.
{
  const r = run([web('Date of Birth', { placeholder: 'DD-MM-YYYY' })]);
  check('text date in page format', r.fields[0].selected.fillValue, '10-02-1990');
}

// Field ids / names when there is no label.
{
  const r = run([{ ref: 'x', tag: 'input', type: 'text', name: 'ctl00$Main$txtPatientName', id: 'txtPatientName' }]);
  check('ASP.NET style name matched', r.fields[0].selected?.label, 'Patient Name');
}

// Saved mapping wins over everything.
{
  const d = web('Name of Beneficiary');
  const saved = new Map([[fieldSignature(d), { field_key: 'patientName', canonical_key: 'patientName' }]]);
  const r = run([d], pdf, saved);
  check('saved mapping source', r.fields[0].selected.source, 'saved');
  check('saved mapping confidence', r.fields[0].selected.confidence, 1);
}

// Section 14: same key in two documents with different values → conflict.
{
  const fields = [pdfField('Patient Name', 'Rahul Kumar', 'doc-1'), pdfField('Patient Name', 'Rahul K.', 'doc-2')];
  const r = run([web('Patient Name')], fields);
  checkTrue('conflict flagged', r.fields[0].warnings.some((w) => w.startsWith('Conflicting values')), JSON.stringify(r.fields[0].warnings));
  check('conflict needs review', r.fields[0].status, 'review');
}

// Form key ignores record ids and query strings.
check('form key normalizes ids', formKeyFor('/patients/12345/edit?tab=2'), '/patients/:id/edit');

// Never fill password / file / hidden inputs.
{
  const r = run([web('Password', { type: 'password' }), web('Upload', { type: 'file' })]);
  check('password/file skipped', r.summary.detected, 0);
}

done('matcher');
