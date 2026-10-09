// Captured Vitest 3 output shape from the native Refactron pilot, with short fixture paths.
const fs = require('node:fs');
if (!fs.existsSync('.fixture-fail')) {
  console.log('3 tests passed');
} else {
  console.log(' \x1b[32m✓\x1b[39m tests/unit/passing.test.ts (1 test)');
  console.error('\x1b[31mError: expected caught error in a passing test\x1b[39m');
  console.error('\x1b[36m ❯ tests/unit/passing.test.ts:7:3\x1b[39m');
  if (process.argv[2] === 'collection') {
    console.error('\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/unit/cli/help-drift.test.ts\x1b[2m [ tests/unit/cli/help-drift.test.ts ]\x1b[22m');
    console.error('\x1b[31m\x1b[1mError\x1b[22m: dist CLI not found. Run npm run build before npm test.\x1b[39m');
    console.error('\x1b[36m \x1b[2m❯\x1b[22m tests/unit/cli/help-drift.test.ts:\x1b[2m37:9\x1b[22m\x1b[39m');
  } else {
    console.error('\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/unit/failure-ids.test.ts\x1b[2m > \x1b[22mextractFailureIds\x1b[2m > \x1b[22mpreserves hyphenated params');
    console.error('\x1b[31m\x1b[1mAssertionError\x1b[22m: expected false to be true // Object.is equality\x1b[39m');
    console.error('\x1b[36m \x1b[2m❯\x1b[22m tests/unit/failure-ids.test.ts:\x1b[2m42:9\x1b[22m\x1b[39m');
  }
  process.exitCode = 1;
}
