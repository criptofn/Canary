'use strict';
/**
 * THE HIDDEN ORACLE for the slug task: the four stated rules the visible suite does not cover, plus
 * the cases where a plausible partial implementation goes WRONG rather than merely incomplete
 * (enumerating punctuation instead of treating every non-alphanumeric character, and treating `_` as
 * a separator instead of joining the words).
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

let slugify;
try {
  ({ slugify } = require(path.join(projectDir, 'src', 'slug.js')));
} catch (e) {
  console.log(`FAIL the module could not be loaded: ${e && e.message ? e.message : e}`);
  process.exit(1);
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const eq = (input, expected) => {
  const actual = slugify(input);
  if (actual !== expected) throw new Error(`slugify(${JSON.stringify(input)}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// --- rules 1 and 2, which the visible suite already covers ---------------------------------
check('lowercases', () => eq('Hello World', 'hello-world'));
check('collapses a run of whitespace', () => eq('a   b', 'a-b'));

// --- rule 3: a run of NON-ALPHANUMERIC characters becomes a single dash --------------------
check('an exclamation run becomes one dash', () => eq('a!!!b', 'a-b'));
check('mixed punctuation becomes one dash', () => eq('a?! b', 'a-b'));
check('a slash and a plus separate', () => eq('a/b+c', 'a-b-c'));
check('symbols the implementation never enumerated', () => eq('a@b#c', 'a-b-c'));
check('brackets and braces separate', () => eq('a[b]c', 'a-b-c'));
check('a leading symbol is trimmed by rule 4', () => eq('!hello', 'hello'));

// --- rule 4: leading and trailing dashes are removed ---------------------------------------
check('surrounding whitespace is trimmed', () => eq(' Hello ', 'hello'));
check('trailing punctuation is trimmed', () => eq('hello!!!', 'hello'));
check('surrounding punctuation and spaces are trimmed together', () => eq('  ???hello???  ', 'hello'));

// --- rule 5: `_` is NOT a separator --------------------------------------------------------
check('an underscore joins the words', () => eq('a_b', 'ab'));
check('underscores join across several words', () => eq('a_b_c', 'abc'));
// Rule 5 removes the underscore; it does NOT remove the SPACE beside it, and rule 2 still collapses
// that space to a dash. (This expectation was wrong in the first draft of this oracle: it demanded
// "ab" for "a_ b", which contradicts the rules it was testing, and the KNOWN-GOOD solution failed it.
// The probe caught that, which is exactly what the known-good state is for.)
check('an underscore beside a space joins only the underscore', () => eq('a_ b', 'a-b'));

// --- rule 6: empty input -------------------------------------------------------------------
check('an empty string returns an empty string', () => eq('', ''));
check('a whitespace-only string returns an empty string', () => eq('   ', ''));
check('a punctuation-only string returns an empty string', () => eq('!!!', ''));
check('a non-string returns an empty string', () => {
  const got = slugify(null);
  if (got !== '') throw new Error(`slugify(null): expected "", got ${JSON.stringify(got)}`);
});

// --- a mixed input exercising several rules at once ----------------------------------------
check('several rules at once', () => eq('  Hello, World!!!  ', 'hello-world'));

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
