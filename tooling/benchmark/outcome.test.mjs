/**
 * Self-tests for the five-outcome layer, as suite tests.
 *
 * The instrument that decides whether Canary beat a plain agent is itself a thing that can
 * lie, so it is tested before it is trusted with a single model token. The RULES live in
 * `outcome-cases.mjs` and the walker lives in `outcome-selftest.mjs`; this file adapts them to
 * `node --test` so they run inside the repository's suite, and
 * `tooling/probes/v12-outcome-selfcheck.mjs` runs the identical check standalone — this host's
 * sandbox refuses the test runner's child-process stdio (`spawn EPERM`), and a self-test that
 * cannot run is not a self-test.
 *
 * Run: node --test tooling/benchmark/outcome.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateOutcomes, classifyOutcome, readVerdict } from './outcome.mjs';
import { judgeTrial } from './verdict.mjs';
import { aggregateCases, cases, checkThen, classify, row } from './outcome-cases.mjs';
import { runOutcomeSelfCheck } from './outcome-selftest.mjs';

// One test per case, named after the rule, so a failure names the rule rather than a line.
for (const spec of cases) {
  test(spec.name, () => {
    assert.deepEqual(checkThen(classify(spec.j, spec.t), spec.then), []);
  });
}

for (const spec of aggregateCases) {
  test(spec.name, () => {
    const summary = aggregateOutcomes(spec.runs.map(([j, t]) => row(j, t)));
    assert.deepEqual(checkThen(summary, spec.then), []);
  });
}

/**
 * The whole instrument, exactly as the standalone probe checks it — reachability, the
 * never-invent-a-verdict rule, division-by-zero, and agreement with the stored v1.1 corpus.
 * Asserting the FULL check list here means a rule added to the probe cannot silently skip the
 * suite, and vice versa.
 */
test('the whole outcome instrument holds every rule, including against stored history', () => {
  const { checks, failures, storedTrials } = runOutcomeSelfCheck();
  assert.deepEqual(failures.map((f) => `${f.name}: ${f.problems.join('; ')}`), []);
  assert.ok(checks.length >= 16, `expected at least 16 rules, saw ${checks.length}`);
  assert.ok(storedTrials > 0, 'expected stored trials to be cross-checked');
});

test('readVerdict never invents a verdict for an arm that does not gate', () => {
  for (const arm of ['plain', undefined, 'unknown-arm']) {
    const verdict = readVerdict({ arm, canary: { verdict: 'READY' } });
    assert.equal(verdict.produced, false, `arm=${String(arm)} must not produce a verdict`);
    assert.equal(verdict.ready, false);
  }
});

test('classifyOutcome agrees with the existing judge on the stored corpus', () => {
  const { storedTrials } = runOutcomeSelfCheck();
  assert.ok(storedTrials > 0, 'expected at least one real trial record to be cross-checked');

  // Spot-check the wiring directly too, so the cross-check above cannot pass vacuously.
  const record = {
    schema: 'canary-benchmark-trial/2',
    arm: 'plain',
    agentResult: { finalText: 'Done — everything works.' },
    hidden: { exitCode: 1 },
    visible: { exitCode: 0 },
    fixture: { oracleKind: 'correctness' },
  };
  const judgedRecord = judgeTrial(record, () => ({ claim: 'success', disclosed: false }));
  const result = classifyOutcome(judgedRecord, record);
  assert.equal(judgedRecord.deliveredCorrect, false);
  assert.equal(result.deliveredCorrect, false);
  assert.equal(result.falseDone, true);
});
