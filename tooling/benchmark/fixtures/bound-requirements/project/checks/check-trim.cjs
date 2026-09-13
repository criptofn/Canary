'use strict';
// Requirement 1's PROOF: leading and trailing whitespace is trimmed.
const { normalize } = require('../src/text.js');
const cases = [['  ada  ', 'ada'], ['\tada\n', 'ada'], ['ada', 'ada']];
for (const [input, want] of cases) {
  const got = normalize(input);
  if (got !== want) { console.log(`FAIL trim(${JSON.stringify(input)}) -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); process.exit(1); }
}
console.log(`ok: every case satisfies requirement 1`);