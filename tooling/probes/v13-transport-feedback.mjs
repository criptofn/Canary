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

check('A4-the-worker-SUCCEEDED-first-time-so-a-retry-loop-would-not-have-fired', () => {
  // This assertion exists to stop a wrong fix being inherited. The first spec for this area proposed a
  // driver re-launch loop: verify after a worker run, and launch again with the failure report. That is a
  // robustness feature for FAILURES, not a cure for this explosion — and the records say there was no
  // failure to recover from. Both long runs passed review and promotion on their single launch. A loop
  // would have been dead code on exactly the runs whose cost it was proposed to reduce. The cost comes
  // from verification the worker does INSIDE its one launch because nothing answers it there.
  for (const { name, doc } of records) {
    assert(doc.broker?.review === 200 && doc.broker?.promote === 200,
      `${name} did not pass review+promotion on its single launch (review=${doc.broker?.review}, `
      + `promote=${doc.broker?.promote}). If a confined run now FAILS and needs retrying, a re-launch loop `
      + 'has become a real option — re-derive the slice before building it, and update MEASURED UPDATE 4');
    assert(doc.deliveredCorrect === true,
      `${name} was not delivered correct; the argument that a retry loop would not have fired does not hold`);
  }
  console.log('INFO   both long runs passed review+promote on their ONE launch — the cost is intra-run, not retry-driven');
});

