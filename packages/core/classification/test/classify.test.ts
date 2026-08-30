import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classify, type RoundFact } from '../src/index.js';

/** Build a healthy test round (runner summary present, no infra noise). */
function arm(kind: 'baseline' | 'candidate', round: number, pass = true): RoundFact {
  return {
    arm: kind, round,
    exitCode: pass ? 0 : 1,
    hasRunnerSummary: true,
    infraSignal: false,
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

  it('is pure: same facts always yield the same verdict', () => {
    const facts: RoundFact[] = [
      arm('baseline', 1), arm('candidate', 1, false), arm('candidate', 2, false),
    ];
    const a = classify(facts);
    const b = classify(facts);
    assert.deepEqual(a, b);
  });
});
