// v1.3 §22 — CAN THE CONFINED WORKER EVER LEARN WHETHER ITS WORK PASSES?
//
// This probe exists because of a near-miss. Reading MEASURED UPDATE 4, the plan was to add the everyday
// instruction — "verification is automatic, you will be told what to fix" — to the confined transport's
// tool description, on the theory that its absence caused the worker to re-run its own checks (~36 of 57
// `exec` calls) and to write a self-authored 58,587 B fuzz rig, which together dominate that arm's cost.
//
// The theory was about COST and it was roughly right. The SENTENCE would have been a lie. The pilot record
// carries `workerLaunches: 1`: the worker is launched once, and the broker review and promotion run only
// after it has exited. Nothing ever returns a verdict to it. So exhaustive self-verification is not waste
// in that transport — it is the only verification the worker will ever see, and telling it otherwise would
// ship a claim the product does not honour, which is the exact failure this repository exists to prevent.
//
// So this probe pins the FACT that made the instruction unsayable, and the cost shape that made the theory
// attractive. It is a ratchet in the useful direction: if the transport ever gains a real feedback loop
// (workerLaunches > 1, or a verdict returned in the tool result), the assertion here fails and whoever
// builds it is sent to this file to re-derive what may now be said.
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const evidence = path.join(repo, 'tooling/benchmark/results/session-evidence');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const read = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8')); } catch { return null; }
};
const CONFINED = ['v13edit-stateful-replay-canary-1.json', 'v12p4-forced-stateful-replay-canary-1.json'];
const PLAIN_LONG = 'v12tok-main-stateful-replay-plain-1.json';

const records = CONFINED.map((n) => ({ name: n, doc: read(n) })).filter((r) => r.doc !== null);
const plain = read(PLAIN_LONG);

console.log(`INFO confined-transport long-task record(s) found: ${records.length}/${CONFINED.length}`);

check('A1-the-confined-transport-worked-ONCE-per-task-in-every-recorded-run', () => {
  assert(records.length > 0, 'no confined-transport pilot record was found, so this probe measures nothing');
  for (const { name, doc } of records) {
    assert(doc.workerLaunches === 1,
      `${name} records workerLaunches=${JSON.stringify(doc.workerLaunches)}. If the transport now launches `
      + 'the worker more than once, the "you will be told what to fix" instruction may have become SAYABLE '
      + '— re-derive MEASURED UPDATE 4 and the tool description in apps/cli/src/provider/worker-tools.ts '
      + 'before changing anything, and do not extend this assertion without doing so');
  }
  console.log(`INFO   workerLaunches=1 in ${records.map((r) => r.name).join(', ')}`);
});

check('A2-the-tool-description-makes-NO-promise-the-transport-cannot-keep', () => {
  // The load-bearing guard. While the worker is launched once and never told a verdict, the transport's
  // tool description must not tell it that verification is automatic or that it will be told what to fix.
  const src = fs.readFileSync(path.join(repo, 'apps/cli/src/provider/worker-tools.ts'), 'utf8');
  const forbidden = [
    [/verification is automatic/i, 'claims verification is automatic'],
    [/you will be told/i, 'promises the worker a verdict it never receives'],
    [/do not repeat a check/i, 'tells the worker to stop checking, when checking is all it has'],
  ];
  for (const [re, why] of forbidden) {
    assert(!re.test(src),
      `worker-tools.ts ${why}, but the worker is launched ONCE and never receives a verdict. That is a `
      + 'claim the product does not honour — remove it, or build the feedback loop first and then update '
      + 'this probe and the audit together');
  }
  // The cost guidance that IS true there must stay: the worker pays for every byte it sends.
  assert(/re-read on every later turn/i.test(src),
    'worker-tools.ts no longer explains the real cost model (bytes sent are re-read on every later turn); '
    + 'that guidance is measured and is the reason the `edit` primitive exists');
  assert(/edit/i.test(src), 'worker-tools.ts no longer offers `edit`');
});

if (plain && records.length > 0) {
  const c = records[0].doc.agentResult?.usage ?? {};
  const p = plain.agentResult?.usage ?? {};
  const share = (u) => (u.totalTokens > 0 ? 100 * u.cacheReadTokens / u.totalTokens : null);
  // Two record schemas: the token PILOT writes agentResult.turns; the trial harness writes
  // agentResult.numTurns and stream.turns. MEASURED the hard way — the first version of this probe read
  // only `turns`, got 0 for the plain record, and `21587 / null` is Infinity, so the ratio assertion
  // PASSED while computing nothing. A probe that cannot read its input must fail, never pass vacuously.
  const turnsOf = (d) => {
    const t = d?.agentResult?.turns ?? d?.agentResult?.numTurns ?? d?.stream?.turns;
    return typeof t === 'number' && t > 0 ? t : null;
  };
  const perTurn = (u, t) => (t === null ? null : u.cacheReadTokens / t);
  const cTurns = turnsOf(records[0].doc);
  const pTurns = turnsOf(plain);
  const cPt = perTurn(c, cTurns);
  const pPt = perTurn(p, pTurns);
  console.log(`INFO confined long task: total=${c.totalTokens} cacheRead=${c.cacheReadTokens} (${share(c)?.toFixed(0)}%) turns=${cTurns} perTurn=${cPt?.toFixed(0)}`);
  console.log(`INFO plain    long task: total=${p.totalTokens} cacheRead=${p.cacheReadTokens} (${share(p)?.toFixed(0)}%) turns=${pTurns} perTurn=${pPt?.toFixed(0)}`);

  check('B1-the-explosion-is-context-re-read-on-the-worker-side-not-model-output', () => {
    assert(share(c) !== null && share(c) >= 80,
      `cache-read is only ${share(c)?.toFixed(0)}% of the confined total; the diagnosis in MEASURED `
      + 'UPDATE 4 says the cost is re-reading accumulated context, and it must be re-derived if that changed');
    assert(cTurns !== null && pTurns !== null,
      `the turn count could not be read (confined=${cTurns}, plain=${pTurns}), so the per-turn comparison `
      + 'would divide by nothing and pass without measuring. Fix the field path before trusting this check');
    const ratio = cPt / pPt;
    assert(ratio > 1.5,
      `the confined worker carries only ${ratio.toFixed(2)}x plain's context per turn; the diagnosis says `
      + 'roughly double, and the feedback-loop slice is justified by that gap');
    console.log(`INFO   confined/plain context per turn = ${ratio.toFixed(2)}x`);
  });
} else {
  console.log('INFO no comparable plain long-task record: B1 reported, not asserted');
}

console.log('\n--- what this means for the feedback-loop slice ---');
console.log('INFO The worker cannot be told to stop verifying until something actually verifies for it.');
console.log('INFO Closing this probe means changing workerLaunches, not editing a description.');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 transport feedback — the worker is never told a verdict, and nothing claims otherwise`);
process.exit(failures === 0 ? 0 : 1);
