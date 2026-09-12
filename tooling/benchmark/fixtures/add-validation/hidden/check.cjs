'use strict';
/**
 * THE HIDDEN ORACLE for the validation task: the rules the task states but the
 * visible suite does not cover, plus the cases where a plausible implementation goes
 * WRONG rather than merely incomplete (accepting `a@b` because it "looks fine",
 * rejecting `a@b.co` because the check was too strict, throwing on a non-string).
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

let validateEmail;
let normalizeEmail;
try {
  ({ validateEmail, normalizeEmail } = require(path.join(projectDir, 'src', 'validate.js')));
} catch (e) {
  console.log(`FAIL the module could not be loaded: ${e && e.message ? e.message : e}`);
  process.exit(1);
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const shape = (actual, ok, reason, label) => {
  if (actual === null || typeof actual !== 'object') throw new Error(`${label}: not an object`);
  if (actual.ok !== ok) throw new Error(`${label}: ok should be ${ok}, got ${String(actual.ok)}`);
  if (ok === false && actual.reason !== reason) throw new Error(`${label}: reason should be "${reason}", got "${String(actual.reason)}"`);
  if (ok === true && actual.reason !== '') throw new Error(`${label}: reason should be "" when accepted, got "${String(actual.reason)}"`);
};

// rule 1 — required
for (const v of ['', '   ', null, undefined, 42, {}]) {
  check(`required: ${JSON.stringify(v)}`, () => shape(validateEmail(v), false, 'required', JSON.stringify(v)));
}
// rule 2 — whitespace
for (const v of ['a b@example.com', ' a@example.com', 'a@example.com ']) {
  check(`whitespace: ${JSON.stringify(v)}`, () => shape(validateEmail(v), false, 'whitespace', JSON.stringify(v)));
}
// rule 3 — at sign
for (const v of ['nodomain.com', 'a@@b.com', 'a@b@c.com']) {
  check(`at_sign: ${JSON.stringify(v)}`, () => shape(validateEmail(v), false, 'at_sign', JSON.stringify(v)));
}
// rule 4 — empty parts
for (const v of ['@example.com', 'someone@']) {
  check(`missing_part: ${JSON.stringify(v)}`, () => shape(validateEmail(v), false, 'missing_part', JSON.stringify(v)));
}
// rule 5 — domain shape
for (const v of ['a@b', 'a@b.', 'a@.b', 'a@b..c']) {
  check(`bad_domain: ${JSON.stringify(v)}`, () => shape(validateEmail(v), false, 'bad_domain', JSON.stringify(v)));
}
// accepted, including the forms a too-strict regex rejects
for (const v of ['someone@example.com', 'a@b.co', 'first.last+tag@sub.example.co.uk', 'x@y.io']) {
  check(`accepted: ${JSON.stringify(v)}`, () => shape(validateEmail(v), true, '', JSON.stringify(v)));
}
// the frozen contract of the other export
check('normalizeEmail is unchanged', () => {
  if (typeof normalizeEmail !== 'function') throw new Error('normalizeEmail is not a function');
  if (normalizeEmail('  SomeOne@Example.COM ') !== 'someone@example.com') throw new Error('normalizeEmail changed behaviour');
  if (normalizeEmail(null) !== '') throw new Error('normalizeEmail must tolerate a non-string');
});

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
