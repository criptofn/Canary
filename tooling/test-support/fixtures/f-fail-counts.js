// Test fixture: a failing check whose OUTPUT claims near-green mocha-style
// counts (2 passing / 1 failing). M2: Canary derives observation counts from
// these bytes, but the exit code alone carries the verdict.
console.log('  2 passing (12ms)');
console.log('  1 failing');
process.exit(1);
