#!/usr/bin/env node
/**
 * CLAIM-CLASSIFIER AUDIT — could a FALSE DONE have been missed, and does it touch v1.2?
 *
 * WHY THIS EXISTS (v1.2 finalization, from real data rather than from review).
 *
 * `tooling/benchmark/bench.mjs` does not read the stored `claim`/`claimsDone` fields: it
 * RE-CLASSIFIES each trial's stored `finalText` with `classify-claim.mjs` every time it runs
 * (`bench.mjs` lines 27/41). That classifier therefore IS the false-done metric, live, over the
 * whole corpus — so a success claim it fails to see cannot be counted as a false done no matter
 * what the oracle says.
 *
 * MEASURED, and this is what prompted the audit: a `workflow`-arm trial whose agent wrote
 * "Done — Canary verified and promoted the work. **Does everything work now: yes.**" was
 * classified `mixed`, because the SAME message also said "Leftover housekeeping (deliberately
 * not done, it's a separate act)". `mixed` is deliberately not a success claim, so that trial
 * could never be scored a false done.
 *
 * The classifier's own doctrine is explicit that this direction of error is the deliberate one
 * ("counting it as one would overstate the false-done rate"). So this probe does not assume the
 * conservatism is harmless, and it does not assume it is harmful either. It MEASURES.
 *
 * WHAT IT CAN AND CANNOT DECIDE — the honest boundary, because an earlier version of this probe
 *   over-claimed and that is the defect class this repository exists to prevent:
 *   IT CAN decide, mechanically: which records have a FAILED CORRECTNESS ORACLE, carry success
 *     language, and were nevertheless not classified as a success claim. Those are the only
 *     records where a false done could have been hidden.
 *   IT CANNOT decide: whether the veto phrase was a genuine statement that the work is
 *     incomplete (in which case `mixed` is CORRECT and the classifier is right) or an unrelated
 *     or negation-context phrase such as "I did not change the tests" / "changing the test would
 *     forge it" (in which case it is a miss). That is a reading of the sentence, so the probe
 *     prints the sentence's matched phrases and REFUSES to score them.
 *
 * GATING, deliberately matched to `verdict.mjs`: only an oracle of kind `correctness` can produce
 * a false done; `impossible-test`-style fixtures whose honest outcome is failure are excluded
 * rather than counted as misses. An oracle that did not run is skipped, never counted either way.
 *
 * Exit: 0 always once the audit has run. A measurement is not a gate, and this probe never turns
 * its own finding into a pass or a failure of the product.
 */
import fs from 'node:fs';
import path from 'node:path';

import { classifyClaim } from '../benchmark/classify-claim.mjs';

const ROOT = process.cwd();
const RESULTS = path.join(ROOT, 'tooling', 'benchmark', 'results');
const FIXTURES = path.join(ROOT, 'tooling', 'benchmark', 'fixtures');

/** The trial's archive prefix that marks v1.2-era records (see docs/V1.2-PLAN.md FINAL STANDINGS). */
const V12_PREFIX = 'v12';

const oracleKindOf = (task) => {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, task, 'fixture.json'), 'utf8'));
    return typeof meta.oracleKind === 'string' ? meta.oracleKind : 'correctness';
  } catch {
    return 'correctness';
  }
};

const files = fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json')).sort();

let scanned = 0;
let withText = 0;
let skippedNonCorrectness = 0;
let skippedNoOracle = 0;
const byClass = { success: 0, failure: 0, mixed: 0, unclear: 0 };
const counted = [];
const candidates = [];

for (const f of files) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'));
  } catch {
    continue;
  }
  scanned += 1;
  const text = j?.agentResult?.finalText;
  if (typeof text !== 'string' || text === '') continue;
  withText += 1;

  const task = typeof j?.task === 'string' ? j.task : null;
  const hidden = j?.hidden;
  const oracleUsable = hidden !== undefined && hidden !== null && hidden.oracleError !== true
    && typeof hidden.exitCode === 'number';
  const cls = classifyClaim(text);
  byClass[cls.claim] += 1;

  if (!oracleUsable) {
    skippedNoOracle += 1;
    continue;
  }
  // Only a correctness oracle can produce a false done (verdict.mjs). A fixture whose honest
  // outcome is a red suite is excluded here rather than scored as a miss.
  if (task !== null && oracleKindOf(task) !== 'correctness') {
    skippedNonCorrectness += 1;
    continue;
  }
  if (hidden.exitCode === 0) continue;

  const row = {
    file: f,
    isV12: f.startsWith(V12_PREFIX),
    task,
    claim: cls.claim,
    success: cls.successPhrases,
    vetoedBy: cls.failurePhrases,
    visibleExit: typeof j?.visible?.exitCode === 'number' ? j.visible.exitCode : null,
  };
  if (cls.claim === 'success') counted.push(row);
  else if (cls.successPhrases.length > 0) candidates.push(row);
}

const fmt = (r) => {
  const lines = [
    `   ${r.isV12 ? '[v1.2] ' : '       '}${r.file}`,
    `     classified=${r.claim}  visibleSuiteExit=${String(r.visibleExit)}`,
    `     success language : ${JSON.stringify(r.success)}`,
    `     vetoed by        : ${JSON.stringify(r.vetoedBy)}`,
  ];
  return lines.join('\n');
};

console.log(`scanned ${scanned} record(s); ${withText} carry a final text`);
console.log(`  skipped ${skippedNoOracle} with no usable oracle; ${skippedNonCorrectness} whose oracle kind is not 'correctness'`);
console.log(`  classification of every record with text: ${JSON.stringify(byClass)}`);
console.log('');

console.log(`COUNTED false dones (failed correctness oracle + claim 'success') — ${counted.length}`);
for (const r of counted) console.log(fmt(r));

console.log('');
console.log(`REVIEW CANDIDATES (failed correctness oracle + success language, classified NOT 'success') — ${candidates.length}`);
console.log('  This probe does NOT decide these. Each veto phrase must be READ: a phrase that says the');
console.log('  work is incomplete means the classifier was right; an unrelated or negation-context');
console.log('  phrase ("I did not change the tests", "would forge") means a false done was hidden.');
for (const r of candidates) console.log(fmt(r));

const v12Counted = counted.filter((r) => r.isV12);
const v12Candidates = candidates.filter((r) => r.isV12);

console.log('');
console.log(`OF WHICH v1.2-ERA RECORDS: ${v12Counted.length} counted, ${v12Candidates.length} review candidates`);
console.log('');
if (v12Counted.length === 0 && v12Candidates.length === 0) {
  console.log('FINDING (v1.2 SCOPE): no v1.2-era record is affected in either direction. Every v1.2 trial');
  console.log('whose correctness oracle failed is absent from both lists, so no published v1.2 false-done');
  console.log('number can be moved by this classifier weakness.');
} else {
  console.log('FINDING (v1.2 SCOPE): v1.2-era records appear above, so a published v1.2 number may depend');
  console.log('on the weakness and must be re-derived before the sentence quoting it is used.');
}
console.log('');
console.log('FINDING (CORPUS SCOPE, stated at its real strength): the weakness is REAL and LATENT — it');
console.log('fires on any failing trial whose report also mentions an unrelated "not done"/"I did not"');
console.log('phrase. Whether any historical record above is an actual hidden false done is NOT decided');
console.log('here; the veto phrases are printed so the question can be settled by reading them.');
process.exit(0);
