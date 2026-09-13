/**
 * REQUIREMENT COVERAGE — every authorized requirement is proven or NOT PROVEN.
 *
 * The invariant, in the owner's words: *Every objective requirement must have a frozen proof
 * obligation or remain NOT PROVEN. Subjective requirements require explicit human acceptance.*
 *
 * These are PURE unit tests of the obligation engine (`obligationsFor`), because that is where the
 * decision lives: no CLI run, no git, no filesystem. The end-to-end behaviour (doctor's verdict, the
 * Stop hook's block) is proven by `tooling/probes/requirement-coverage-gate.mjs`.
 *
 * MEASURED gap these pin: the binding map (`package.json` `canary.proofs`) accepted any
 * requirement digest, but the obligation engine only credited digests that happened to be numeric
 * objective targets — so a plain stated requirement could never be covered by measurement, and the
 * only reachable end state was human acceptance.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { declaredTask, materialDigest, type TaskKind } from '../src/authorization.js';
import { obligationsFor, type DiffSignals, type Obligation } from '../src/onboarding.js';

/** No change at all — the obligation engine is what is under test, not attribution. */
const NO_CHANGE: DiffSignals = {
  resolved: true, touched: [], changes: [], deletedTestsAttributable: [], deletedTestsUnattributable: [],
  setupDirtProven: false, depTouched: false,
};

const plan = [{ kind: 'tests' as const, script: 'test' }];
const authorityWith = (proofBindings?: Record<string, string>) => ({
  plan,
  planAuthority: {
    at: new Date().toISOString(), planDigest: 'a'.repeat(64),
    scriptDigests: { test: 'b'.repeat(64) },
    ...(proofBindings === undefined ? {} : { proofBindings }),
  },
});

const find = (obs: Obligation[], id: string) => obs.find((o) => o.id === id);

test('a registered requirement with NO sealed proof is UNPROVEN and names the way to bind it', () => {
  const req = 'the greeting trims leading and trailing whitespace';
  const task = declaredTask('add a trimming greeting', [] as TaskKind[], [req]);
  const obs = obligationsFor([], NO_CHANGE, new Set(['tests']), 1, 'setup', task, authorityWith());
  const per = find(obs, 'per-requirement');
  assert.ok(per, 'a registered requirement must produce the per-requirement duty');
  assert.equal(per.status, 'unproven');
  // v1.2: OBJECTIVE, not acceptance-eligible. The duty used to be `non-objective` while its own
  // note said "acceptance cannot replace measurement for an objective requirement" — so a TTY
  // signature could close a requirement nobody had measured, and the Stop hook sent the worker down
  // its operator-only branch ("none of them is yours to close"), which is what produced the
  // measured 1.5-1.85M-token loops. A declared requirement is a requirement.
  assert.equal(per.mode, 'objective', 'an unmeasured requirement is a MEASUREMENT duty, not a signature');
  assert.match(per.note, /NO sealed proof/);
  assert.match(per.note, /canary\.proofs/, 'the note must name the binding mechanism');
});

test('a SUBJECTIVE registration keeps the human-acceptance path (it is not a measurement duty)', () => {
  // The other half of the rule above, and the reason it is not a blanket reclassification: when
  // the registration itself carries a subjective marker, acceptance IS the honest closure, so the
  // duty stays non-objective and can be closed by `canary accept`.
  const task = declaredTask('make the dialog prettier', ['ui'] as TaskKind[], ['the dialog looks nicer']);
  const obs = obligationsFor(['ui'], NO_CHANGE, new Set(['tests']), 1, 'setup', task, authorityWith());
  const per = find(obs, 'per-requirement');
  assert.ok(per);
  assert.equal(per.mode, 'non-objective', 'a subjective registration is closed by human judgment');
  assert.match(per.note, /canary accept/);
});

test('binding that digest to a sealed script makes the requirement COVERED by measurement', () => {
  const req = 'the greeting trims leading and trailing whitespace';
  const task = declaredTask('add a trimming greeting', [] as TaskKind[], [req]);
  const bound = { [materialDigest(req)]: 'test' };
  const obs = obligationsFor([], NO_CHANGE, new Set(['tests']), 1, 'setup', task, authorityWith(bound));
  const per = find(obs, 'per-requirement');
  assert.ok(per);
  assert.equal(per.status, 'met', 'a requirement bound to a sealed script is proven by that script');
  assert.equal(per.mode, 'objective', 'measurement, not acceptance, closed it');
  assert.match(per.note, /sealed proof script/);
  assert.match(per.note, /test/);
});

test('a binding to a script the plan does NOT run is worth nothing (fail closed)', () => {
  const req = 'the greeting trims leading and trailing whitespace';
  const task = declaredTask('add a trimming greeting', [] as TaskKind[], [req]);
  const obs = obligationsFor([], NO_CHANGE, new Set(['tests']), 1, 'setup', task, authorityWith({ [materialDigest(req)]: 'lint-everything' }));
  const per = find(obs, 'per-requirement');
  assert.equal(per?.status, 'unproven', 'an unsealed/unknown script cannot cover a requirement');
});

test('one covered and one uncovered requirement stays UNPROVEN, and says how many are uncovered', () => {
  const covered = 'the greeting trims whitespace';
  const uncovered = 'an empty name still produces the word hello';
  const task = declaredTask('add a trimming greeting', [] as TaskKind[], [covered, uncovered]);
  const obs = obligationsFor([], NO_CHANGE, new Set(['tests']), 2, 'setup', task, authorityWith({ [materialDigest(covered)]: 'test' }));
  const per = find(obs, 'per-requirement');
  assert.equal(per?.status, 'unproven', 'partial coverage is not coverage');
  assert.match(String(per?.note), /2 registered requirement\(s\), 1 with NO sealed proof/);
});

test('no registered requirements, no multi-part kind: no duty is invented', () => {
  const obs = obligationsFor([], NO_CHANGE, new Set(['tests']), 0, 'setup', null, authorityWith());
  assert.equal(find(obs, 'per-requirement'), undefined);
});

test('a numeric requirement is a frozen objective target — and its own binding rule applies', () => {
  const req = 'a benchmark under 200 ms for 10k rows';
  const task = declaredTask('speed up the aggregator', [] as TaskKind[], [req]);
  assert.ok(task.objectiveTargets.some((t) => t.digest === materialDigest(req)), 'the numeric requirement must be a frozen target');
  // The TARGET duty still needs a sealed bench binding …
  const unbound = obligationsFor([], NO_CHANGE, new Set(['tests']), 1, 'setup', task, authorityWith());
  assert.equal(find(unbound, `target-bench-${materialDigest(req)}`)?.status, 'unproven', 'the target needs its own sealed proof');
  // … while the per-requirement duty is MET, because a frozen target IS a frozen proof obligation.
  assert.equal(find(unbound, 'per-requirement')?.status, 'met', 'a frozen target already covers the requirement');
});
