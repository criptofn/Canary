'use strict';
/**
 * THE HIDDEN ORACLE for the "accept decimal strings" task: the NEW behaviour, and —
 * the part that matters — the DOCUMENTED behaviour that must survive the change. A
 * refactor that goes through a single "parse then format" path very often loses one of
 * these: the sign ends up after the symbol, `decimals: 0` starts emitting ".00", or
 * `grouping: false` is quietly dropped.
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

let formatMoney;
try { ({ formatMoney } = require(path.join(projectDir, 'src', 'money.js'))); }
catch (e) { console.log(`FAIL the module could not be loaded: ${e && e.message ? e.message : e}`); process.exit(1); }

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const eq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// ── the NEW behaviour ──
check('string amount equals the integer form', () => eq(formatMoney('12.34'), formatMoney(1234), '"12.34"'));
check('string amount without decimals', () => eq(formatMoney('7'), formatMoney(700), '"7"'));
check('one decimal place', () => eq(formatMoney('0.5'), formatMoney(50), '"0.5"'));
check('negative string amount', () => eq(formatMoney('-3.21'), formatMoney(-321), '"-3.21"'));
check('string amount with options', () => eq(formatMoney('12.34', { symbol: '€' }), '€12.34', 'string + symbol'));
check('invalid string still throws the same TypeError', () => {
  for (const bad of ['abc', '1.2.3', '', '--1', '1,234']) {
    let threw = null;
    try { formatMoney(bad); } catch (e) { threw = e; }
    if (threw === null) throw new Error(`formatMoney(${JSON.stringify(bad)}) did not throw`);
    if (!(threw instanceof TypeError)) throw new Error(`formatMoney(${JSON.stringify(bad)}) threw ${threw.constructor.name}, expected TypeError`);
  }
});
check('a non-number, non-string still throws', () => {
  for (const bad of [null, undefined, {}, NaN, Infinity]) {
    let threw = null;
    try { formatMoney(bad); } catch (e) { threw = e; }
    if (threw === null) throw new Error(`formatMoney(${String(bad)}) did not throw`);
  }
});

// ── PRESERVATION of every documented behaviour ──
check('preserved: plain grouping', () => eq(formatMoney(123456), '$1,234.56', 'plain'));
check('preserved: zero', () => eq(formatMoney(0), '$0.00', 'zero'));
check('preserved: sign before the symbol', () => eq(formatMoney(-5), '-$0.05', 'negative'));
check('preserved: custom symbol', () => eq(formatMoney(5, { symbol: '€' }), '€0.05', 'symbol'));
check('preserved: decimals: 0', () => eq(formatMoney(5, { decimals: 0 }), '$0', 'decimals 0'));
check('preserved: grouping: false', () => eq(formatMoney(1234, { grouping: false }), '$12.34', 'grouping off'));
check('preserved: round up', () => eq(formatMoney(124, { round: 'up' }), '$1.24', 'round up'));
check('preserved: round down', () => eq(formatMoney(126, { round: 'down' }), '$1.26', 'round down'));
check('preserved: integer input is unchanged', () => {
  for (const cents of [0, 1, 99, 100, 12345, -12345, 100000000]) {
    const before = formatMoney(cents);
    if (typeof before !== 'string' || !before.startsWith(cents < 0 ? '-$' : '$')) throw new Error(`formatMoney(${cents}) -> ${before}`);
  }
});

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
