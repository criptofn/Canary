// v1.3 §18 — IS THERE ANY TURN LEFT TO SAVE? (answered from the corpus, not from new trials)
//
// MEASURED UPDATE 3 in the audit established that trimming Canary's own footprint cannot reach the ≤75%
// token target: the standing payload is 5,726 B/turn, about 6% of the everyday arm, so deleting all of
// it returns roughly 2 points. The remaining ~17 points would have to come from the AGENT DOING LESS
// WORK. In the recorded ledgers the dominant cost term is turns × accumulated context — cache-read is
// ~87% of the total — so "less work" means "fewer turns", and the only place Canary adds turns is the
// completion gate: the hook refuses, the model is told why, and it runs again.
//
// That makes one question decisive, and it costs nothing to answer because every trial was already paid
// for: HOW OFTEN DOES THE GATE ACTUALLY BLOCK? If blocks are rare, there is no turn to remove, and the
// target is unreachable by any amount of engineering on the everyday path — which is worth knowing
// before spending a pilot's worth of model tokens to discover it.
//
// This probe reads the stored corpus and reports. It does not re-run anything and it invents no verdict:
// the records are the evidence, and where a field is absent the probe says so rather than assuming zero.
//
// CONFOUND, stated because the numbers below cannot separate it: a blocked run may be blocked BECAUSE it
// is a harder or longer task, so "blocked runs cost more turns" is not by itself proof that the gate
// caused the extra turns. The load-bearing number is the BLOCK RATE, which is a plain count.
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const roots = [
  path.join(repo, 'tooling/benchmark/results'),
  path.join(repo, 'tooling/benchmark/results/session-evidence'),
];
/** Arms in which the Stop hook is installed, so a completion can be gated at all. */
const GATING = new Set(['guarded', 'invisible', 'canary', 'workflow']);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── load every readable trial record ──
const records = [];
let skipped = 0;
for (const root of roots) {
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => n.endsWith('.json')); } catch { continue; }
  for (const n of names) {
    const file = path.join(root, n);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { skipped++; continue; }
    // A trial record names its arm; anything else in this directory is not one.
    if (!doc || typeof doc !== 'object' || typeof doc.arm !== 'string') { skipped++; continue; }
    records.push({ file: n, doc });
  }
}

const gated = records.filter((r) => GATING.has(r.doc.arm));
const turnsOf = (d) => (typeof d.stream?.turns === 'number' ? d.stream.turns : null);
const totalOf = (d) => (typeof d.agentResult?.usage?.totalTokens === 'number' ? d.agentResult.usage.totalTokens : null);
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

console.log(`INFO corpus: ${records.length} trial record(s) with an arm (${skipped} non-trial json skipped)`);
const byArm = {};
for (const r of records) byArm[r.doc.arm] = (byArm[r.doc.arm] ?? 0) + 1;
console.log(`INFO by arm: ${Object.entries(byArm).sort().map(([a, n]) => `${a}=${n}`).join('  ')}`);

check('A1-the-corpus-is-present-and-carries-the-gating-arms', () => {
  assert(records.length > 0, 'no trial records were found, so this probe would measure nothing');
  assert(gated.length > 0,
    `no GATED arm appears in the corpus (arms present: ${Object.keys(byArm).join(', ')}) — the block rate `
    + 'cannot be measured from these records');
});

// ── the load-bearing number: how often did the gate refuse a completion? ──
// The evidence lives in THREE places, and they say different things, so all three are read:
//   canary.hookFired    — the checkpoint file proves the hook ran inside the agent run
//   canary.hookBlocked  — it REFUSED the completion
//   stream.gate.messages— a refusal visibly REACHED the model (the CLI does not emit hook events for a
//                         project-level Stop hook, so this is counted separately)
const firedKnown = gated.filter((r) => typeof r.doc.canary?.hookFired === 'boolean');
const blockedKnown = gated.filter((r) => typeof r.doc.canary?.hookBlocked === 'boolean');
const reachedKnown = gated.filter((r) => typeof r.doc.stream?.gate?.messages === 'number');
console.log(`\nINFO gated trials: ${gated.length}; ${firedKnown.length} record canary.hookFired, `
  + `${blockedKnown.length} record canary.hookBlocked, ${reachedKnown.length} record stream.gate.messages`);

