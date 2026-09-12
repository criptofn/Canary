'use strict';
/**
 * The project's own test runner — ASYNC-AWARE, because this fixture's check has to
 * await a connection attempt. (The other fixtures' runner is sync; this one is the
 * one that needed the upgrade, and a sync runner would have silently passed every
 * async test by never awaiting it — the classic "0 failing" illusion.)
 */
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const dir = path.join(__dirname, 'tests');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

  let passing = 0;
  let failing = 0;
  const failures = [];

  for (const file of files) {
    const tests = require(path.join(dir, file));
    for (const [name, fn] of Object.entries(tests)) {
      try {
        await fn();
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
})();
