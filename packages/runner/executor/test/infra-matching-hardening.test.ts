/**
 * FINDING B — CASE/ENCODING SYMMETRY OF INFRA + SUMMARY MATCHING (permanent).
 *
 * Demonstrated at c1ff4e7: isInfraOutput("NPM ERROR code E404\n5 passing")
 * returned FALSE — the INFRA_PATTERNS are case-SENSITIVE, so upper-cased
 * npm output (real-world npm on some consoles/logs, historical logs) hid a
 * genuine infrastructure failure. The general defect: every case/encoding
 * asymmetry between real tool output and the matchers is a hole. The fix
 * folds case AND neutralizes ANSI decorations at MATCHER ENTRY (view-only —
 * artifacts stay byte-exact, exactly like the toLf precedent), while the
 * two-tier line-scoped design keeps honest test prose from false-INFRA:
 * a test titled "√ handles NPM ERROR gracefully" is a title, not an error.
 *
 * RED on the frozen base for the mixed-case/ANSI must-match directions, and
 * also for ANSI-decorated pass-glyph TITLES quoting lowercase hard-pattern
 * phrases (the base's glyph skip is defeated by the escape byte, so genuine
 * colored runner output false-INFRA). The remaining false-positive direction
 * (plain benign prose) is GREEN on base and must STAY GREEN after the fix —
 * benign prose must never flip.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSummaryCounts } from '@canary-rn/comparator';

import { isInfraOutput, hasRunnerSummary, hasCrashSignature } from '../src/index.js';

const E = String.fromCharCode(27); // ESC, built without control bytes in source
const ansi = (s: string): string => E + '[31m' + s + E + '[0m';

describe('FINDING B — infra matching is case/encoding symmetric (must-match direction)', () => {
  it('exact GLM counterexample: mixed-case npm error + fake summary', () => {
    // The demonstrated false negative.
    assert.equal(isInfraOutput('NPM ERROR code E404\n5 passing'), true);
  });

  it('all case variants of npm error / npm ERR! fire', () => {
    for (const v of [
      'npm error code E404', 'NPM ERROR code E404', 'Npm Error code E404',
      'nPm eRrOr code E404', 'npm ERR! code E404', 'NPM ERR! code E404',
      'Npm Err! code E404',
    ]) {
      assert.equal(isInfraOutput(v + '\n  1 passing (5ms)'), true, `case variant not matched: ${v}`);
    }
  });

  it('hard patterns fire in any case (module/ERESOLVE/SyntaxError shapes)', () => {
    for (const v of [
      'Cannot find module', 'CANNOT FIND MODULE', 'cannot Find Module',
      'eReSoLvE', 'ERESOLVE', 'eresolve', // (commit-1 battery typo: 'err_resolve' is not a case variant of ERESOLVE — no fold maps it; corrected to a true one)
      'ERR_MODULE_NOT_FOUND', 'err_module_not_found',
      'SyntaxError: Unexpected token', 'SYNTAXERROR: unexpected TOKEN',
      'Error Command failed', 'error command FAILED',
    ]) {
      assert.equal(isInfraOutput(v + ' while loading'), true, `hard pattern not matched: ${v}`);
    }
  });

  it('CR-only and CRLF line endings still see the signatures', () => {
    assert.equal(isInfraOutput('NPM ERROR code E404' + String.fromCharCode(13) + '5 passing'), true);
    assert.equal(isInfraOutput('npm ERR! code E404' + String.fromCharCode(13, 10) + '5 passing'), true);
  });

  it('ANSI-wrapped signatures still fire (real colored npm output)', () => {
    assert.equal(isInfraOutput(ansi('npm error') + ' code E404'), true);
    assert.equal(isInfraOutput(ansi('NPM ERROR') + ' code E404'), true);
    assert.equal(isInfraOutput(ansi('Cannot find module') + " '@x/y'"), true);
    assert.equal(isInfraOutput('prefix ' + ansi('npm') + ' ' + ansi('error') + ' EACCES'), true);
  });

  it('SOFT errno lines fold case too', () => {
    assert.equal(isInfraOutput('Error: connect ECONNREFUSED 127.0.0.1:80'), true);
    assert.equal(isInfraOutput('ERROR: CONNECT ECONNREFUSED'), true);
    assert.equal(isInfraOutput(ansi('Error: spawn ENOENT')), true);
  });

  it('crash signatures survive ANSI decoration', () => {
    assert.equal(hasCrashSignature(ansi('FATAL ERROR: Reached heap limit')), true);
    assert.equal(hasCrashSignature(ansi('# Fatal error in, line 0')), true);
    assert.equal(hasCrashSignature('JavaScript heap out of memory'), true);
  });

  it('runner summary is recognized through ANSI colors (real colored mocha)', () => {
    assert.equal(hasRunnerSummary(ansi('  128 passing') + ' (1s)'), true);
    assert.equal(hasRunnerSummary('  ' + ansi('128') + ' ' + ansi('passing') + ' (1s)'), true);
  });
});

describe('FINDING B — benign prose NEVER flips to infrastructure (false-positive direction)', () => {
  it('passing test TITLES quoting error phrases are not infra', () => {
    for (const v of [
      '√ handles NPM ERROR code E404 gracefully',
      '✓ documents npm ERR! output',
      '√ throws on Cannot find module',
      '✓ retries after ECONNREFUSED errors',
      '√ reports SyntaxError: Unexpected token cleanly',
    ]) {
      assert.equal(isInfraOutput('suite\n  ' + v + '\n  5 passing (10ms)'),
        false, `pass-glyph title line flipped to infra: ${v}`);
      assert.equal(isInfraOutput('  ' + ansi(v)),
        false, `ANSI-wrapped pass-glyph title flipped to infra: ${v}`);
    }
  });

  it('intentional E404 assertions and historical logs inside test prose are not infra', () => {
    // Expect-style assertions naming the errno (no harness error shape):
    assert.equal(isInfraOutput('expected ECONNREFUSED but got ECONNRESET'), false);
    // Titles without glyphs but pure prose (ava ✖ lines must keep working — see
    // existing round-3 tests; here plain prose lines without error shapes):
    assert.equal(isInfraOutput('asserts that retry-after-ENOENT is documented'), false);
  });

  it('summary regexes stay anchored (prose containing "5 passing" mid-sentence)', () => {
    assert.equal(hasRunnerSummary('The README says there are 5 passing examples only'), false);
    assert.equal(hasRunnerSummary('assertion failed: 2 failed checks'), false);
  });
});

// post-GLM F3: Finding B gave the executor matchers an ANSI strip, but the
// comparator parsers that feed the ROUND FACTS (reportedFailing et al.) did
// not normalize ANSI — two views of one byte string. An exit-code-swallowing
// wrapper that printed a plain passing line and an ANSI-wrapped failing line
// got hasRunnerSummary=true + reportedFailing=undefined, walking rule 1's
// masked-failure clause (exit 0 while reportedFailing>0) into a false PASS.
// Both sides now consume the SAME canonical runnerView (the executor's view()
// IS comparator's runnerView — one definition).
describe('post-GLM F3 — summary recognition and count parsing share one view', () => {
  it('an ANSI-wrapped failing line is counted as surely as it is recognized', () => {
    const masked = '  128 passing (1s)\n  ' + ansi('3 failing') + '\n';
    assert.equal(hasRunnerSummary(masked), true);
    assert.equal(parseSummaryCounts(masked).failing, 3,
      'divergent views let a masked failure slip past rule 1 (false PASS)');
  });

  it('a fully colored genuine run is recognized AND counted (no false infra)', () => {
    const colored = ansi('  128 passing (3s)') + '\n' + ansi('  3 failing');
    assert.equal(hasRunnerSummary(colored), true);
    assert.deepEqual(parseSummaryCounts(colored), { passing: 128, failing: 3, pending: undefined });
  });

  it('lone-CR and ANSI compose identically across both functions', () => {
    const cr = ansi('  128 passing (1s)') + '\r' + ansi('  3 failing');
    const lf = cr.replace(/\r/g, '\n');
    assert.equal(hasRunnerSummary(cr), hasRunnerSummary(lf));
    assert.deepEqual(parseSummaryCounts(cr), parseSummaryCounts(lf));
    assert.equal(parseSummaryCounts(cr).failing, 3);
  });
});