if (blockedKnown.length > 0) {
  const blocked = blockedKnown.filter((r) => r.doc.canary.hookBlocked === true);
  const notBlocked = blockedKnown.filter((r) => r.doc.canary.hookBlocked === false);
  const rate = blocked.length / blockedKnown.length;
  console.log(`INFO BLOCK RATE: ${blocked.length}/${blockedKnown.length} = ${(100 * rate).toFixed(1)}% of gated completions were refused`);

  const bt = blocked.map((r) => turnsOf(r.doc)).filter((x) => x !== null);
  const nt = notBlocked.map((r) => turnsOf(r.doc)).filter((x) => x !== null);
  const bk = blocked.map((r) => totalOf(r.doc)).filter((x) => x !== null);
  const nk = notBlocked.map((r) => totalOf(r.doc)).filter((x) => x !== null);
  console.log(`INFO   blocked    : n=${bt.length} meanTurns=${mean(bt)?.toFixed(1) ?? 'n/a'} meanTokens=${mean(bk) ? Math.round(mean(bk)).toLocaleString('en-US') : 'n/a'}`);
  console.log(`INFO   not blocked: n=${nt.length} meanTurns=${mean(nt)?.toFixed(1) ?? 'n/a'} meanTokens=${mean(nk) ? Math.round(mean(nk)).toLocaleString('en-US') : 'n/a'}`);

  check('A2-hookBlocked-implies-hookFired (the two fields describe the same event)', () => {
    const impossible = blocked.filter((r) => r.doc.canary.hookFired === false);
    assert(impossible.length === 0,
      `${impossible.length} record(s) claim a BLOCK without the hook firing: ${impossible.slice(0, 3).map((r) => r.file).join(', ')}`);
  });

  // NOT an assertion, and the first draft of this probe got it wrong by making it one. run-trial.mjs
  // says why in its own comment: "'the hook fired' and 'the model was told why' are two different
  // claims" — a block recorded at the very end of a run has no later turn in which to tell the model
  // anything. So divergence is expected and is REPORTED, with its count, rather than demanded away.
  const checkable = blocked.filter((r) => typeof r.doc.stream?.gate?.messages === 'number');
  const silent = checkable.filter((r) => r.doc.stream.gate.messages === 0);
  console.log(`INFO   corroboration: ${checkable.length} blocked record(s) carry stream.gate.messages, `
    + `${silent.length} of them with NO refusal in the stream (allowed: a block at the end of a run has no `
    + 'later turn to be told in — the two claims are recorded separately by design)');
  if (silent.length > 0) {
    console.log(`INFO     e.g. ${silent.slice(0, 3).map((r) => `${r.file} (${r.doc.arm})`).join(', ')}`);
  }

  // ── what the target would require ──
  // The denominator is the OVERALL gated mean, not the blocked mean: the question is "what share of a
  // typical gated run is this", and using the blocked mean as the base would quietly overstate it.
  if (bt.length > 0 && nt.length > 0) {
    const saved = mean(bt) - mean(nt);
    const allTurns = [...bt, ...nt];
    const overall = mean(allTurns);
    const expectedSaving = saved * rate;
    const sharePct = 100 * expectedSaving / overall;
    console.log(`\nINFO overall gated mean: ${overall.toFixed(1)} turns/run (n=${allTurns.length})`);
    console.log(`INFO upper bound on turn savings from removing the gate's retry: ${saved.toFixed(1)} turns per BLOCKED run`);
    console.log(`INFO   expected saving per run = ${saved.toFixed(1)} x ${(100 * rate).toFixed(1)}% = ${expectedSaving.toFixed(2)} turns`);
    console.log(`INFO   as a share of the overall gated mean: ~${sharePct.toFixed(1)}%`);
    console.log('INFO   and it is an UPPER bound: a refused completion still has to be communicated once, and');
    console.log('INFO   the confound above (harder tasks may block more) is not removed by this arithmetic.');
  }
} else {
  console.log('INFO no record carries canary.hookBlocked, so the block rate is NOT measurable here — reported, not guessed');
}

// ── the honest summary ──
console.log('\n--- what this means for the <=75% target ---');
console.log('INFO The gate is the only place the everyday path ADDS turns, and a refusal is the product: it is');
console.log('INFO what stops a false done. So the achievable saving is bounded by the block rate above, while the');
console.log('INFO cost of removing it is the false-done protection itself. Recorded as a measurement, not a plan.');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 gate cost — block rate reported from ${gated.length} gated record(s)`);
process.exit(failures === 0 ? 0 : 1);
