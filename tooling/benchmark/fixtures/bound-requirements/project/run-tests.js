'use strict';
/**
 * The project's own (VISIBLE) test runner — the benchmark harness runs this as the project's suite.
 * It exercises ONLY the identity case, so it is green before any of the three requirements is
 * implemented: the gap between "the suite is green" and "the declared requirements are met" is
 * exactly what this fixture measures.
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
    try { fn(); passing += 1; }
    catch (e) { failing += 1; failures.push(`${file} :: ${name}\n    ${e && e.message ? e.message : e}`); }
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
