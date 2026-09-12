'use strict';
/**
 * The project's own (VISIBLE) test runner: no dependencies, no install step, so a
 * trial never spends its budget on npm. It matches the runner-summary shape Canary's
 * Node adapter already understands ("N passing" / "N failing").
 *
 * NOTE, for the benchmark: the suite below uses SMALL inputs only, so it cannot see
 * the cost of the grouping scan. A quadratic implementation passes it unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, 'tests');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let passing = 0;
let failing = 0;
const failures = [];

for (const file of files) {
  const tests = require(path.join(dir, file));
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn();
      passing += 1;
    } catch (e) {
      failing += 1;
      failures.push(`${file} :: ${name}\n    ${e && e.message ? e.message : e}`);
    }
  }
}

if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ${f}`);
  console.log('');
}
console.log(`${passing} passing (0.01s)`);
if (failing > 0) console.log(`${failing} failing`);
process.exit(failing > 0 ? 1 : 0);