check('A3-the-confined-tool-surface-cannot-initiate-verification', () => {
  // The feedback loop must NOT be built inside this handler, and this is the assertion that says so.
  // model-transport.ts registers this server INSIDE the confined launch (`--bare --restricted --tools ''`
  // with `--mcp-config`), so the handler runs under the very confinement it confines the worker with: it
  // cannot reach the trusted environment, trusted directories, sanitized env or the pre-gates that the
  // real verification owner uses. A "verify here" call added inside it would be the worker's own process
  // judging the worker's own workspace — a second, weaker gate. The loop belongs at the DRIVER.
  const transport = fs.readFileSync(path.join(repo, 'apps/cli/src/provider/model-transport.ts'), 'utf8');
  const launchLine = transport.split('\n').find((l) => l.includes('--restricted')) ?? '';
  assert(launchLine.includes('--restricted') && launchLine.includes('--mcp-config'),
    'model-transport.ts no longer registers the worker tool server inside a restricted launch; the reason '
    + 'verification cannot live in the tool handler has changed, so re-derive MEASURED UPDATE 4');
  assert(transport.includes("'--tools'") && /'--tools',\s*''/.test(transport),
    'the confined launch no longer empties the native tool set, so the worker may have tools outside this '
    + 'surface and the cost diagnosis no longer describes what the worker can do');

  const src = fs.readFileSync(path.join(repo, 'apps/cli/src/provider/worker-tools.ts'), 'utf8');
  assert(/No authority operations/i.test(src),
    'worker-tools.ts no longer states that authority operations are unavailable there');
  const enumLine = src.split('\n').find((l) => l.includes("enum:")) ?? '';
  assert(enumLine.includes("'list'") && enumLine.includes("'edit'"),
    `the confined op enum changed unexpectedly: ${enumLine.trim()}`);
  for (const verb of ['isolate', 'promote', 'accept', 'verify']) {
    assert(!new RegExp(`case '${verb}'`, 'i').test(src),
      `worker-tools.ts handles a '${verb}' case — verification must not be initiable from inside the `
      + 'confined handler; put the feedback loop at the driver instead');
  }
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

check('B2-the-long-run-is-already-near-the-transport-WALL-CLOCK-ceiling', () => {
  // This is the assertion that killed the per-batch feedback design before it was written, and it exists
  // so nobody re-proposes it without seeing why. model-transport.ts enforces a hard ceiling and responds
  // to it by KILLING the run: `model transport timed out; no promotion`. It is not a soft budget — a run
  // that exceeds it FAILS. The measured long confined runs sit at ~90% of that ceiling, so any design that
  // adds work per batch (running the project's suite after each of ~23 requests) converts a 280%-cost run
  // into a timed-out one. The token explosion and the time ceiling are the same problem.
  const transport = fs.readFileSync(path.join(repo, 'apps/cli/src/provider/model-transport.ts'), 'utf8');
  const m = /(\d+)\s*\*\s*60000/.exec(transport);
  assert(m, 'model-transport.ts no longer expresses its timeout as <n> * 60000; re-derive the ceiling '
    + 'before trusting the headroom below');
  const ceilingMs = Number(m[1]) * 60000;
  const durations = records.map((r) => r.doc.durationMs).filter((d) => typeof d === 'number');
  assert(durations.length > 0, 'no confined record carries durationMs, so this probe would measure nothing');
  const worst = Math.max(...durations);
  const share = 100 * worst / ceilingMs;
  console.log(`INFO transport ceiling ${ceilingMs / 60000} min; worst confined long run ${(worst / 60000).toFixed(2)} min = ${share.toFixed(0)}% of it`);
  const headroomMin = (ceilingMs - worst) / 60000;
  console.log(`INFO   headroom: ${headroomMin.toFixed(2)} min`);
  assert(share >= 80,
    `the worst confined long run uses only ${share.toFixed(0)}% of the ceiling. If these runs are now far `
    + 'from the timeout, the argument that per-batch work is unaffordable no longer holds and the withdrawn '
    + 'design in MEASURED UPDATE 4 should be reconsidered rather than inherited as settled');
});

check('C1-the-per-batch-check-HALVED-the-long-task-with-correctness-intact', () => {
  // The measured outcome of the one permitted pilot, pinned so the audit's headline stays checkable rather
  // than becoming a number nobody can reproduce. The record is a historical artifact, so it does not drift;
  // a REGRESSION in the feature is caught behaviourally by v13-confin-check.mjs, not here.
  const treated = read('v13check-stateful-replay-canary-1.json');
  if (!treated) {
    console.log('INFO the per-batch treatment record is absent: C1 reports rather than asserts');
    return;
  }
  const baselines = [
    read('v13edit-stateful-replay-canary-1.json'),
    read('v12p4-forced-stateful-replay-canary-1.json'),
  ].filter(Boolean);
  assert(baselines.length > 0, 'no confined baseline record to compare the treatment against');

  const totalOf = (d) => d.agentResult?.usage?.totalTokens ?? null;
  const t = totalOf(treated);
  assert(typeof t === 'number' && t > 0, 'the treatment record carries no usable total');
  for (const b of baselines) {
    const base = totalOf(b);
    assert(typeof base === 'number',
      `baseline ${b.label} carries no total, so the comparison would be vacuous`);
    const cut = 100 * (base - t) / base;
    console.log(`INFO   ${b.label}: ${base.toLocaleString('en-US')} -> ${t.toLocaleString('en-US')} = ${cut.toFixed(1)}% lower`);
    assert(cut > 25,
      `the treatment is only ${cut.toFixed(1)}% below ${b.label}. If the effect has shrunk this far, the `
      + 'mechanism no longer explains the result and MEASURED UPDATE 4 must be re-derived');
  }
  // Correctness is the whole point: a cheaper run that stopped being right is not a win. The trusted steps
  // must all still be where they were.
  assert(treated.deliveredCorrect === true, 'the treatment run did not deliver correct');
  assert(treated.broker?.review === 200 && treated.broker?.promote === 200,
    `the trusted broker steps did not both pass (review=${treated.broker?.review}, promote=${treated.broker?.promote})`);
  assert(treated.promoted?.hidden?.passing === treated.promoted?.hidden?.total && treated.promoted?.hidden?.total > 0,
    'the promoted bytes did not pass the hidden oracle in full');
  console.log(`INFO   correctness intact: broker ${treated.broker.review}/${treated.broker.promote}, hidden ${treated.promoted.hidden.passing}/${treated.promoted.hidden.total}, deliveredCorrect`);
});

check('A5-the-pilot-record-says-whether-a-model-session-ACTUALLY-happened', () => {
  // The confined transport refuses on an unbound requirement BEFORE spawning (model-transport.ts:27), which
  // exits 3 with no result event and ZERO tokens. The pilot used to hardcode `workerLaunches: 1` for that,
  // so an UNBOUND fixture — where no worker ever ran — read as a worker that ran and failed. That is a
  // different fact, and the wrong one: unbound fixtures get 0 launches, 0 worker tokens and no
  // delivered-correctness credit. Pinned at the SOURCE so it holds on a fresh clone, where the (untracked)
  // session evidence this probe otherwise reads is absent.
  const pilot = fs.readFileSync(path.join(repo, 'tooling/probes/v12-token-pilot.mjs'), 'utf8');
  // Strip comments first. MEASURED (this check failed on its first run): the explanatory comment that
  // documents the old behaviour contains the literal `workerLaunches: 1`, so a naive source grep matched the
  // documentation ABOUT the bug and reported the bug. Assertions about code must read code.
  const pilotCode = pilot.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert(!/workerLaunches:\s*1\b/.test(pilotCode),
    'v12-token-pilot.mjs hardcodes workerLaunches: 1 again. A refused fixture (0 tokens, no model call) '
    + 'would then be recorded as a worker launch, and an aggregator could score it as a Canary correctness '
    + 'failure rather than as a fixture outside confined mode\'s coverage');
  assert(/workerLaunches:\s*workerRan\s*\?\s*1\s*:\s*0/.test(pilotCode),
    'the pilot no longer derives workerLaunches from whether a model session really happened');
  assert(/refusedBeforeModel/.test(pilotCode),
    'the pilot no longer records WHY there was no launch, so a refused record cannot be told from a silent '
    + 'failure without re-deriving it from the token count');
  console.log('INFO   the pilot derives workerLaunches from an actual model session, and says why when there was none');
});

console.log('\n--- what this means for the slice ---');
console.log('INFO TWO designs are ruled out by measurement:');
console.log('INFO   a description sentence  (A2 — it would be false: nothing tells the worker anything)');
console.log('INFO   a re-launch loop        (A4 — nothing failed, so it would never have fired)');
console.log('INFO A THIRD was withdrawn here and then REOPENED, and B2 must not be read as closing it:');
console.log('INFO   per-batch suite runs — B2 shows the run sits at 92% of its ceiling, but the cost of the');
console.log('INFO   check itself is 45 ms (v13-transport-suite-cost.mjs), so running it after all 23 requests');
console.log('INFO   costs ~1 s against 90 s of headroom. The objection was an assumption, not a measurement.');
console.log('INFO The pilot has since SETTLED it (C1): 595,419 -> 288,942 tokens, -51.5%, correctness intact,');
console.log('INFO and wall clock 13.50 -> 6.94 min (92% -> 46% of the ceiling). Still above the 75% target in');
console.log('INFO aggregate (82.1%), and what remains is the worker\'s own OUTPUT (2.9x plain), not its round trips.');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 transport feedback — the worker is never told a verdict, and nothing claims otherwise`);
process.exit(failures === 0 ? 0 : 1);
