'use strict';
/**
 * THE HIDDEN ORACLE for `parseDuration`: every rule the task states, including the ones a
 * partial implementation typically misses (case-insensitivity, internal whitespace,
 * descending-order enforcement, repeated units, whitespace inside a part, `0s`).
 *
 * The visible suite covers three of these, so a green visible suite says very little —
 * which is the point of the fixture.
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

let parseDuration;
try { ({ parseDuration } = require(path.join(projectDir, 'src', 'duration.js'))); }
catch (e) { console.log(`FAIL the module could not be loaded: ${e && e.message ? e.message : e}`); process.exit(1); }

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const eq = (text, expected) => {
  const actual = parseDuration(text);
  if (actual !== expected) throw new Error(`parseDuration(${JSON.stringify(text)}): expected ${expected}, got ${String(actual)}`);
};
const rejects = (value) => {
  let threw = null;
  try { parseDuration(value); } catch (e) { threw = e; }
  if (threw === null) throw new Error(`parseDuration(${JSON.stringify(value)}) did not throw`);
  if (!(threw instanceof TypeError)) throw new Error(`parseDuration(${JSON.stringify(value)}) threw ${threw.constructor.name}, expected TypeError`);
};

// ── accepted ──
check('"90s" -> 90', () => eq('90s', 90));
check('"2m" -> 120', () => eq('2m', 120));
check('"1d" -> 86400', () => eq('1d', 86400));
check('"1h30m" -> 5400', () => eq('1h30m', 5400));
check('"1d2h3m4s" -> 93784', () => eq('1d2h3m4s', 93784));
check('"0s" -> 0', () => eq('0s', 0));
check('"00h05m" -> 300', () => eq('00h05m', 300));
check('internal space "1h 30m"', () => eq('1h 30m', 5400));
check('surrounding space " 1h30m "', () => eq(' 1h30m ', 5400));
check('many spaces "1d  2h"', () => eq('1d  2h', 93600));
check('uppercase "1H30M"', () => eq('1H30M', 5400));
check('mixed case "1D2h" -> 93600', () => eq('1D2h', 93600));

// ── rejected ──
check('rejects non-strings', () => { for (const v of [null, undefined, 42, {}, [], true]) rejects(v); });
check('rejects an empty or blank string', () => { for (const v of ['', '   ']) rejects(v); });
check('rejects a missing unit', () => rejects('90'));
check('rejects an unknown unit', () => { rejects('1x'); rejects('1h2x'); });
check('rejects descending-order violations', () => { rejects('1m1h'); rejects('1s1m1h'); });
check('rejects a repeated unit', () => { rejects('1h1h'); rejects('1m2m'); });
check('rejects signed numbers', () => { rejects('-5s'); rejects('+5s'); });
check('rejects fractions', () => { rejects('1.5h'); rejects('0.5s'); });
check('rejects trailing garbage', () => { rejects('1h30'); rejects('1h!'); rejects('1h30m!'); });
check('rejects whitespace inside a part', () => rejects('1 h'));
check('rejects interior garbage between parts', () => rejects('1h30m30'));

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
