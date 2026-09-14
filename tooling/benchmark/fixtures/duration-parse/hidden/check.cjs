'use strict';
/**
 * THE HIDDEN ORACLE for the duration task: the REJECTION rule the task states and the visible suite
 * does not cover, plus the well-formed forms, so a solution that throws on everything cannot pass by
 * being strict.
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

let parseDuration;
try {
  ({ parseDuration } = require(path.join(projectDir, 'src', 'duration.js')));
} catch (e) {
  console.log(`FAIL the module could not be loaded: ${e && e.message ? e.message : e}`);
  process.exit(1);
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const is = (input, expected) => {
  const actual = parseDuration(input);
  if (actual !== expected) throw new Error(`parseDuration(${JSON.stringify(input)}): expected ${expected}, got ${String(actual)}`);
};
const refuses = (input) => {
  let threw = false;
  let message = '';
  try { parseDuration(input); } catch (e) { threw = true; message = String(e && e.message); }
  if (!threw) throw new Error(`parseDuration(${JSON.stringify(input)}) must throw, but it returned a value`);
  if (!/invalid duration/.test(message)) throw new Error(`the error must contain "invalid duration", got ${JSON.stringify(message)}`);
};

// --- well-formed inputs (the visible suite already covers three of these) -------------------
check('minutes only', () => is('90m', 90));
check('hours only', () => is('2h', 120));
check('hours and minutes', () => is('1h30m', 90));
check('a single hour', () => is('1h', 60));
check('leading zeros are allowed', () => is('01h', 60));
check('a repeated group is allowed', () => is('1h1h', 120));
check('large values', () => is('10h45m', 645));

// --- the REJECTION rule: a number with no unit is not a group ------------------------------
check('a trailing bare number is refused', () => refuses('1h30'));
check('a bare number is refused', () => refuses('90'));

// --- the REJECTION rule: a unit with no number is not a group ------------------------------
check('a unit before its number is refused', () => refuses('m90'));
check('a lone unit is refused', () => refuses('h'));

// --- the REJECTION rule: only h and m are units --------------------------------------------
check('an unknown unit is refused', () => refuses('1x'));
check('a seconds unit is refused', () => refuses('30s'));

// --- the REJECTION rule: nothing else is a duration ----------------------------------------
check('an empty string is refused', () => refuses(''));
check('a space is refused', () => refuses(' '));
check('a space between groups is refused', () => refuses('1h 30m'));
check('a colon form is refused', () => refuses('1:30'));
check('a non-string is refused', () => refuses(null));

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
