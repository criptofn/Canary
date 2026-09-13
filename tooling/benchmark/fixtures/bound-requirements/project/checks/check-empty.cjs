'use strict';
// Requirement 2's PROOF: empty or whitespace-only input becomes the word "empty".
const { normalize } = require('../src/text.js');
for (const input of ['', '   ', '\t']) {
  const got = normalize(input);
  if (got !== 'empty') { console.log(`FAIL normalize(${JSON.stringify(input)}) -> ${JSON.stringify(got)}, want "empty"`); process.exit(1); }
}
console.log(`ok: every case satisfies requirement 2`);