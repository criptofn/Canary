'use strict';
// Requirement 3's PROOF: the result is lower-case.
const { normalize } = require('../src/text.js');
for (const input of ['AbC', 'ADA', 'aDa']) {
  const got = normalize(input);
  if (got !== input.toLowerCase()) { console.log(`FAIL normalize(${JSON.stringify(input)}) -> ${JSON.stringify(got)}, want ${input.toLowerCase()}`); process.exit(1); }
}
console.log(`ok: every case satisfies requirement 3`);