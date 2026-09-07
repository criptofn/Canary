// Test fixture: prints a green-looking "427 passing" summary but EXIT 1.
// M2 attack case — a printed claim must never fake a pass, and a claim that
// MATCHES the printed lie still cannot stop Canary from blocking on exit code.
console.log('  427 passing (1s)');
process.exit(1);
