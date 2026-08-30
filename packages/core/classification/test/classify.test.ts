import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyConfinementGuard, classify, type RoundFact } from '../src/index.js';

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
    ...(pass ? {} : { reportedFailing: 1, failingTestNames: ['placeholder test'] }),
  };
}

describe('classify — decision table (docs/PLAN.md section 6)', () => {
  it('rule 3: baseline unanimous pass + candidate unanimous pass -> PASS', () => {
    const r = classify([arm('baseline', 1), arm('baseline', 2), arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(r.classification, 'PASS');
    assert.equal(r.rule, 3);
  });

  it('rule 5: baseline passes, all candidate rounds fail -> CONFIRMED_REGRESSION', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      arm('candidate', 1, false), arm('candidate', 2, false), arm('candidate', 3, false),
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
    assert.equal(r.details.candidateFailures, 3);
  });

  it('rule 4: baseline fails with real summaries + candidate fails -> PRE_EXISTING_FAILURE', () => {
    const r = classify([arm('baseline', 1, false), arm('baseline', 2, false), arm('candidate', 1, false)]);
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
    const r = classify([arm('baseline', 1), arm('baseline', 2, false), arm('candidate', 1, false)]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 2);
  });

  it('rule 7: clean baseline, mixed candidate -> FLAKY, not CONFIRMED', () => {
    const r = classify([
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
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      { ...arm('candidate', 1, false), reportedFailing: 3, failingTestNames: ['a', 'b', 'c'] },
      { ...arm('candidate', 2, false), reportedFailing: 5, failingTestNames: ['a', 'b', 'c', 'd', 'e'] },
    ]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 8);
  });

  it('audit F2: same count but DIFFERENT failing-test identities -> FLAKY rule 8', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      { ...arm('candidate', 1, false), reportedFailing: 2, failingTestNames: ['alpha', 'beta'] },
      { ...arm('candidate', 2, false), reportedFailing: 2, failingTestNames: ['alpha', 'gamma'] },
    ]);
    assert.equal(r.classification, 'FLAKY');
    assert.equal(r.rule, 8);
  });

  it('audit F2: identical failure profiles (golden shape) -> still CONFIRMED_REGRESSION rule 5', () => {
    const golden = (round: number): RoundFact => ({
      arm: 'candidate', round, exitCode: 3,
      hasRunnerSummary: true, infraSignal: false,
      reportedFailing: 3,
      failingTestNames: ['can pass headers to match to a handler', 'handles baseURL correctly'],
    });
    const r = classify([
      arm('baseline', 1), arm('baseline', 2), golden(1), golden(2), golden(3),
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
    assert.equal(r.rule, 5);
  });

  it('audit F2: profile comparison is order-independent (sorted identities)', () => {
    const r = classify([
      arm('baseline', 1), arm('baseline', 2),
      { ...arm('candidate', 1, false), reportedFailing: 2, failingTestNames: ['beta', 'alpha'] },
      { ...arm('candidate', 2, false), reportedFailing: 2, failingTestNames: ['alpha', 'beta'] },
    ]);
    assert.equal(r.classification, 'CONFIRMED_REGRESSION');
  });

  it('audit F2: unstable baseline failure identities block PRE_EXISTING_FAILURE -> FLAKY', () => {
    const r = classify([
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
    const a = classify(facts);
    const b = classify(facts);
    assert.deepEqual(a, b);
  });
});

describe('audit F9 — applyConfinementGuard (rule 9, enforced not decorative)', () => {
  const confirmedFacts: RoundFact[] = [
    arm('baseline', 1), arm('baseline', 2), arm('candidate', 1, false), arm('candidate', 2, false),
  ];

  it('downgrades CONFIRMED_REGRESSION to INCONCLUSIVE rule 9 when drift is unconfined', () => {
    const cls = classify(confirmedFacts);
    assert.equal(cls.classification, 'CONFIRMED_REGRESSION'); // guard absent, rule 5
    const g = applyConfinementGuard(cls, { confined: false, other: ['left-pad'], dependency: 'axios' });
    assert.equal(g.classification, 'INCONCLUSIVE');
    assert.equal(g.rule, 9);
    assert.match(g.reason, /left-pad/);
    assert.match(g.reason, /axios subtree/);
  });

  it('is identity when drift IS confined (a legit CONFIRMED survives)', () => {
    const cls = classify(confirmedFacts);
    const g = applyConfinementGuard(cls, { confined: true, other: [], dependency: 'axios' });
    assert.deepEqual(g, cls);
  });

  it('never masks an INFRASTRUCTURE_FAILURE (higher-fidelity reason kept)', () => {
    const infra = classify([
      arm('baseline', 1), { ...arm('candidate', 1, false), hasRunnerSummary: false }, // rule-1 infra
    ]);
    assert.equal(infra.classification, 'INFRASTRUCTURE_FAILURE');
    const g = applyConfinementGuard(infra, { confined: false, other: ['evil'], dependency: 'axios' });
    assert.equal(g.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(g.rule, 1);
  });

  it('downgrades PASS and PRE_EXISTING_FAILURE too (any trustful verdict needs comparable arms)', () => {
    const passCls = classify([arm('baseline', 1), arm('candidate', 1), arm('candidate', 2)]);
    assert.equal(passCls.classification, 'PASS');
    assert.equal(applyConfinementGuard(passCls, { confined: false, other: ['x'], dependency: 'axios' }).rule, 9);

    const preCls = classify([arm('baseline', 1, false), arm('candidate', 1, false)]);
    assert.equal(preCls.classification, 'PRE_EXISTING_FAILURE');
    assert.equal(applyConfinementGuard(preCls, { confined: false, other: ['x'], dependency: 'axios' }).rule, 9);
  });

  it('guard removal would flip the outcome: identical facts, opposite confinement', () => {
    const cls = classify(confirmedFacts);
    const confined = applyConfinementGuard(cls, { confined: true, other: [], dependency: 'axios' });
    const unconfined = applyConfinementGuard(cls, { confined: false, other: ['evil-pkg'], dependency: 'axios' });
    assert.equal(confined.classification, 'CONFIRMED_REGRESSION');
    assert.equal(unconfined.classification, 'INCONCLUSIVE');
  });
});
