/**
 * The outcome self-check, as one function — so the standalone probe and the suite test run
 * IDENTICAL verification rather than two lookalikes.
 *
 * Walks the cases in `outcome-cases.mjs`, plus the cross-checks against the trials v1.1 really
 * stored, and returns `{ checks, failures }`. It never exits and never prints: the probe and
 * the suite test each decide how a human sees it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { OUTCOME, OUTCOME_ORDER, aggregateOutcomes, classifyOutcome, readVerdict } from './outcome.mjs';
import { judgeTrial } from './verdict.mjs';
import { aggregateCases, cases, checkThen, classify, row } from './outcome-cases.mjs';

const BENCH = import.meta.dirname;

/** Every stored trial record in `results/`, in stable order. Aggregate files are skipped. */
function storedTrials() {
  const dir = path.join(BENCH, 'results');
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // not a trial record
    }
    if (record?.schema === 'canary-benchmark-trial/2') out.push({ file, record });
  }
  return out;
}

export function runOutcomeSelfCheck() {
  const checks = [];
  const failures = [];

  const record = (name, problems) => {
    if (problems.length === 0) checks.push(name);
    else failures.push({ name, problems });
  };

  for (const spec of cases) {
    record(spec.name, checkThen(classify(spec.j, spec.t), spec.then));
  }

  for (const spec of aggregateCases) {
    const summary = aggregateOutcomes(spec.runs.map(([j, t]) => row(j, t)));
    record(spec.name, checkThen(summary, spec.then));
  }

  // Every outcome must be reachable; a definition nothing can produce is decoration.
  // `classify` takes OVERRIDES (see outcome-cases.mjs), so the arms and verdicts that shape
  // each outcome are stated explicitly here rather than relying on the default record.
  {
    const reached = new Set([
      classify({}, { canary: { verdict: 'READY' } }).outcome, // TRUE_DONE
      classify({ claim: 'unclear', claimsSuccess: false }, { canary: { verdict: 'READY' } }).outcome, // DELIVERED_CORRECT
      classify({ deliveredCorrect: false }, { canary: { verdict: 'NOT PROVEN' } }).outcome, // FALSE_DONE
      classify({ deliveredCorrect: false }, { canary: { verdict: 'READY' } }).outcome, // FALSE_GREEN
      classify({ deliveredCorrect: false, claim: 'failure', claimsSuccess: false }, { canary: { verdict: 'NOT PROVEN' } }).outcome, // NOT_DONE
      classify({ oracleUsable: false }, {}).outcome, // UNUSABLE
    ]);
    const problems = [];
    for (const value of OUTCOME_ORDER) {
      if (reached.has(value) !== true) problems.push(`outcome ${value} is not reachable from any input`);
    }
    record('every published outcome is reachable', problems);
  }

  // An arm that does not gate must never be credited with a verdict.
  {
    const problems = [];
    for (const arm of ['plain', undefined, 'unknown-arm']) {
      const verdict = readVerdict({ arm, canary: { verdict: 'READY' } });
      if (verdict.produced !== false || verdict.ready !== false) {
        problems.push(`arm=${String(arm)} was credited with a verdict it cannot produce`);
      }
    }
    record('readVerdict never invents a verdict for an arm that does not gate', problems);
  }

  // Division-by-zero must be null, not 0.
  {
    const summary = aggregateOutcomes([]);
    const problems = [];
    if (summary.falseDoneRate !== null) problems.push(`empty corpus falseDoneRate = ${String(summary.falseDoneRate)}`);
    if (summary.falseGreenRate !== null) problems.push(`empty corpus falseGreenRate = ${String(summary.falseGreenRate)}`);
    record('an empty corpus divides by zero as null, never as 0', problems);
  }

  // CONTACT WITH REAL HISTORY: the layer must agree with the existing judge on every record.
  const stored = storedTrials();
  {
    const problems = [];
    if (stored.length === 0) problems.push('no stored trial records were found to cross-check');
    for (const { file, record: trialRecord } of stored) {
      const judgedRecord = judgeTrial(trialRecord, () => ({ claim: trialRecord.claim ?? 'unclear', disclosed: false }));
      const result = classifyOutcome(judgedRecord, trialRecord);
      if (result.deliveredCorrect !== judgedRecord.deliveredCorrect) {
        problems.push(`${file}: deliveredCorrect disagrees with the existing judge`);
      }
      if (result.claim !== judgedRecord.claim) problems.push(`${file}: claim disagrees with the existing judge`);
      if (Object.values(OUTCOME).includes(result.outcome) !== true) {
        problems.push(`${file}: unknown outcome ${String(result.outcome)}`);
      }
    }
    record(`agrees with ${stored.length} stored trial records from the v1.1 corpus`, problems);
  }

  return { checks, failures, storedTrials: stored.length };
}
