'use strict';
/**
 * THE HIDDEN ORACLE for `bound-requirements`.
 *
 * The three stated requirements each have a check in the project (`checks/check-*.cjs`, declared in
 * `canary.project.json` and bound to the requirement digest). This oracle is INDEPENDENT of those:
 * it tests the behaviour from outside, including cases the per-requirement checks do not choose, so
 * "the bound checks pass" and "the requirements actually hold" are two measurements and the gap
 * between them stays visible.
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};

let normalize = null;
let loadError = '';
try { ({ normalize } = require(path.join(projectDir, 'src', 'text.js'))); }
catch (e) { loadError = e && e.message ? e.message : String(e); }

if (typeof normalize !== 'function') {
  console.log(`FAIL src/text.js must export normalize: ${loadError || 'not a function'}`);
  console.log('hidden oracle: 0/1 behaviour checks passed');
  process.exit(1);
}
const eq = (label, actual, expected) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// requirement 1 — trimming, including whitespace the per-requirement check does not choose
check('trims leading and trailing spaces', () => eq(`normalize('  ada  ')`, normalize('  ada  '), 'ada'));
check('trims tabs and newlines', () => eq('normalize("\\tada\\n")', normalize('\tada\n'), 'ada'));
check('leaves an already-trimmed value alone', () => eq(`normalize('ada')`, normalize('ada'), 'ada'));
check('trims before lower-casing, not after', () => eq(`normalize('  ADA  ')`, normalize('  ADA  '), 'ada'));

// requirement 2 — empty/whitespace-only becomes the word
check('an empty string becomes "empty"', () => eq(`normalize('')`, normalize(''), 'empty'));
check('spaces only becomes "empty"', () => eq(`normalize('   ')`, normalize('   '), 'empty'));
check('a tab only becomes "empty"', () => eq('normalize("\\t")', normalize('\t'), 'empty'));
check('"empty" itself is not re-wrapped', () => eq(`normalize('empty')`, normalize('empty'), 'empty'));

// requirement 3 — lower-case
check('lower-cases mixed case', () => eq(`normalize('AbC')`, normalize('AbC'), 'abc'));
check('lower-cases with surrounding space', () => eq(`normalize(' ADA ')`, normalize(' ADA '), 'ada'));
check('lower-case input is unchanged', () => eq(`normalize('ada')`, normalize('ada'), 'ada'));

// the contract the checks rely on
check('a non-string is coerced, never thrown at', () => {
  const got = normalize(12);
  if (typeof got !== 'string') throw new Error(`expected a string, got ${typeof got}`);
  eq('normalize(12)', got, '12');
});

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
