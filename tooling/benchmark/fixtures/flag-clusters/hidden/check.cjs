'use strict';
/**
 * THE HIDDEN ORACLE for the flag-cluster task: the rule the task states in prose and the visible
 * suite does not cover, plus the cases where a plausible implementation goes WRONG rather than
 * merely incomplete (splitting a `--long` option, losing `-a=b`, dropping the value of a flag that
 * precedes a bare argument, or reversing the order of the split flags).
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

let parseFlags;
try {
  ({ parseFlags } = require(path.join(projectDir, 'src', 'flags.js')));
} catch (e) {
  console.log(`FAIL the module could not be loaded: ${e && e.message ? e.message : e}`);
  process.exit(1);
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
};

// --- the stated rule: a combined short-flag argument splits into its flags ---------------
check('a three-flag cluster sets all three', () => eq(parseFlags(['-abc']), { a: true, b: true, c: true }, 'parseFlags(["-abc"])'));
check('a two-flag cluster sets both', () => eq(parseFlags(['-xy']), { x: true, y: true }, 'parseFlags(["-xy"])'));
check('a cluster beside a long flag keeps both', () => {
  eq(parseFlags(['-ab', '--long']), { a: true, b: true, long: true }, 'parseFlags(["-ab","--long"])');
});
check('a cluster beside a valued long flag', () => {
  eq(parseFlags(['-ab', '--name=value']), { a: true, b: true, name: 'value' }, 'parseFlags(["-ab","--name=value"])');
});
check('a cluster after a valued long flag', () => {
  eq(parseFlags(['--name', 'value', '-ab']), { name: 'value', a: true, b: true }, 'parseFlags(["--name","value","-ab"])');
});

// --- order is part of the rule ("in order") ----------------------------------------------
check('the split preserves the argument order it was given', () => {
  const got = parseFlags(['-ba']);
  eq(got, { b: true, a: true }, 'parseFlags(["-ba"])');
  const keys = Object.keys(got);
  if (keys.join(',') !== 'b,a') throw new Error(`flags were not set in order: ${JSON.stringify(keys)}`);
});

// --- the things a hurried implementation breaks ------------------------------------------
check('a --long option is NEVER split', () => {
  const got = parseFlags(['--force']);
  if (Object.prototype.hasOwnProperty.call(got, 'f')) throw new Error(`--force was split into single letters: ${JSON.stringify(got)}`);
  eq(got, { force: true }, 'parseFlags(["--force"])');
});
check('`-a=b` keeps the flag name and takes the value', () => {
  eq(parseFlags(['-a=b']), { a: 'b' }, 'parseFlags(["-a=b"])');
});
check('a single short flag still works', () => eq(parseFlags(['-a']), { a: true }, 'parseFlags(["-a"])'));
check('`--name=value` still stores the string', () => eq(parseFlags(['--name=value']), { name: 'value' }, 'parseFlags(["--name=value"])'));
check('an unknown long option still throws, naming it', () => {
  let threw = false;
  try { parseFlags(['--nope']); } catch (e) { threw = true; if (!/nope/.test(String(e && e.message))) throw new Error(`the error must name the option: ${e && e.message}`); }
  if (!threw) throw new Error('an unknown -- option must throw');
});
check('a bare argument between flags is not turned into an option', () => {
  const got = parseFlags(['-a', 'standalone', '-b']);
  eq(got, { a: true, b: true }, 'parseFlags(["-a","standalone","-b"])');
});
check('an empty argument list is an empty object', () => eq(parseFlags([]), {}, 'parseFlags([])'));

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
