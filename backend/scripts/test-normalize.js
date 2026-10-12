// node scripts/test-normalize.js — value typing and normalization.
const { typeValue, findDate, normalizePhone, normalizeAmount } = require('../src/extraction/normalize');
const { normLabel, toFieldKey } = require('../src/text/labels');
const { check, done } = require('./lib/check');

process.env.DATE_ORDER = 'DMY';

// Dates — always ISO, raw kept by the caller.
check('dd/mm/yyyy is day-first', findDate('10/02/1990').iso, '1990-02-10');
check('dd-MMM-yyyy', findDate('10-Jun-2026').iso, '2026-06-10');
check('Month d, yyyy', findDate('Jun 24, 2026').iso, '2026-06-24');
check('yyyy-mm-dd', findDate('1990-02-10').iso, '1990-02-10');
check('invalid date rejected', findDate('31/02/2026'), null);
check('date inside text, label hint', typeValue('Period Of Insurance From', '00:00hrs of 06/05/2026'), { valueType: 'date', normalized: '2026-05-06', validation: {} });
check('whole-value date with time', typeValue('Date', 'Fri, May 8, 2026 16:54:48 IST').normalized, '2026-05-08');

// Phones
check('+91 prefix stripped', normalizePhone('+91 98765 43210'), '9876543210');
check('phone typed by label', typeValue('Mobile Number', '9876543210'), { valueType: 'phone', normalized: '9876543210', validation: {} });
check('11-digit phone flagged', typeValue('Mobile', '98765432101').validation.problems, ['Expected a 10-digit phone number']);

// Amounts
check('₹25,000 → 25000', normalizeAmount('₹25,000'), '25000');
check('Rs. 2,499.50', normalizeAmount('Rs. 2,499.50'), '2499.5');
check('amount typed', typeValue('Total Premium', '8,514.00'), { valueType: 'amount', normalized: '8514', validation: {} });

// Email, gender
check('email lowercased', typeValue('Email', 'UNITEDAGENT99@GMAIL.COM').normalized, 'unitedagent99@gmail.com');
check('M under Gender label', typeValue('Gender', 'M').normalized, 'Male');
check('"Other" is not a gender without a gender label', typeValue('Occupation', 'Other').valueType, 'text');

// Long identifiers stay text
check('20-digit receipt number stays text', typeValue('Receipt Number', '10105030226131499942').valueType, 'text');
check('leading-zero id stays text', typeValue('Code', '050302').valueType, 'text');

// Labels
check('normLabel strips punctuation', normLabel('POLICY NO.'), 'policy no');
check('normLabel possessive', normLabel('Policy Holder’s Name'), 'policy holder name');
check('normLabel D.O.B', normLabel('D.O.B.'), 'dob');
check('normLabel parenthetical', normLabel('Date of Birth (Age)'), 'date of birth');
check('field key', toFieldKey('Patient Name'), 'patientName');
check('field key from caps', toFieldKey('POLICY NO.'), 'policyNo');

done('normalize');
