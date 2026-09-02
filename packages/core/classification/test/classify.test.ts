import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyConfinementGuard, classify, observationSatisfied, observationGateIssue, identityCoverage, infraCause, type RoundFact } from '../src/index.js';

/**
 * Post-GLM: attach a VALID executionObservation that AGREES with the fact's
 * text channel (counts and identities derived FROM the text, so the
 * cross-channel agreement the gate demands holds by construction). Tests
 * that still expect a STRONG label (PASS / CONFIRMED_REGRESSION /
 * PRE_EXISTING_FAILURE / FLAKY) must run their facts through this — prose
 * alone can no longer reach those labels. Tests that exercise the gate
 * itself deliberately do NOT.
 *
 * The version/tree/frame-digest fields are placeholder constants: the
 * classifier gate reads status + counts + identities + exit only. Proving
 * those values is the job of the capture validator and the schema mirror,
 * tested at their own layers with real bytes.
 */
function attested(f: RoundFact): RoundFact {
  const counts = {
    passing: f.reportedPassing ?? 0,
    failing: f.reportedFailing ?? 0,
    pending: f.reportedPending ?? 0,
  };
  return {
    ...f,
    executionObservation: {
      status: 'VALID',
      frameCount: 2 + counts.passing + counts.failing + counts.pending,
      framesSha256: 'c'.repeat(64),
      observedCounts: counts,
      observedFailingIdentities: [...new Set(f.failingTestNames ?? [])].sort(),
      expectedMochaVersion: '10.8.2',
      observedMochaVersion: '10.8.2',
      expectedRunnerTreeSha256: 'd'.repeat(64),
      observedRunnerTreeSha256: 'd'.repeat(64),
    },
  };
}
/** classify() over fully-attested facts — the strong-verdict path. */
const classifyAttested = (facts: RoundFact[]) => classify(facts.map(attested));

/** Build a healthy test round (runner summary present, no infra noise).
 *  Failing rounds carry a parseable failing count: post-audit-F1 semantics
 *  treat summary+exit!=0 WITHOUT a failing line as infra, so a healthy
 *  TEST-failure round must show one (real mocha always prints "N failing"
 *  when N > 0). */
function arm(kind: 'baseline' | 'candidate', round: number, pass = true): RoundFact {
  return {
    arm: kind, round,
    exitCode: pass ? 0 : 1,
    hasRunnerSummary: true,
    infraSignal: false,
    // audit B2: a healthy round records its passing count too (real runners
    // print "N passing"); this is what distinguishes a valid zero-failure run
    // from a zero-execution run that must never PASS.
    reportedPassing: pass ? 5 : 4,
    ...(pass ? {} : { reportedFailing: 1, failingTestNames: ['placeholder test'] }),
  };
}

