// Test fixture: a check that fails loudly with a recognizable line + exit 3.
console.log('boom: expected 1, got 2');
process.exit(3);
