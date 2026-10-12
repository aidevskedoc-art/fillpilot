// Tiny assertion helper shared by the plain-node test scripts.
const results = { passed: 0, failed: 0 };

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) results.passed++;
  else results.failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`);
}

function checkTrue(name, condition, detail = '') {
  check(name + (detail && !condition ? ` (${detail})` : ''), Boolean(condition), true);
}

function done(suite) {
  console.log(`\n${suite}: ${results.passed} passed, ${results.failed} failed`);
  process.exitCode = results.failed ? 1 : 0;
}

module.exports = { check, checkTrue, done };