describe('classify — decision table (docs/PLAN.md section 6)', () => {
  it('rule 3: baseline unanimous pass + candidate unanimous pass -> PASS', () => {
    const r = classifyAttested([arm('baseline', 1), arm('baseline', 2), arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(r.classification, 'PASS');
    assert.equal(r.rule, 3);
  });

  it('rule 5: baseline passes, all candidate rounds fail -> CONFIRMED_REGRESSION', () => {
    const r = classifyAttested([
      arm('baseline', 1), arm('baseline', 2),
      arm('candidate', 1, false), arm('candidate', 2, false), arm('candidate', 3, false),
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
    assert.equal(r.details.candidateFailures, 3);
  });

  it('rule 4: baseline fails with real summaries + candidate fails -> PRE_EXISTING_FAILURE', () => {
    const r = classifyAttested([arm('baseline', 1, false), arm('baseline', 2, false), arm('candidate', 1, false)]);
    assert.equal(r.classification, 'PRE_EXISTING_FAILURE');
    assert.equal(r.rule, 4);
  });

  it('rule 1 (degenerate-run guard): failing round without runner summary -> INFRASTRUCTURE_FAILURE, never CONFIRMED_REGRESSION', () => {
    // The exact false-green class that burned the Python prototype:
    // a uniformly broken subject whose logs contain no test results.
    const degenerate = (kind: 'baseline' | 'candidate', round: number): RoundFact => ({
      arm: kind, round, exitCode: 1, hasRunnerSummary: false, infraSignal: false,
    });
    const r = classify([
      degenerate('baseline', 1), degenerate('baseline', 2),
      degenerate('candidate', 1), degenerate('candidate', 2), degenerate('candidate', 3),
    ]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(r.rule, 1);
  });

  it('rule 1: killed round (exit -1) -> INFRASTRUCTURE_FAILURE', () => {
    const killed: RoundFact = { arm: 'candidate', round: 1, exitCode: -1, hasRunnerSummary: true, infraSignal: false };
    const r = classify([arm('baseline', 1), killed, arm('candidate', 2, false)]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
  });

  it('rule 1: infra signal on a failing round outranks drift', () => {
    const npmBreak: RoundFact = { arm: 'candidate', round: 1, exitCode: 1, hasRunnerSummary: false, infraSignal: true };
    const r = classify([arm('baseline', 1), npmBreak, arm('candidate', 2, false), arm('candidate', 3, false)]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
  });

  it('rule 2: split baseline -> FLAKY (experiment invalid)', () => {
    const r = classifyAttested([arm('baseline', 1), arm('baseline', 2, false), arm('candidate', 1, false)]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 2);
  });

  it('rule 7: clean baseline, mixed candidate -> FLAKY, not CONFIRMED', () => {
    const r = classifyAttested([
      arm('baseline', 1),
      arm('candidate', 1, false), arm('candidate', 2), arm('candidate', 3, false),
    ]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 7);
    assert.equal(r.details.candidateFailures, 2);
  });

  it('rule 6: failing baseline + all-pass candidate -> INCONCLUSIVE (inverted pattern)', () => {
    const r = classify([arm('baseline', 1, false), arm('baseline', 2, false), arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
  });

  it('rule 0: missing arms -> INCONCLUSIVE', () => {
    assert.equal(classify([]).classification, 'INCONCLUSIVE');
    assert.equal(classify([arm('baseline', 1)]).classification, 'INCONCLUSIVE');
    assert.equal(classify([arm('candidate', 1)]).classification, 'INCONCLUSIVE');
  });

  it('rule 1 (F1 guard): nonzero exit whose summary reports 0 failing is infra, not drift', () => {
    const postSummaryCrash: RoundFact = {
      arm: 'candidate', round: 1, exitCode: 7,
      hasRunnerSummary: true, infraSignal: false, reportedFailing: 0,
    };
    const r = classify([arm('baseline', 1), arm('baseline', 2), postSummaryCrash, arm('candidate', 2, false), arm('candidate', 3, false)]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
  });

  it('rule 1 (F5 guard): zero exit with masked failures in summary is never PASS', () => {
    const masked: RoundFact = {
      arm: 'candidate', round: 1, exitCode: 0,
      hasRunnerSummary: true, infraSignal: false, reportedFailing: 3,
    };
    const r = classify([arm('baseline', 1), arm('baseline', 2), masked, { ...masked, round: 2 }]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
  });

  // ---- audit B2: a successful exit is NOT sufficient for a valid PASS ----
  it('audit B2: zero-test execution (exit 0, "0 passing") is INFRA, never PASS', () => {
    const zero: RoundFact = {
      arm: 'baseline', round: 1, exitCode: 0,
      hasRunnerSummary: true, infraSignal: false, reportedPassing: 0,
    };
    const r = classify([zero, { ...zero, round: 2 }, arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(r.rule, 1);
    assert.match(r.reason, /zero executed tests/);
  });

  it('audit B2: a round with NO runner summary at exit 0 is INFRA, never PASS', () => {
    const nosummary: RoundFact = {
      arm: 'candidate', round: 1, exitCode: 0, hasRunnerSummary: false, infraSignal: false,
    };
    // baseline genuinely passes, candidate "passes" but ran no recognizable tests
    const r = classify([arm('baseline', 1), arm('baseline', 2), nosummary, { ...nosummary, round: 2 }]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.match(r.reason, /not recognizable as a test run/);
  });

  it('audit B2: recognized infra signature at EXIT ZERO is INFRA (a harness that swallows errors)', () => {
    const swallowed: RoundFact = {
      arm: 'candidate', round: 1, exitCode: 0, hasRunnerSummary: true,
      infraSignal: true, reportedPassing: 3,   // 0 failing, but ECONNREFUSED in output
    };
    const r = classify([arm('baseline', 1), arm('baseline', 2), swallowed, { ...swallowed, round: 2 }]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.match(r.reason, /infrastructure-failure signature/);
  });

  it('audit B2: a candidate whose baseline is clean but rounds are zero-test is INFRA (never CONFIRMED)', () => {
    const zeroCand: RoundFact = {
      arm: 'candidate', round: 1, exitCode: 1, hasRunnerSummary: true,
      infraSignal: false, reportedPassing: 0, reportedFailing: 0,
    };
    const r = classify([arm('baseline', 1), arm('baseline', 2), zeroCand, { ...zeroCand, round: 2 }]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
  });

  it('audit B2 positive control: a valid zero-failure run (N>0 passing, exit 0) still PASSES', () => {
    const r = classifyAttested([arm('baseline', 1), arm('baseline', 2), arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(r.classification, 'PASS');
    assert.equal(r.rule, 3);
  });

  it('audit F1 (mocha-realistic): passing summary WITHOUT a failing line + nonzero exit -> INFRA, never CONFIRMED_REGRESSION', () => {
    // The exact false-green the independent audit flagged: real mocha omits
    // the "N failing" line when zero tests failed, so reportedFailing is
    // UNPARSEABLE (undefined) — not unknown-failures, but reported-zero.
    // Baseline clean; ALL three candidate rounds crash post-summary at exit 1.
    const postSummaryCrash = (round: number): RoundFact => ({
      arm: 'candidate', round, exitCode: 1,
      hasRunnerSummary: true, infraSignal: false,
      // log was "128 passing" only — parseSummaryCounts().failing === undefined
      reportedFailing: undefined, failingTestNames: [],
    });
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      postSummaryCrash(1), postSummaryCrash(2), postSummaryCrash(3),
    ]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(r.rule, 1);
  });

  it('audit F2: candidate rounds failing DIFFERENT counts -> FLAKY rule 8, not CONFIRMED_REGRESSION', () => {
    const r = classifyAttested([
      arm('baseline', 1), arm('baseline', 2),
      { ...arm('candidate', 1, false), reportedFailing: 3, failingTestNames: ['a', 'b', 'c'] },
      { ...arm('candidate', 2, false), reportedFailing: 5, failingTestNames: ['a', 'b', 'c', 'd', 'e'] },
    ]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 8);
  });

  it('audit F2: same count but DIFFERENT failing-test identities -> FLAKY rule 8', () => {
    const r = classifyAttested([
      arm('baseline', 1), arm('baseline', 2),
      { ...arm('candidate', 1, false), reportedFailing: 2, failingTestNames: ['alpha', 'beta'] },
      { ...arm('candidate', 2, false), reportedFailing: 2, failingTestNames: ['alpha', 'gamma'] },
    ]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 8);
  });

  it('audit F2: identical failure profiles (golden shape) -> still CONFIRMED_REGRESSION rule 5', () => {
    // Round-3 note: the identity list must FULLY account for the failing
    // count (3 names for "3 failing") — the pre-fix fixture paired 3 failures
    // with 2 identities, the exact partial-parse shape the classifier now
    // (correctly) refuses via rule 11.
    const golden = (round: number): RoundFact => ({
      arm: 'candidate', round, exitCode: 3,
      hasRunnerSummary: true, infraSignal: false,
      // post-sol RB-2: real mocha prints BOTH counts; 2 passing + 3 failing
      // keeps the EXECUTED total (5) comparable with the baseline rounds
      // (arm() reports 5 passing) — the invariant is about totals, so the
      // fixture now carries the shape an actual collapsed-coverage refusal
      // would see in honest logs.
      reportedPassing: 2, reportedFailing: 3,
      failingTestNames: [
        'can pass headers to match to a handler',
        'handles baseURL correctly',
        'passes multipart/form-data with the right boundary',
      ],
    });
    const r = classifyAttested([
      arm('baseline', 1), arm('baseline', 2), golden(1), golden(2), golden(3),
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
  });

  it('audit F2: profile comparison is order-independent (sorted identities)', () => {
    const r = classifyAttested([
      arm('baseline', 1), arm('baseline', 2),
      // reportedPassing 3 keeps executed=5 comparable across arms (post-sol RB-2)
      { ...arm('candidate', 1, false), reportedPassing: 3, reportedFailing: 2, failingTestNames: ['beta', 'alpha'] },
      { ...arm('candidate', 2, false), reportedPassing: 3, reportedFailing: 2, failingTestNames: ['alpha', 'beta'] },
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
  });

  it('audit F2: unstable baseline failure identities block PRE_EXISTING_FAILURE -> FLAKY', () => {
    const r = classifyAttested([
      { ...arm('baseline', 1, false), reportedFailing: 1, failingTestNames: ['x'] },
      { ...arm('baseline', 2, false), reportedFailing: 1, failingTestNames: ['y'] },
      { ...arm('candidate', 1, false), reportedFailing: 1, failingTestNames: ['y'] },
    ]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 8);
  });

  it('audit F1 contract: summary-present failing round WITHOUT any failing count is INFRA, not regression', () => {
    // Post-fix semantics: "unknown failing count on a matched summary" reads
    // as reported-zero (mocha omits the line at zero). A bundle that only
    // knows exit codes can never produce a confirmed regression.
    const bareFail = (round: number): RoundFact => ({
      arm: 'candidate', round, exitCode: 1, hasRunnerSummary: true, infraSignal: false,
    });
    const r = classify([
      arm('baseline', 1), arm('baseline', 2), bareFail(1), bareFail(2),
    ]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(r.rule, 1);
  });

  it('is pure: same facts always yield the same verdict', () => {
    const facts: RoundFact[] = [
      arm('baseline', 1), arm('candidate', 1, false), arm('candidate', 2, false),
    ];
    const a = classifyAttested(facts);
    const b = classifyAttested(facts);
    assert.deepEqual(a, b);
  });
});

describe('audit F9/B6 — applyConfinementGuard (rules 9 + 10, enforced not decorative)', () => {
  // attested here: every test in this block needs the PRE-guard verdict to
  // be the strong one the guard then operates on.
  const confirmedFacts: RoundFact[] = [
    arm('baseline', 1), arm('baseline', 2), arm('candidate', 1, false), arm('candidate', 2, false),
  ].map(attested);
  const VALID = { baselineStatus: 'VALID', candidateStatus: 'VALID' } as const;

  it('downgrades CONFIRMED_REGRESSION to INCONCLUSIVE rule 9 when drift is unconfined', () => {
    const cls = classify(confirmedFacts);
    assert.equal(cls.classification, 'CONFIRMED_REGRESSION'); // guard absent, rule 5
    const g = applyConfinementGuard(cls, { confined: false, other: ['left-pad'], dependency: 'axios', ...VALID });
    assert.equal(g.classification, 'INCONCLUSIVE');
    assert.equal(g.rule, 9);
    assert.match(g.reason, /left-pad/);
    assert.match(g.reason, /axios subtree/);
  });

  it('is identity when drift IS confined and both trees VALID (a legit CONFIRMED survives)', () => {
    const cls = classify(confirmedFacts);
    const g = applyConfinementGuard(cls, { confined: true, other: [], dependency: 'axios', ...VALID });
    assert.deepEqual(g, cls);
  });

  it('never masks an INFRASTRUCTURE_FAILURE (higher-fidelity reason kept)', () => {
    const infra = classify([
      arm('baseline', 1), { ...arm('candidate', 1, false), hasRunnerSummary: false }, // rule-1 infra
    ]);
    assert.equal(infra.classification, 'INFRASTRUCTURE_FAILURE');
    const g = applyConfinementGuard(infra, { confined: false, other: ['evil'], dependency: 'axios', ...VALID });
    assert.equal(g.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(g.rule, 1);
  });

  it('downgrades PASS and PRE_EXISTING_FAILURE too (any trustful verdict needs comparable arms)', () => {
    const passCls = classifyAttested([arm('baseline', 1), arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(passCls.classification, 'PASS');
    assert.equal(applyConfinementGuard(passCls, { confined: false, other: ['x'], dependency: 'axios', ...VALID }).rule, 9);

    const preCls = classifyAttested([arm('baseline', 1, false), arm('candidate', 1, false)]);
    assert.equal(preCls.classification, 'PRE_EXISTING_FAILURE');
    assert.equal(applyConfinementGuard(preCls, { confined: false, other: ['x'], dependency: 'axios', ...VALID }).rule, 9);
  });

  it('audit B6: an empty/partial tree observation downgrades to INCONCLUSIVE rule 10 even when drift is confined', () => {
    const cls = classify(confirmedFacts);
    // confined:true (would pass rule 9) but the tree observation is INCOMPLETE
    const g = applyConfinementGuard(cls, {
      confined: true, other: [], dependency: 'axios',
      baselineStatus: 'VALID', candidateStatus: 'INCOMPLETE',
    });
    assert.equal(g.classification, 'INCONCLUSIVE');
    assert.equal(g.rule, 10);
    assert.match(g.reason, /observation is not trustworthy/);
    // INVALID on either side too
    assert.equal(applyConfinementGuard(cls, {
      confined: true, other: [], dependency: 'axios',
      baselineStatus: 'INVALID', candidateStatus: 'VALID',
    }).rule, 10);
  });

  it('audit B6: tree-invalidity takes precedence over unconfined drift (rule 10 not 9)', () => {
    const cls = classify(confirmedFacts);
    const g = applyConfinementGuard(cls, {
      confined: false, other: ['evil'], dependency: 'axios',
      baselineStatus: 'INVALID', candidateStatus: 'INVALID',
    });
    assert.equal(g.rule, 10);
  });

  it('guard removal would flip the outcome: identical facts, opposite confinement', () => {
    const cls = classify(confirmedFacts);
    const confined = applyConfinementGuard(cls, { confined: true, other: [], dependency: 'axios', ...VALID });
    const unconfined = applyConfinementGuard(cls, { confined: false, other: ['evil-pkg'], dependency: 'axios', ...VALID });
    assert.equal(confined.classification, 'CONFIRMED_REGRESSION');
    assert.equal(unconfined.classification, 'INCONCLUSIVE');
  });
});

// ---- Round-3 BLOCKER 1: failure-identity COMPLETENESS ----
// The audited hole: a round can report "N failing" while the parser yields
// fewer identities (root-level "1) title:" lines parsed to NOTHING before
// the fix). Two such rounds profile-match on their EMPTY sets and the
// classifier confirms a regression from zero identified failures.
describe('round-3 blocker 1 — identity coverage gates trustful verdicts', () => {
  // reportedPassing keeps EXECUTED totals comparable with the plain arm()
  // rounds (executed 5) — post-sol RB-2 makes an incomparable fixture
  // INCONCLUSIVE rule 13, which would mask the rule-11 behavior under test.
  // Override `passing` per case when the totals must line up differently.
  const failRound = (arm: 'baseline' | 'candidate', round: number, reported: number, names: string[], passing = 5 - reported): RoundFact => ({
    arm, round, exitCode: 3, hasRunnerSummary: true, infraSignal: false,
    reportedPassing: passing, reportedFailing: reported, failingTestNames: [...names].sort(),
  });

  it('identityCoverage: exact match COMPLETE; fewer / more / missing => INCOMPLETE / NOT_OBSERVED', () => {
    assert.equal(identityCoverage(failRound('candidate', 1, 2, ['a', 'b'])), 'COMPLETE');
    assert.equal(identityCoverage(failRound('candidate', 1, 0, [])), 'COMPLETE');
    assert.equal(identityCoverage(failRound('candidate', 1, 2, ['a'])), 'INCOMPLETE');
    assert.equal(identityCoverage(failRound('candidate', 1, 2, ['a', 'a'])), 'INCOMPLETE', 'duplicates must not fake coverage');
    assert.equal(identityCoverage(failRound('candidate', 1, 1, ['a', 'b'])), 'INCOMPLETE', 'count and identities contradict');
    assert.equal(identityCoverage({ arm: 'candidate', round: 1, exitCode: 3, hasRunnerSummary: true, infraSignal: false }), 'NOT_OBSERVED');
    assert.equal(identityCoverage({ ...failRound('candidate', 1, 2, []), failingTestNames: undefined }), 'NOT_OBSERVED');
  });

  it('two DIFFERENT root-level failures that collapsed to equal EMPTY sets can never CONFIRM (rule 11)', () => {
    // Pre-fix this exact shape yielded CONFIRMED_REGRESSION: both rounds had
    // reportedFailing=2 and failingTestNames=[] (the parser could not see
    // root "N) title:" lines), so the profiles matched.
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      failRound('candidate', 1, 2, []),
      failRound('candidate', 2, 2, []),
    ]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 11);
    assert.match(r.reason, /not fully accounted/);
  });

  it('repeated "2 failing" with only ONE extractable identity -> INCONCLUSIVE rule 11, never CONFIRMED', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      failRound('candidate', 1, 2, ['x']),
      failRound('candidate', 2, 2, ['x']),
    ]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 11);
  });

  it('single failing round claiming 9 failures with 0 identities -> INCONCLUSIVE rule 11', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      failRound('candidate', 1, 9, []),
    ]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 11);
  });

  it('under-accounted BASELINE blocks PRE_EXISTING_FAILURE too (coverage is not candidate-only)', () => {
    const r = classify([
      failRound('baseline', 1, 3, ['only one']),
      failRound('baseline', 2, 3, ['only one']),
      failRound('candidate', 1, 3, ['only one']),
    ]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 11);
  });

  it('genuinely distinct root failures stay distinct (rule 8 FLAKY, not coverage, not CONFIRMED)', () => {
    // Post-fix the parser yields one identity per root failure; identical
    // rounds still CONFIRM (below), differing rounds are FLAKY (here).
    const r = classifyAttested([
      arm('baseline', 1), arm('baseline', 2),
      failRound('candidate', 1, 2, ['root alpha', 'root beta']),
      failRound('candidate', 2, 2, ['root alpha', 'root gamma']),
    ]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 8);
    const same = classifyAttested([
      arm('baseline', 1), arm('baseline', 2),
      failRound('candidate', 1, 2, ['root alpha', 'root beta']),
      failRound('candidate', 2, 2, ['root beta', 'root alpha']),
    ]);
    assert.equal(same.classification, 'CONFIRMED_REGRESSION', 'reordered equivalents are the same profile');
    assert.equal(same.rule, 5);
  });

  it('fully-accounted root-level identities CONFIRM (conservatism must not break real proofs)', () => {
    const r = classifyAttested([
      arm('baseline', 1), arm('baseline', 2),
      failRound('candidate', 1, 3, ['root alpha', 'suite B > inner test', 'suite C > other']),
      failRound('candidate', 2, 3, ['root alpha', 'suite B > inner test', 'suite C > other']),
      failRound('candidate', 3, 3, ['root alpha', 'suite B > inner test', 'suite C > other']),
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
  });
});

// ---- Round-3 BLOCKER 2: all-pending / zero-assertion runs ----
describe('round-3 blocker 2 — pending tests are NOT executed assertions', () => {
  const pendingRound = (arm: 'baseline' | 'candidate', round: number): RoundFact => ({
    arm, round, exitCode: 0, hasRunnerSummary: true, infraSignal: false,
    reportedPassing: 0, reportedFailing: 0, reportedPending: 7,
  });

  it('all-pending candidate (0/0/7, exit 0) can never PASS -> INFRA', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      pendingRound('candidate', 1), pendingRound('candidate', 2),
    ]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(r.rule, 1);
    assert.match(r.reason, /zero executed tests/);
    assert.match(r.reason, /pending\/skipped/);
  });

  it('infraCause flags a pending-only round directly (was: null)', () => {
    const cause = infraCause(pendingRound('candidate', 1));
    assert.ok(cause !== null, 'pending-only must be an invalid execution');
    assert.match(cause, /zero executed tests/);
  });

  it('healthy baseline + ALL-skipped candidate: the run proves nothing executed', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      pendingRound('candidate', 1), pendingRound('candidate', 2), pendingRound('candidate', 3),
    ]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
  });

  it('summary present with NO machine-readable counts at all -> INFRA (prose "summary" proves nothing)', () => {
    const prose = (arm: 'baseline' | 'candidate', round: number): RoundFact => ({
      arm, round, exitCode: 0, hasRunnerSummary: true, infraSignal: false,
      // e.g. a runner whose summary line matched the signature but whose
      // numbers never parse into passing/failing/pending:
    });
    const r = classify([prose('baseline', 1), prose('baseline', 2), prose('candidate', 1), prose('candidate', 2)]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.match(r.reason, /no machine-readable pass\/fail counts/);
  });

  it('pending-only counts (no passing/failing line — the real mocha shape) -> INFRA zero-executed', () => {
    const pend = (arm: 'baseline' | 'candidate', round: number): RoundFact => ({
      arm, round, exitCode: 0, hasRunnerSummary: true, infraSignal: false,
      reportedPending: 7,
    });
    const r = classify([pend('baseline', 1), pend('baseline', 2), pend('candidate', 1), pend('candidate', 2)]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.match(r.reason, /zero executed tests/);
  });

  it('zero-test with NO summary at all stays INFRA (B2 path unchanged)', () => {
    const z = (arm: 'baseline' | 'candidate', round: number): RoundFact => ({
      arm, round, exitCode: 0, hasRunnerSummary: false, infraSignal: false,
    });
    const r = classify([z('baseline', 1), z('baseline', 2), z('candidate', 1), z('candidate', 2)]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.match(r.reason, /not recognizable as a test run/);
  });

  it('a single executed assertion (1 passing, 0 failing, N pending) is enough to be a VALID run', () => {
    const light = (arm: 'baseline' | 'candidate', round: number): RoundFact => ({
      arm, round, exitCode: 0, hasRunnerSummary: true, infraSignal: false,
      reportedPassing: 1, reportedFailing: 0, reportedPending: 99,
    });
    const r = classifyAttested([light('baseline', 1), light('baseline', 2), light('candidate', 1), light('candidate', 2)]);
    assert.equal(r.classification, 'PASS');
  });

  // Self-review P2 probe: parseSummaryCounts takes the FIRST match, so a log
  // that PRINTS a decoy summary line early ("console.log('0 failing')" as
  // test subject matter) yields a first-match read that contradicts the real
  // tail summary. The decision table must absorb that ambiguity only in the
  // conservative direction — never into a trustful label.
  it('decoy early summary lines cannot steer a nonzero-exit round into CONFIRMED (probe P2)', () => {
    // bytes '0 failing' (decoy, first match) vs real '2 failing' tail:
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      {
        arm: 'candidate', round: 1, exitCode: 1, hasRunnerSummary: true, infraSignal: false,
        reportedPassing: 3, reportedFailing: 0, // first-match parse of the decoy log
        failingTestNames: [],
      },
      {
        arm: 'candidate', round: 2, exitCode: 1, hasRunnerSummary: true, infraSignal: false,
        reportedPassing: 3, reportedFailing: 0,
        failingTestNames: [],
      },
    ]);
    assert.equal(r.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(r.rule, 1);
    assert.match(r.reason, /died outside tests/, 'a zero-failing read alongside nonzero exit is infra, never CONFIRMED');
  });

  // Self-review P4 probe (documented conservative limitation): two distinct
  // real failures whose SUITE-QUALIFIED identity is genuinely identical
  // (two spec files with the same describe/it titles — legal in mocha)
  // dedupe to one identity, under-account the count, and cap the run at
  // INCONCLUSIVE rule 11. Canary must never silently TRUST such a parse;
  // this test pins the conservatism so a future "helpful" collapse cannot
  // flip the direction.
  it('duplicate identical suite-qualified identities under-account -> rule 11, never trust (probe P4)', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      {
        arm: 'candidate', round: 1, exitCode: 2, hasRunnerSummary: true, infraSignal: false,
        reportedFailing: 2, reportedPassing: 1, failingTestNames: ['Suite A > inner'],
      },
      {
        arm: 'candidate', round: 2, exitCode: 2, hasRunnerSummary: true, infraSignal: false,
        reportedFailing: 2, reportedPassing: 1, failingTestNames: ['Suite A > inner'],
      },
    ]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 11);
  });
});

// ---------------------------------------------------------------------------
// POST-SOL RB-2 — SUITE-COLLAPSE / COVERAGE-CONSISTENCY INVARIANT.
// Sol demonstrated the classifier considered execution successful as long as
// AT LEAST ONE assertion executed:
//   b=128p vs c=1p            -> PASS rule 3
//   b reps 128p, 1p           -> PASS rule 3
//   b=128p vs c=1p/127pending -> PASS rule 3
//   b=128p vs c=1 failing     -> CONFIRMED_REGRESSION rule 5
// Violating the core invariant: WEAKER OR MISSING TEST EXECUTION MUST NOT
// PRODUCE A STRONGER VERDICT. The rules added (12/13) reason from the
// EXPERIMENT ITSELF (executed = passing+failing, observed = +pending):
//  - per-arm repetitions must show STABLE totals (rule 12, FLAKY);
//  - a STRONG verdict (PASS / CONFIRMED_REGRESSION / PRE_EXISTING_FAILURE)
//    requires the arms' totals to be COMPARABLE (rule 13, INCONCLUSIVE);
//  - a legitimate regression moves tests from passing to failing at a
//    STABLE executed total (the Axios shape) and must still confirm.
// No hard-coded test-count minimum anywhere.
// ---------------------------------------------------------------------------
describe('post-sol RB-2 — coverage consistency gates strong verdicts', () => {
  const b = (round: number, passing: number, pending?: number): RoundFact => ({
    arm: 'baseline', round, exitCode: 0, hasRunnerSummary: true, infraSignal: false,
    reportedPassing: passing, ...(pending !== undefined ? { reportedPending: pending } : {}),
  });
  const cPass = (round: number, passing: number, pending?: number): RoundFact => ({
    arm: 'candidate', round, exitCode: 0, hasRunnerSummary: true, infraSignal: false,
    reportedPassing: passing, ...(pending !== undefined ? { reportedPending: pending } : {}),
  });
  const cFail = (round: number, passing: number, failing: number): RoundFact => ({
    arm: 'candidate', round, exitCode: 3, hasRunnerSummary: true, infraSignal: false,
    reportedPassing: passing, reportedFailing: failing,
    failingTestNames: ['t1', 't2', 't3'].slice(0, failing),
  });

  // ---- the four demonstrated cases, exactly as Sol produced them ----
  it("Sol case 1: baseline 128 passing, candidate 1 passing is NOT PASS", () => {
    const r = classify([b(1, 128), b(2, 128), cPass(1, 1), cPass(2, 1)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
    assert.match(r.reason, /128\/128/);
    assert.match(r.reason, /1\/1/);
  });

  it('Sol case 2: baseline repetitions 128 then 1 (both exit 0) is NOT PASS', () => {
    const r = classifyAttested([b(1, 128), b(2, 1), cPass(1, 1), cPass(2, 1)]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 12);
    assert.match(r.reason, /repetitions differ in observed test coverage/);
  });

  it('Sol case 3: baseline 128, candidate 1 passing / 127 pending is NOT PASS', () => {
    const r = classify([b(1, 128), b(2, 128), cPass(1, 1, 127), cPass(2, 1, 127)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
  });

  it('Sol case 4: baseline 128, candidate 1 stable failing test is NOT CONFIRMED_REGRESSION', () => {
    const r = classify([b(1, 128), b(2, 128), cFail(1, 0, 1), cFail(2, 0, 1), cFail(3, 0, 1)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
  });

  // ---- the invariant must NOT break legitimate verdicts ----
  it('Axios golden shape (128 passing -> 125 passing / 3 failing) STILL classifies CONFIRMED_REGRESSION rule 5', () => {
    const r = classifyAttested([
      b(1, 128), b(2, 128),
      cFail(1, 125, 3), cFail(2, 125, 3), cFail(3, 125, 3),
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
  });

  it('a passing->failing move at stable totals is a regression, not a coverage gap', () => {
    const r = classifyAttested([b(1, 10), b(2, 10), cFail(1, 8, 2), cFail(2, 8, 2)]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
  });

  it('one executed test on BOTH arms, stable across repetitions, still PASSES (no hard-coded minimum)', () => {
    const r = classifyAttested([b(1, 1), b(2, 1), cPass(1, 1), cPass(2, 1)]);
    assert.equal(r.classification, 'PASS');
    assert.equal(r.rule, 3);
  });

  it('pending that SHRINKS candidate-side is caught by the observed total (5 executed + 0 pending vs 5 + 5 pending)', () => {
    const r = classify([b(1, 5), b(2, 5), cPass(1, 5, 5), cPass(2, 5, 5)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
    assert.match(r.reason, /observed/);
  });

  it('candidate executing MORE than baseline is equally non-comparable (strong verdicts need both directions)', () => {
    const r = classify([b(1, 5), b(2, 5), cPass(1, 6), cPass(2, 6)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
  });

  it('rule 12 fires on candidate-side instability too (one repeat loses a test, both exit 0)', () => {
    const r = classifyAttested([b(1, 5), b(2, 5), cPass(1, 5), cPass(2, 4)]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 12);
  });

  it('PRE_EXISTING_FAILURE also demands comparability (baseline fails with fewer executed than candidate)', () => {
    const base = (round: number): RoundFact => ({
      arm: 'baseline', round, exitCode: 1, hasRunnerSummary: true, infraSignal: false,
      reportedPassing: 2, reportedFailing: 1, failingTestNames: ['t1'],
    });
    const r = classify([
      base(1), base(2),
      cFail(1, 4, 1), cFail(2, 4, 1),
    ]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
  });

  it('weak outputs are never inflated by the new rules: mixed candidate with a coverage gap stays FLAKY (rule 7), infra wins over coverage (rule 1)', () => {
    const mixed = classifyAttested([b(1, 5), b(2, 5), cPass(1, 5), cFail(2, 0, 1)]);
    assert.ok(['FLAKY'].includes(mixed.classification), mixed.classification);
    assert.notEqual(mixed.rule, 5);
    const infraFirst = classify([b(1, 5), b(2, 5), cPass(1, 5, 120), { ...cPass(2, 5, 120), infraSignal: true }]);
    assert.equal(infraFirst.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(infraFirst.rule, 1);
  });

  it('treats undefined counts as zero consistently with rule 1 (mocha omits the 0-failing line): 5 passing vs 5 passing+3 failing is NOT comparable', () => {
    const r = classify([
      b(1, 5), b(2, 5),
      cFail(1, 5, 3), cFail(2, 5, 3),
    ]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13); // 5 vs 8 executed
  });

  it('a stable-coverage collapse on BOTH arms (128 -> 1 -> uniform) is comparable and can still PASS — and is reported honestly', () => {
    // The suite genuinely shrank before BOTH arms ran (e.g. the operator
    // changed it): coverage is stable and comparable, so the experiment
    // itself carries no inconsistency signal. Canary cannot detect it from
    // run facts alone; the committed proof (pinned summary/counts) is the
    // external anchor. This test pins the boundary of rule 13 — no
    // hard-coded minimum is smuggled back in.
    const r = classifyAttested([b(1, 1), b(2, 1), cPass(1, 1), cPass(2, 1)]);
    assert.equal(r.classification, 'PASS');
  });
});

// ---------------------------------------------------------------------------
// POST-GLM OBSERVATION HARDENING — THE EXECUTION-OBSERVATION GATE (rule 14).
// The audited hole at THIS layer: every execution fact the table consumes was
// PARSED FROM SUBJECT STDOUT, so prose alone could produce PASS /
// CONFIRMED_REGRESSION / PRE_EXISTING_FAILURE / FLAKY. The gate makes strong
// labels structurally unreachable unless every round carries a VALID
// Canary-observation agreeing with the text. These unit tests pin the gate's
// mechanics; the end-to-end reproducer (a real CLI run of the exact GLM
// forgery) lives in apps/cli/test/execution-authority.test.ts.
// ---------------------------------------------------------------------------
describe('post-GLM — execution-observation gate (rule 14)', () => {
  it('the GLM shape: unanimous "passing" prose with NO observation -> INCONCLUSIVE rule 14, never PASS', () => {
    // Classifier-level twin of `node -e console.log('128 passing (1s)')`:
    // text-perfect healthy rounds, zero Canary-observed execution.
    const r = classify([arm('baseline', 1), arm('baseline', 2), arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 14);
    assert.match(r.reason, /executionObservation=missing/);
    assert.match(r.reason, /previously rule 3 PASS/);
  });

  it('a VALID observation that LIES about counts is caught (text 5/0/0 vs observed 42/0/0)', () => {
    const liar = attested(arm('candidate', 1));
    liar.executionObservation!.observedCounts = { passing: 42, failing: 0, pending: 0 };
    const r = classify([attested(arm('baseline', 1)), attested(arm('baseline', 2)), liar]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 14);
    assert.match(r.reason, /observed 42\/0\/0 disagrees with text 5\/0\/0/);
  });

  it('a VALID observation whose failing identities differ from the text is caught', () => {
    const liar = attested(arm('candidate', 1, false));
    liar.executionObservation!.observedFailingIdentities = ['invented > lie'];
    const r = classify([attested(arm('baseline', 1)), attested(arm('baseline', 2)), liar]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 14);
    assert.match(r.reason, /observed failing identities disagree/);
    assert.match(r.reason, /previously rule 5 CONFIRMED_REGRESSION/);
  });

  it('FLAKY is gated too: a split baseline WITHOUT observation is rule 14, not FLAKY', () => {
    // "Tests ran, with differing results" is still an execution claim.
    const r = classify([arm('baseline', 1), arm('baseline', 2, false), arm('candidate', 1, false)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 14);
    assert.match(r.reason, /previously rule 2 FLAKY/);
  });

  it('PRE_EXISTING_FAILURE is gated: fail/fail/fail prose is rule 14 (the guard also gates the honest direction)', () => {
    const r = classify([arm('baseline', 1, false), arm('baseline', 2, false), arm('candidate', 1, false)]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 14);
    assert.match(r.reason, /previously rule 4 PRE_EXISTING_FAILURE/);
  });

  it('status ABSENT is not "weak-but-fine": an explicit ABSENT observation gates like a missing one', () => {
    const f = attested(arm('candidate', 1));
    f.executionObservation!.status = 'ABSENT';
    const r = classify([attested(arm('baseline', 1)), attested(arm('baseline', 2)), f]);
    assert.equal(r.rule, 14);
    assert.match(r.reason, /executionObservation=ABSENT/);
  });

  it('the gate reports the FIRST offending round in bundle order (deterministic reason)', () => {
    const issue = observationGateIssue([arm('baseline', 1), arm('baseline', 2), arm('candidate', 1)])!;
    assert.match(issue, /^round baseline#1 has executionObservation=missing/);
  });

  it('observationGateIssue: both exit-contradiction directions fail a VALID observation', () => {
    // masked: watched failures > 0 but the runner exited 0.
    const masked = attested({ ...arm('candidate', 1, false), exitCode: 0 });
    assert.match(observationGateIssue([masked])!, /1 observed failures but exit=0 \(masked failure\)/);
    // died outside: nothing observed failing but a nonzero exit.
    const died = attested({ ...arm('candidate', 1), exitCode: 7 });
    assert.match(observationGateIssue([died])!, /zero observed failures but exit=7 \(died outside watched tests\)/);
    // control: the same facts with exit codes that agree pass the predicate.
    assert.equal(observationGateIssue([attested(arm('candidate', 1)), attested(arm('candidate', 2, false))]), null);
  });

  it('observationSatisfied agrees with the gate on both paths', () => {
    assert.equal(observationSatisfied([]), true); // vacuous — classify() rules this rule 0, not 14
    assert.equal(observationSatisfied([arm('baseline', 1)]), false);
    assert.equal(observationSatisfied([attested(arm('baseline', 1)), attested(arm('candidate', 1))]), true);
  });

  it('a VALID observation whose identity array is missing/malformed is a REFUSAL, not a crash', () => {
    // Hostile-data path: bundles arrive cast from disk (validateBundle and the
    // prove replay both hand classify() RoundFact-shaped RECORDS, not
    // constructor-checked objects). A malformed field must produce rule 14 —
    // the gate CANNOT be crashed into silence. Regression: this threw
    // TypeError ("observedFailingIdentities is not iterable") from inside
    // attestedView until the panel-K battery's deletion-matrix caught it.
    const broken = {
      ...attested(arm('baseline', 1)),
      executionObservation: (() => {
        const o = attested(arm('baseline', 1)).executionObservation as unknown as Record<string, unknown>;
        delete o.observedFailingIdentities;
        return o;
      })(),
    } as unknown as RoundFact;
    const gate = observationGateIssue([broken]);
    assert.ok(gate, 'malformed VALID observation must not satisfy the gate');
    assert.match(gate, /observedFailingIdentities is not an array/);
    const r = classify([broken, attested(arm('candidate', 1))]);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 14);
    // and observationSatisfied stays a total function on hostile input:
    assert.equal(observationSatisfied([broken]), false);
  });

  it('weak paths are NOT gated: rule 0/rule 1 keep their rule numbers without any observation', () => {
    // An empty-ish bundle must report "missing arms" (rule 0), not claim the
    // gate fired — the gate downgrades claims, it never fabricates structure.
    const r0 = classify([arm('baseline', 1)]);
    assert.equal(r0.rule, 0);
    const degenerate = (kind: 'baseline' | 'candidate', round: number): RoundFact => ({
      arm: kind, round, exitCode: 1, hasRunnerSummary: false, infraSignal: false,
    });
    const r1 = classify([degenerate('baseline', 1), degenerate('candidate', 1)]);
    assert.equal(r1.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(r1.rule, 1);
  });
});

// ---------------------------------------------------------------------------
// Post-GLM round 5 — F1: failing-set containment for PRE_EXISTING_FAILURE
// (a watched pass->fail transition may never be swallowed by the "already
// broken" label), and F4: rule-14 routing pinned for EVERY named FLAKY
// producer (§11 promised "all strong + FLAKY producers"; before this, a
// gate exemption for producers 6/7/8/12 survived the whole suite).
// ---------------------------------------------------------------------------

/** A round with exact channels — used where arm()'s fixed shapes cannot hit
 *  a specific producer. */
function fact(
  armName: 'baseline' | 'candidate', round: number,
  opts: { passing: number; failing?: string[]; exit: number },
): RoundFact {
  const failing = opts.failing ?? [];
  return {
    arm: armName, round, exitCode: opts.exit, hasRunnerSummary: true, infraSignal: false,
    reportedPassing: opts.passing,
    ...(failing.length > 0 ? { reportedFailing: failing.length, failingTestNames: failing } : {}),
  };
}

describe('post-GLM round 5 F1 — PRE_EXISTING requires failing-set containment', () => {
  it('a candidate failure Canary never saw fail in baseline is NOT pre-existing — INCONCLUSIVE 13 (never a swallowed regression)', () => {
    // The GLM-round-5 scenario: B passes in baseline (watched), fails in
    // candidate — the old table labeled this PRE_EXISTING_FAILURE, a verdict
    // contradicted by Canary's own retained bytes. Baseline {A} vs candidate
    // {A,B} keeps executed totals equal (1+1 vs 0+2 — the compensated-
    // disappearance shape), so cardinality alone cannot see it; only
    // failing-set IDENTITY containment catches this.
    const facts = [
      fact('baseline', 1, { passing: 1, failing: ['s > A'], exit: 1 }),
      fact('baseline', 2, { passing: 1, failing: ['s > A'], exit: 1 }),
      fact('candidate', 1, { passing: 0, failing: ['s > A', 's > B'], exit: 1 }),
      fact('candidate', 2, { passing: 0, failing: ['s > A', 's > B'], exit: 1 }),
    ];
    const r = classifyAttested(facts);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
    assert.match(r.reason, /s > B/);
    assert.match(r.reason, /containment/);
  });

  it('disjoint failing sets ({A} baseline vs {B} candidate) at equal totals describe no comparable transition — INCONCLUSIVE 13', () => {
    const facts = [
      fact('baseline', 1, { passing: 1, failing: ['s > A'], exit: 1 }),
      fact('baseline', 2, { passing: 1, failing: ['s > A'], exit: 1 }),
      fact('candidate', 1, { passing: 1, failing: ['s > B'], exit: 1 }),
      fact('candidate', 2, { passing: 1, failing: ['s > B'], exit: 1 }),
    ];
    const r = classifyAttested(facts);
    assert.equal(r.classification, 'INCONCLUSIVE');
    assert.equal(r.rule, 13);
    assert.match(r.reason, /s > B/);
  });

  it('an honest PRE_EXISTING_FAILURE (identical failing sets) keeps rule 4 — containment must not over-block', () => {
    const facts = [
      fact('baseline', 1, { passing: 1, failing: ['s > A'], exit: 1 }),
      fact('baseline', 2, { passing: 1, failing: ['s > A'], exit: 1 }),
      fact('candidate', 1, { passing: 1, failing: ['s > A'], exit: 1 }),
      fact('candidate', 2, { passing: 1, failing: ['s > A'], exit: 1 }),
    ];
    const r = classifyAttested(facts);
    assert.equal(r.classification, 'PRE_EXISTING_FAILURE');
    assert.equal(r.rule, 4);
  });

  it('CONFIRMED_REGRESSION is untouched by containment (baseline has zero failing identities)', () => {
    const r = classifyAttested([
      fact('baseline', 1, { passing: 2, exit: 0 }),
      fact('baseline', 2, { passing: 2, exit: 0 }),
      fact('candidate', 1, { passing: 1, failing: ['s > X'], exit: 1 }),
      fact('candidate', 2, { passing: 1, failing: ['s > X'], exit: 1 }),
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
  });

  it('DOCUMENTED CEILING: version-gated passing-test substitution still PASSes (F3/§8.1) — equality of cardinality + failing sets is the exact invariant', () => {
    // A subject whose suite is version-gated (`if baseline it('A') else
    // it('A2')`, A2 trivially real) yields identical VALID counts with
    // DIFFERENT passing identities — and passing identities are not in the
    // bundle contract, by decision: binding identity strings across two
    // package versions needs a semantic root Canary does not have, and
    // enforcing pass-set equality would deny strong verdicts to legitimate
    // test renames. This test PINS that boundary (codified in
    // EXECUTION-AUTHORITY §8): containment was deliberately NOT extended
    // here. If a future design persists observedPassingIdentities, THIS is
    // the test that flips.
    const r = classifyAttested([
      fact('baseline', 1, { passing: 2, exit: 0 }),
      fact('baseline', 2, { passing: 2, exit: 0 }),
      fact('candidate', 1, { passing: 2, exit: 0 }),
      fact('candidate', 2, { passing: 2, exit: 0 }),
    ]);
    assert.equal(r.classification, 'PASS');
    assert.equal(r.rule, 3);
  });
});

describe('post-GLM round 5 F4 — rule 14 downgrades EVERY FLAKY producer (6/7/8/12)', () => {
  // §11 promised "rule-14 routing for all strong + FLAKY producers"; only
  // producers 2/3/4/5 had routing tests, so deleting the gate for the other
  // four passed the whole suite (round-5 finding 4, mutation-proven). Each
  // shape below reaches its producer on the TEXT channel (verified via the
  // attested twin), then must come out rule 14 without observation.
  const cases: Array<[string, RoundFact[], RegExp]> = [
    ['producer rule 6 (non-unanimous candidate under failing baseline)', [
      fact('baseline', 1, { passing: 4, failing: ['s > q'], exit: 1 }),
      fact('baseline', 2, { passing: 4, failing: ['s > q'], exit: 1 }),
      fact('candidate', 1, { passing: 4, failing: ['s > q'], exit: 1 }),
      fact('candidate', 2, { passing: 5, exit: 0 }), // executed totals stay 5 both rounds (rule 12 clean)
    ], /previously rule 6 FLAKY/],
    ['producer rule 7 (clean baseline, mixed candidate)', [
      fact('baseline', 1, { passing: 5, exit: 0 }),
      fact('baseline', 2, { passing: 5, exit: 0 }),
      fact('candidate', 1, { passing: 4, failing: ['s > q'], exit: 1 }),
      fact('candidate', 2, { passing: 5, exit: 0 }),
    ], /previously rule 7 FLAKY/],
    ['producer rule 8 (failing rounds within an arm differ in identity)', [
      fact('baseline', 1, { passing: 4, failing: ['s > a'], exit: 1 }),
      fact('baseline', 2, { passing: 4, failing: ['s > b'], exit: 1 }),
      fact('candidate', 1, { passing: 5, exit: 0 }),
      fact('candidate', 2, { passing: 5, exit: 0 }),
    ], /previously rule 8 FLAKY/],
    ['producer rule 12 (repetitions differ in coverage totals)', [
      fact('baseline', 1, { passing: 5, exit: 0 }),
      fact('baseline', 2, { passing: 3, exit: 0 }),
      fact('candidate', 1, { passing: 5, exit: 0 }),
      fact('candidate', 2, { passing: 5, exit: 0 }),
    ], /previously rule 12 FLAKY/],
  ];
  for (const [name, facts, expected] of cases) {
    it(`un-attested ${name} -> INCONCLUSIVE 14, never FLAKY`, () => {
      // first prove the shape genuinely reaches the producer (attested twin)
      const attestedRun = classifyAttested(facts);
      assert.equal(attestedRun.classification, 'FLAKY', `shape does not produce FLAKY when attested: ${JSON.stringify(attestedRun)}`);
      // then the gate: same facts, no observation
      const r = classify(facts);
      assert.equal(r.classification, 'INCONCLUSIVE');
      assert.equal(r.rule, 14);
      assert.match(r.reason, expected);
    });
  }
});
