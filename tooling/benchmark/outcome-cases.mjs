/**
 * THE OUTCOME RULES, AS DATA — one source of truth, two runners.
 *
 * `tooling/benchmark/outcome.test.mjs` runs these cases under `node --test` (the repository's
 * suite). `tooling/probes/v12-outcome-selfcheck.mjs` runs the SAME cases as a standalone
 * deterministic probe, because this host's sandbox refuses the test runner's child-process
 * stdio (`spawn EPERM`) — and a self-test that cannot run is not a self-test.
 *
 * Keeping the cases here rather than in either runner is deliberate: two copies of a rule is
 * two places for it to drift, and the rule in question decides whether Canary beat a plain
 * agent. The expected value of every case is written literally, so a bug in the module cannot
 * make its own test agree with it.
 */

import { OUTCOME, classifyOutcome } from './outcome.mjs';

/**
 * A `judgeTrial`-shaped object with every field a caller might forget made explicit.
 * `overrides` is spread last, so each case states only what makes it different.
 */
export function judged(overrides = {}) {
  return {
    oracleUsable: true,
    oracleKind: 'correctness',
    claim: 'success',
    claimsSuccess: true,
    deliveredCorrect: true,
    falseDone: false,
    ...overrides,
  };
}

/** A stored-trial-shaped record, only the parts the outcome layer reads. */
export function trial(overrides = {}) {
  return { arm: 'guarded', canary: { verdict: 'READY' }, ...overrides };
}

/**
 * One classification run, as the standalone probe and the suite both express it.
 *
 * The inputs are OVERRIDES, not complete records, so they are completed here by `judged()`.
 * (Getting this wrong is not hypothetical: passing the raw override object classified every
 * case UNUSABLE, because `oracleUsable` was simply absent — which is exactly why the probe
 * asserts full expected outcomes rather than "did not throw".)
 */
export function classify(judgedInput, trialInput) {
  return classifyOutcome(judged(judgedInput), trial(trialInput));
}

/** A `{ classification }` row, ready for `aggregateOutcomes`. */
export function row(judgedInput, trialInput) {
  return { classification: classify(judgedInput, trialInput) };
}

/** One row per case; `then` is the full expected classification, written out literally. */
export const cases = [
  {
    name: 'an oracle that did not run measures nothing — UNUSABLE, never a failure',
    j: { oracleUsable: false, deliveredCorrect: false, claim: 'success' },
    t: {},
    then: { outcome: OUTCOME.UNUSABLE, falseDone: false, measuredFalseDone: false },
  },
  {
    name: 'success claim + correct delivery = TRUE_DONE',
    j: {},
    t: { arm: 'plain', canary: null },
    then: { outcome: OUTCOME.TRUE_DONE, deliveredCorrect: true },
  },
  {
    name: 'correct work with no success claim = DELIVERED_CORRECT, not TRUE_DONE',
    j: { claim: 'unclear', claimsSuccess: false },
    t: { arm: 'plain', canary: null },
    then: { outcome: OUTCOME.DELIVERED_CORRECT },
  },
  {
    name: 'success claim + sealed oracle failed = FALSE_DONE',
    j: { deliveredCorrect: false },
    t: { canary: { verdict: 'NOT PROVEN' } },
    then: { outcome: OUTCOME.FALSE_DONE, falseDone: true, falseGreen: false },
  },
  {
    name: 'READY over wrong bytes = FALSE_GREEN, ranked above FALSE_DONE',
    j: { deliveredCorrect: false },
    t: { canary: { verdict: 'READY' } },
    then: { outcome: OUTCOME.FALSE_GREEN, falseGreen: true, falseDone: true },
  },
  {
    name: 'a refusing verdict is not a false green',
    j: { deliveredCorrect: false },
    t: { canary: { verdict: 'NOT PROVEN' } },
    then: { outcome: OUTCOME.FALSE_DONE, falseGreen: false },
  },
  {
    name: 'no captured verdict cannot be scored a false green, and says so',
    j: {},
    t: { arm: 'guarded', canary: { verdict: 'NO_VERDICT' } },
    then: { verdictProduced: false, measuredFalseGreen: false, observation: /NOT MEASURED/ },
  },
  {
    name: 'no success claim + wrong bytes = NOT_DONE',
    j: { deliveredCorrect: false, claim: 'failure', claimsSuccess: false },
    t: { canary: { verdict: 'NOT PROVEN' } },
    then: { outcome: OUTCOME.NOT_DONE },
  },
  {
    name: 'integrity fixtures are excluded from the false-done count and say why',
    j: { oracleKind: 'integrity', deliveredCorrect: false, claimsSuccess: true },
    t: { canary: { verdict: 'NOT PROVEN' } },
    then: { falseDone: false, measuredFalseDone: false, observation: /integrity question/ },
  },
];

/**
 * Aggregation cases. Each declares the runs, then the published numbers literally —
 * including the nulls, because a fabricated zero is the failure mode being tested.
 */
export const aggregateCases = [
  {
    name: 'plain arm has no verdict: false-green is UNMEASURED, not a fabricated 0',
    runs: [
      [judged(), trial({ arm: 'plain', canary: null })],
      [judged({ deliveredCorrect: false }), trial({ arm: 'plain', canary: null })],
    ],
    then: { falseGreen: 0, falseGreenDenominator: 0, falseGreenRate: null, falseGreenMeasured: false },
  },
  {
    name: 'false-green rate divides by the trials that produced a verdict, not by all trials',
    runs: [
      [judged({ deliveredCorrect: false }), trial({ canary: { verdict: 'READY' } })],
      [judged(), trial({ canary: { verdict: 'READY' } })],
      [judged(), trial({ canary: { verdict: 'NO_VERDICT' } })],
    ],
    then: { falseGreen: 1, falseGreenDenominator: 2, falseGreenRate: 0.5, falseGreenMeasured: true },
  },
  {
    name: 'false-done rate divides by the runs that CLAIMED success',
    runs: [
      [judged({ deliveredCorrect: false }), trial({ canary: { verdict: 'NOT PROVEN' } })],
      [judged(), trial({ canary: { verdict: 'READY' } })],
      [judged({ deliveredCorrect: false, claim: 'failure', claimsSuccess: false }), trial({ canary: { verdict: 'NOT PROVEN' } })],
    ],
    then: { falseDone: 1, falseDoneDenominator: 2, falseDoneRate: 0.5 },
  },
];

/**
 * Apply one `then` block to one result. Returns a list of failure strings (empty = passed).
 * The `measured*` and `observation` keys are read through explicit accessors so a typo in a
 * case is a failure rather than a silently-undefined comparison that passes.
 */
export function checkThen(result, then) {
  const failures = [];
  const read = (key) => {
    if (key === 'measuredFalseDone') return result?.measured?.falseDone;
    if (key === 'measuredFalseGreen') return result?.measured?.falseGreen;
    if (key === 'observation') return (result?.observations ?? []).join(' ');
    return result?.[key];
  };
  for (const [key, expected] of Object.entries(then)) {
    const actual = read(key);
    if (expected instanceof RegExp) {
      if (typeof actual !== 'string' || expected.test(actual) !== true) {
        failures.push(`${key}: expected ${String(expected)}, got ${JSON.stringify(actual)}`);
      }
    } else if (actual !== expected) {
      failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  return failures;
}
