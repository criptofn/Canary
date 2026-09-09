/**
 * M10 contract tests — directive §11 (trusted intent) under the fake-git
 * posture, plus the §10 candidate-diff signal unit on real git.
 *
 * The intent guard runs BEFORE candidate identity, so fake git reaches the
 * whole guard: a candidate frozen against a stronger authority than the one
 * now on disk (dropped step, re-sealed text, vanished seal, shrunk task) is
 * refused with a zero-step blocked bundle carrying intentEvent — exit 2, no
 * quarantine stamp (the snapshot is grudgeless: frozen at record-write, and
 * the record itself is inside M9's fingerprint set, so there is no laundering
 * vector to close). Increases always sail through. Gate order is pinned:
 * quarantine / impersonation / malformed-record refusals outrank the guard,
 * and a malformed intent makes the RECORD invalid (a guard that cannot read
 * the snapshot is worse than no snapshot). Legacy intent-less records verify
 * exactly as before (additive).
 *
 * What fake git cannot reach — the verdict ladder (fail/blocked/unproven/pass
 * over a real candidate diff) — is proven by tooling/probes/m10-obligations.mjs
 * on real git. Here the candidateDiffSignals unit runs against real git
 * directly: attribution of committed test deletions and renames-out, and the
 * fail-safe to UNATTRIBUTABLE (never a false `met`) when the baseHead probe
 * cannot answer.
 *
 * M10.1 (GLM F4) adds a real-git CLI law table: F4-A..G pin the task-obligation
 * AUTHORITY on this product surface — zero registered kinds is NOT PROVEN,
 * never PASS; promotion locked; an honest registration still reaches PASS and
 * ACCEPTED; the gate cannot be opened by env var or flag; precedence stays
 * fail > unmet > unproven > pass.
 * NO PROOF, NO DONE.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { candidateDiffSignals, obligationsFor } from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m10-'));
const canary = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
const fx = (f: string) => `node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', f)}"`;

function setUpProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // FAKE git
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: fx('f-pass.js') } }, null, 2));
  const r = canary(['setup', '--yes', root], root);
  assert.equal(r.status, 0, `setup failed: ${r.stdout}${r.stderr}`);
  return root;
}
const cfgOf = (root: string) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
const recPath = (root: string, name: string) => path.join(root, '.canary', 'candidates', `${name}.json`);
const taskPath = (root: string) => path.join(root, '.canary', 'task', 'current.json');
const writeTask = (root: string, kinds: string[], requirementCount: number) => {
  fs.mkdirSync(path.dirname(taskPath(root)), { recursive: true });
  fs.writeFileSync(taskPath(root), JSON.stringify({ kinds, requirementCount }));
};
const QUARANTINE = path.join('.canary', 'authority-quarantine.json');

/** A valid-shape record whose candidate root cannot resolve under fake git —
 *  exactly m9's LOST posture — with a hand-frozen intent. */
function registerWithIntent(root: string, intent: Record<string, unknown>, name = 'p'): void {
  fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
  fs.writeFileSync(recPath(root, name), JSON.stringify({
    schema: 'canary-candidate/1', name, root: path.join(root, '.canary', 'candidates', 'p'),
    baseRoot: root, baseRef: 'HEAD', baseHead: 'b'.repeat(40), baseTree: null,
    createdAt: new Date().toISOString(), intent,
  }));
}
/** intent matching the current authority exactly — the silent baseline. */
function matchedIntent(root: string): { at: string; plan: { kind: string; script: string }[]; seal: Record<string, string> | null; task: { kinds: string[]; requirementCount: number } | null } {
  const cfg = cfgOf(root);
  return {
    at: new Date().toISOString(),
    plan: cfg.plan.map((s: { kind: string; script: string }) => ({ kind: s.kind, script: s.script })),
    seal: cfg.planAuthority ? { ...cfg.planAuthority.scriptDigests } : null,
    task: null,
  };
};
const candBundles = (root: string) => {
  const d = path.join(root, '.canary', 'evidence');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => x.endsWith('-candidate')).sort()
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')) as Record<string, unknown>);
};
const weakenedRe = /the verification intent was weakened after isolation/;
const identityRe = /not a resolvable git tree/;

function expectIntentBlock(root: string, eventRe: RegExp) {
  const r = canary(['isolate', '--verify', 'p', root], root);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, weakenedRe, 'the guard names the weakening');
  assert.match(r.stdout, eventRe, 'the guard names the specific event');
  assert.match(r.stdout, /legitimate revision is a HUMAN act/, 'recovery is a human act, not a re-run');
  assert.ok(!identityRe.test(r.stdout), 'the guard fires BEFORE identity — nothing ran, nothing was probed');
  assert.ok(!/CANARY BLOCKED COMPLETION|QUARANTIN/.test(r.stdout), 'an intent block is not a §9 mandate');
  assert.ok(!fs.existsSync(path.join(root, QUARANTINE)), 'grudgeless: no quarantine stamp — restore is the recovery');
  const b = candBundles(root).at(-1)!;
  assert.equal(b.status, 'blocked', 'the refusal is evidenced as blocked');
  assert.deepEqual(b.steps, [], 'an intent block runs zero steps');
  assert.equal(b.source, 'candidate');
  assert.equal(b.trustClass, 'CANARY_OBSERVED', 'M3 class intact');
  assert.equal(b.authorityEvent, undefined, 'an intent block carries no authorityEvent');
  const ev = b.intentEvent as { snapshotAt: string; events: string[] };
  assert(ev && typeof ev.snapshotAt === 'string', 'intentEvent carries the snapshot time');
  assert(ev.events.some((e) => eventRe.test(e)), `intentEvent names the event: ${JSON.stringify(ev.events)}`);
  return { r, b, ev };
}

try {
  test('intent matching the live authority stays SILENT (the guard must not shout at innocence)', () => {
    const root = setUpProject('match');
    registerWithIntent(root, matchedIntent(root));
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, identityRe, 'verify sails to the ordinary LOST block');
    assert.ok(!weakenedRe.test(r.stdout), 'a held intent is never a complaint');
    assert.equal(candBundles(root).at(-1)!.intentEvent, undefined, 'no intentEvent on a non-intent block');
  });

  test('legacy record with no intent field verifies exactly as before (additive)', () => {
    const root = setUpProject('legacy');
    fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
    fs.writeFileSync(recPath(root, 'p'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'p', root: path.join(root, '.canary', 'candidates', 'p'),
      baseRoot: root, baseRef: 'HEAD', baseHead: 'b'.repeat(40), baseTree: null,
      createdAt: new Date().toISOString(),
    }));
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, identityRe, 'pre-M10 records ride the pre-M10 path');
    assert.ok(!weakenedRe.test(r.stdout), 'no intent, no guard, no noise');
  });

  test('dropped plan step since isolation → intent block before identity', () => {
    const root = setUpProject('dropstep');
    const intent = matchedIntent(root);
    intent.plan.push({ kind: 'e2e', script: 'e2e' }); // the candidate was opened WITH an e2e step
    registerWithIntent(root, intent);
    expectIntentBlock(root, /verification step "e2e" present at isolation is no longer in the plan/);
  });

  test('re-sealed script text (digest differs) → intent block', () => {
    const root = setUpProject('reseal');
    const intent = matchedIntent(root);
    const script = intent.plan[0]!.script;
    intent.seal![script] = 'f'.repeat(64); // the same step, re-sealed to different text
    registerWithIntent(root, intent);
    expectIntentBlock(root, new RegExp(`the sealed text of "${script}" changed since isolation`));
  });

  test('seal vanished (authority re-created without one) → intent block', () => {
    const root = setUpProject('sealgone');
    registerWithIntent(root, matchedIntent(root));
    const cfgP = path.join(root, '.canary', 'canary.local.json');
    const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    delete cfg.planAuthority;
    fs.writeFileSync(cfgP, JSON.stringify(cfg));
    expectIntentBlock(root, /have no seal in the current config/);
  });

  test('task kind registered at isolation gone now → intent block', () => {
    const root = setUpProject('kinds');
    const intent = matchedIntent(root);
    intent.task = { kinds: ['bugfix', 'refactor'], requirementCount: 0 };
    registerWithIntent(root, intent);
    writeTask(root, ['refactor'], 0); // bugfix silently dropped from the task record
    expectIntentBlock(root, /task kind "bugfix" registered at isolation is gone from the task record/);
  });

  test('registered requirements shrink → intent block', () => {
    const root = setUpProject('reqs');
    const intent = matchedIntent(root);
    intent.task = { kinds: [], requirementCount: 3 };
    registerWithIntent(root, intent);
    writeTask(root, [], 1); // two requirements quietly deleted
    expectIntentBlock(root, /registered requirements shrank 3 → 1/);
  });

  test('INCREASES are allowed: richer plan + richer task sail past the guard', () => {
    const root = setUpProject('increase');
    registerWithIntent(root, matchedIntent(root)); // intent = the old, weaker authority
    const cfgP = path.join(root, '.canary', 'canary.local.json');
    const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    cfg.plan.push({ kind: 'e2e', script: 'e2e' }); // the human grew the plan
    fs.writeFileSync(cfgP, JSON.stringify(cfg));
    writeTask(root, ['bugfix'], 2); // the task grew too
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, identityRe, 'a growing authority is not a weakening — verify sails on');
    assert.ok(!weakenedRe.test(r.stdout));
    assert.equal(candBundles(root).length, 1, 'exactly the identity block, no intent refusal');
    assert.equal(candBundles(root).at(-1)!.intentEvent, undefined);
  });

  test('restore = recovery: re-adding the dropped step clears the block, still grudgeless', () => {
    const root = setUpProject('restore');
    const intent = matchedIntent(root);
    intent.plan.push({ kind: 'e2e', script: 'e2e' });
    registerWithIntent(root, intent);
    const cfgP = path.join(root, '.canary', 'canary.local.json');
    const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    fs.writeFileSync(cfgP, JSON.stringify({ ...cfg, plan: cfg.plan.filter((s: { script: string }) => s.script !== 'test') }));
    // plan now lacks what the intent froze (and nothing was ever added back)
    expectIntentBlock(root, /is no longer in the plan/);
    fs.writeFileSync(cfgP, JSON.stringify({ ...cfg, plan: [...cfg.plan, { kind: 'e2e', script: 'e2e' }] }));
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.match(r.stdout, identityRe, 'the human restored the promised authority — verify judges again');
    assert.ok(!weakenedRe.test(r.stdout));
    assert.ok(!fs.existsSync(path.join(root, QUARANTINE)), 'and the block left no residue behind');
  });

  test('malformed intent fields make the RECORD invalid (a guard cannot read a snapshot it will not parse)', () => {
    const root = setUpProject('malformed');
    const cfgP = path.join(root, '.canary', 'canary.local.json');
    void cfgP;
    for (const [name, bad] of [
      ['plan-string', { at: new Date().toISOString(), plan: 'not-an-array', seal: null, task: null }],
      ['seal-not-hex', { ...matchedIntent(root), seal: { test: 'nope' } }],
      ['task-float', { ...matchedIntent(root), task: { kinds: [], requirementCount: 1.5 } }],
    ] as const) {
      registerWithIntent(root, bad as unknown as Record<string, unknown>, 'p');
      const r = canary(['isolate', '--verify', 'p', root], root);
      assert.equal(r.status, 2, `${name}: ${r.stdout}`);
      assert.match(r.stdout, /malformed/, `${name}: refused as a malformed record`);
      assert.ok(!weakenedRe.test(r.stdout), `${name}: an unparsable snapshot is never judged as a weakening`);
      fs.rmSync(recPath(root, 'p'));
    }
    assert.equal(candBundles(root).length, 0, 'record refusals write no bundle');
  });

  test('gate order: quarantine refusal and impersonation outrank the intent guard', () => {
    const root = setUpProject('order');
    const intent = matchedIntent(root);
    intent.plan.push({ kind: 'e2e', script: 'e2e' }); // would block, if it were ever reached
    registerWithIntent(root, intent);
    fs.writeFileSync(path.join(root, QUARANTINE), JSON.stringify({ schema: 'canary-authority-quarantine/1', at: 'x', when: 'during execution', changes: [] }));
    let r = canary(['isolate', '--verify', 'p', root], root);
    assert.match(r.stdout, /CANARY QUARANTINED/, 'the marker refuses the base before any intent talk');
    assert.ok(!weakenedRe.test(r.stdout));
    assert.equal(candBundles(root).length, 0, 'a refusal-before-judging writes no bundle');
    fs.rmSync(path.join(root, QUARANTINE));

    fs.writeFileSync(recPath(root, 'p'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'p', root: path.join(TMP, 'elsewhere'),
      baseRoot: path.join(TMP, 'elsewhere'), baseRef: 'HEAD', baseHead: 'f'.repeat(40),
      baseTree: null, createdAt: new Date().toISOString(), intent,
    }));
    r = canary(['isolate', '--verify', 'p', root], root);
    assert.match(r.stdout, /different base/, 'the impersonation guard answers first');
    assert.ok(!weakenedRe.test(r.stdout), 'a record aimed at another base is refused, not attributed');
  });

  // ---- real-git unit: candidateDiffSignals (the §10 attribution engine) ----
  function realRepo(name: string, files: Record<string, string>): { root: string; base: string } {
    const root = path.join(TMP, name);
    fs.mkdirSync(root, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), c);
    }
    const g = (...args: string[]) => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g('init', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    g('add', '-A'); g('commit', '-m', 'base');
    return { root, base: g('rev-parse', 'HEAD') };
  }
  const commit = (root: string, msg: string) => {
    const g = (...args: string[]) => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g('add', '-A'); g('commit', '-m', msg);
  };

  test('committed test deletion in the candidate diff is ATTRIBUTABLE (the worktree began provably clean)', () => {
    const { root, base } = realRepo('cand-del', { 'tests/bug.test.js': 'test();\n', 'src/a.js': '1\n', 'package.json': '{}' });
    fs.rmSync(path.join(root, 'tests', 'bug.test.js'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), '2\n');
    commit(root, 'candidate: fix, delete the annoying test');
    const sig = candidateDiffSignals(root, base);
    assert.equal(sig.resolved, true);
    assert.deepEqual(sig.deletedTestsAttributable, ['tests/bug.test.js'], 'the deletion is the candidate\'s');
    assert.deepEqual(sig.deletedTestsUnattributable, [], 'no residue when attribution holds');
    assert.ok(sig.changes.includes('src/a.js'));
    assert.ok(!sig.changes.includes('tests/bug.test.js'), 'a vanished test is never regression EVIDENCE');
    const ob = obligationsFor(['bugfix'], sig, new Set(['tests']), 0);
    assert.equal(ob.find((x) => x.id === 'coverage-loss')!.status, 'unmet', 'the ladder gets an objectively-violated obligation');
  });

  test('renaming a test OUT of test paths counts as attributable coverage loss', () => {
    const { root, base } = realRepo('cand-rename', { 'tests/r.test.js': 'test();\n', 'src/keep.js': 'k\n' });
    const mv = spawnSync('git', ['-C', root, 'mv', 'tests/r.test.js', 'src/renamed.js'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(mv.status, 0, mv.stderr);
    commit(root, 'candidate: relocate the test somewhere Canary cannot see it');
    const sig = candidateDiffSignals(root, base);
    assert.deepEqual(sig.deletedTestsAttributable, ['tests/r.test.js'], 'rename-out deletes the test path');
    assert.ok(sig.changes.includes('src/renamed.js'), 'the new side counts as a change, not as coverage');
  });

  test('the suffix-surviving escape: tests/x.test.js → src/x.test.js is STILL coverage loss (adversary F3)', () => {
    const { root, base } = realRepo('cand-rename2', { 'tests/s.test.js': 'test();\n', 'src/keep.js': 'k\n' });
    const mv = spawnSync('git', ['-C', root, 'mv', 'tests/s.test.js', 'src/s.test.js'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(mv.status, 0, mv.stderr);
    commit(root, 'candidate: keep the .test.js suffix, leave the runner\'s directory scope');
    const sig = candidateDiffSignals(root, base);
    assert.deepEqual(sig.deletedTestsAttributable, ['tests/s.test.js'],
      'a move out of the test DIRECTORY counts even when the suffix survives — most runners include by directory');
    const ob = obligationsFor([], sig, new Set(['tests']), 0);
    assert.equal(ob.find((x) => x.id === 'coverage-loss')!.status, 'unmet');
  });

  test('the directory rule does not shout at innocence: suffix-only moves and in-dir moves stay intact', () => {
    // suffix-only repo: the runner's scope is unknowable, a src-internal move must NOT be flagged
    const { root, base } = realRepo('cand-rename3', { 'src/a.test.js': 't\n', 'src/keep.js': 'k\n' });
    fs.mkdirSync(path.join(root, 'src', 'moved'), { recursive: true });
    const mv = spawnSync('git', ['-C', root, 'mv', 'src/a.test.js', 'src/moved/a.test.js'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(mv.status, 0, mv.stderr);
    commit(root, 'candidate: pure reorganization inside src');
    const sig = candidateDiffSignals(root, base);
    assert.deepEqual(sig.deletedTestsAttributable, [], 'old side never had directory shape — nothing to lose');
    // in-dir move stays intact too
    const r2 = realRepo('cand-rename4', { 'tests/deep/x.test.js': 't\n' });
    fs.mkdirSync(path.join(r2.root, 'tests', 'deeper'), { recursive: true });
    const mv2 = spawnSync('git', ['-C', r2.root, 'mv', 'tests/deep/x.test.js', 'tests/deeper/x.test.js'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(mv2.status, 0, mv2.stderr);
    commit(r2.root, 'candidate: rename within the test tree');
    assert.deepEqual(candidateDiffSignals(r2.root, r2.base).deletedTestsAttributable, [], 'directory shape preserved');
  });

  test('the isolation premise names what the candidate boundary can NOT prove (correctness #5): never "setup"', () => {
    const { root } = realRepo('cand-word', { 'tests/w.test.js': 't\n', 'src/a.js': '1\n' });
    fs.rmSync(path.join(root, 'tests', 'w.test.js'));
    const sig = candidateDiffSignals(root, 'b'.repeat(40)); // probe unanswerable → deletions residue-only
    assert.equal(sig.deletedTestsUnattributable.length, 1);
    const iso = obligationsFor([], sig, new Set(['tests']), 0, 'isolation');
    const note = iso.find((x) => x.id === 'coverage-loss-unattributable')!.note;
    assert.match(note, /candidate-vs-isolation-base committed diff cannot be resolved/, 'the true candidate failure mode');
    assert.ok(!/at setup/.test(note), 'setup is not the candidate boundary\'s premise');
    const def = obligationsFor([], sig, new Set(['tests']), 0);
    assert.match(def.find((x) => x.id === 'coverage-loss-unattributable')!.note, /at setup/, 'checkpoint default text unchanged (m6 pins)');
    const bug = obligationsFor(['bugfix'], sig, new Set(), 0, 'isolation');
    assert.match(bug.find((x) => x.id === 'regression-evidence')!.note, /since isolation/, 'regression note speaks of the right baseline');
    assert.match(obligationsFor(['bugfix'], sig, new Set(), 0).find((x) => x.id === 'regression-evidence')!.note, /since setup/, 'default unchanged');
  });

  test('an unanswerable baseHead probe fails SAFE: deletions UNATTRIBUTABLE, never a false met', () => {
    const { root } = realRepo('cand-unres', { 'tests/bug.test.js': 'test();\n', 'src/a.js': '1\n' });
    fs.rmSync(path.join(root, 'tests', 'bug.test.js')); // unstaged worktree deletion
    const ghost = 'a'.repeat(40); // hex-shaped but NOT an object in this repo
    const sig = candidateDiffSignals(root, ghost);
    assert.equal(sig.resolved, false, 'the candidate-vs-base story is unknowable here');
    assert.deepEqual(sig.deletedTestsAttributable, [], 'no attribution claim without the committed probe');
    assert.deepEqual(sig.deletedTestsUnattributable, ['tests/bug.test.js'], 'it surfaces as UNPROVEN material instead');
    const ob = obligationsFor(['refactor'], sig, new Set(['tests']), 0);
    assert.ok(ob.some((x) => x.status === 'unproven'), 'fail-safe lands UNPROVEN, never met');
  });

  test('added test file: changes carries it, deletions stay empty (regression evidence, not loss)', () => {
    const { root, base } = realRepo('cand-add', { 'src/a.js': '1\n' });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'new.test.js'), 'test the fix\n');
    commit(root, 'candidate: real regression test');
    const sig = candidateDiffSignals(root, base);
    assert.ok(sig.changes.includes('tests/new.test.js'));
    assert.deepEqual(sig.deletedTestsAttributable, []);
    const ob = obligationsFor(['bugfix'], sig, new Set(['tests']), 0);
    assert.equal(ob.find((x) => x.id === 'regression-evidence')!.status, 'met');
    assert.equal(ob.find((x) => x.id === 'tests-green')!.status, 'met', 'the sealed plan ran a tests step green — the engine says met');
  });

  // ================= M10.1 (GLM F4): the task-obligation authority =========
  // The audit's strongest agent move was to register NOTHING: the ladder
  // derived its duties from registered kinds, so a taskless candidate derived
  // zero obligations and a green sealed plan was the whole verdict. The law
  // table F4-A..G, on real git through the product CLI (the end-to-end story
  // incl. promotion is owned by tooling/probes/m10-f4-bypass-repro.mjs and
  // S12 of the M10 probe):
  //   A no task + green plan → NOT PROVEN, authority named as [task-authority]
  //   B promotion locked: gate 1 refuses, zero promotion bundles, base unmoved
  //   C registered task with MET obligations still reaches PASS and ACCEPTED
  //   D registered-but-wrong duty still costs (bugfix without a test)
  //   E an objective violation still BLOCKS — unmet outranks the new unproven
  //   F no knob: an env var or flag cannot restore what registration must give
  //   G precedence stays fail > unmet > unproven > pass with the gate in play
  function gitAt(dir: string, ...args: string[]): string {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
    return r.stdout.trim();
  }
  function f4Repo(name: string): string {
    const root = path.join(TMP, name);
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    // 'test' (green at setup; red once the candidate commits red.flag) seals
    // as plan kind 'tests' — the ladder floor is a REAL green plan.
    fs.writeFileSync(path.join(root, 'check.cjs'), "const fs = require('node:fs');\nprocess.exit(fs.existsSync('red.flag') ? 1 : 0);\n");
    fs.writeFileSync(path.join(root, 'tests', 'keep.test.js'), 'test();\n');
    fs.writeFileSync(path.join(root, 'src', 'a.js'), '1\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
      { name, private: true, scripts: { test: 'node check.cjs' } }, null, 2));
    gitAt(root, 'init', '-b', 'main'); gitAt(root, 'config', 'user.email', 't@t'); gitAt(root, 'config', 'user.name', 't');
    gitAt(root, 'add', '-A'); gitAt(root, 'commit', '-m', 'base');
    const s = canary(['setup', '--yes', root], root);
    assert.equal(s.status, 0, `setup failed: ${s.stdout}${s.stderr}`);
    return root;
  }
  function f4Candidate(root: string, mutate: (c: string) => void): string {
    const name = 'f1';
    const i = canary(['isolate', name, root], root);
    assert.equal(i.status, 0, `isolate failed: ${i.stdout}${i.stderr}`);
    const c = path.join(root, '.canary', 'candidates', name);
    mutate(c);
    gitAt(c, 'add', '-A'); gitAt(c, 'commit', '-m', 'candidate work');
    return name;
  }
  const f4Verify = (root: string) => canary(['isolate', '--verify', 'f1', root], root);
  const f4Promote = (root: string) => canary(['isolate', '--promote', 'f1', root], root);
  const f4Task = (root: string, ...args: string[]) => {
    const t = canary(['task', ...args], root);
    assert.equal(t.status, 0, `task failed: ${t.stdout}${t.stderr}`);
  };
  const f4Bundle = (root: string) => candBundles(root).at(-1)!;
  const f4Obs = (b: Record<string, unknown>) => (b.obligations ?? []) as { id: string; mode: string; status: string; note: string }[];
  const promBundles = (root: string) => {
    const d = path.join(root, '.canary', 'evidence');
    return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-promotion')) : [];
  };

  test('F4-A: no registered task + green sealed plan → CANDIDATE NOT PROVEN, never PASS; the missing authority is named', () => {
    const root = f4Repo('f4-a');
    f4Candidate(root, (c) => fs.writeFileSync(path.join(c, 'src', 'tweak.js'), 'behavior-preserving\n'));
    const r = f4Verify(root);
    assert.equal(r.status, 2, `taskless must not exit 0:\n${r.stdout}`);
    assert.match(r.stdout, /CANDIDATE NOT PROVEN/, 'the verdict is NOT PROVEN');
    assert.ok(!/CANDIDATE PASS|ELIGIBLE for promotion/.test(r.stdout), 'no PASS, no eligibility wording');
    assert.match(r.stdout, /obligation \[task-authority\] UNPROVEN \(objective\)/, 'the authority duty is named');
    assert.match(r.stdout, /canary task/, 'the note points at the honest path — register the work');
    const b = f4Bundle(root);
    assert.equal(b.status, 'unproven', 'honest unproven bundle');
    const ta = f4Obs(b).find((x) => x.id === 'task-authority');
    assert.ok(ta && ta.status === 'unproven' && ta.mode === 'objective', 'bundle carries the authority obligation');
    assert.match(ta.note, /canary task/, 'the recovery path is in the bundle bytes');
    const steps = b.steps as { ok: boolean }[];
    assert.equal(steps.length, 1, 'the green executed step still rides the bundle');
    assert.ok(steps[0]!.ok, 'the step was green — what failed is the AUTHORITY, not the plan');
  });

  test('F4-B: promotion of a taskless candidate is locked — gate 1 refuses, zero promotion bundles, base unmoved', () => {
    const root = f4Repo('f4-b');
    f4Candidate(root, (c) => fs.writeFileSync(path.join(c, 'src', 'tweak.js'), 'behavior-preserving\n'));
    assert.equal(f4Verify(root).status, 2, 'precondition: verify refuses');
    const headBefore = gitAt(root, 'rev-parse', 'HEAD');
    const p = f4Promote(root);
    assert.equal(p.status, 2, `promote must ride the NOT PROVEN verdict:\n${p.stdout}`);
    assert.ok(!/PROMOTED|ALREADY APPLIED|ACCEPTED/.test(p.stdout), 'no apply wording, ever');
    assert.deepEqual(promBundles(root), [], 'a gate-1 refusal is not an act — zero promotion bundles');
    assert.equal(gitAt(root, 'rev-parse', 'HEAD'), headBefore, 'the trusted base did not move');
  });

  test('F4-C: a registered task whose obligations are all MET still reaches PASS and ACCEPTED promotion (the gate must not shout at innocence)', () => {
    const root = f4Repo('f4-c');
    f4Task(root, 'behavior-preserving restructure', '--kind', 'refactor');
    f4Candidate(root, (c) => fs.writeFileSync(path.join(c, 'src', 'tweak.js'), 'behavior-preserving\n'));
    const r = f4Verify(root);
    assert.equal(r.status, 0, `honest registration must PASS:\n${r.stdout}`);
    assert.match(r.stdout, /CANDIDATE PASS/, 'PASS verdict');
    assert.ok(!/task-authority/.test(r.stdout), 'a registered candidate never hears the authority gate');
    const p = f4Promote(root);
    assert.equal(p.status, 0, `promote must apply a proven candidate:\n${p.stdout}`);
    assert.match(p.stdout, /ACCEPTED/, 'the act is evidenced');
    assert.equal(f4Bundle(root).status, 'pass', 'pass bundle');
  });

  test('F4-D: registration is not a mask — a bugfix without regression evidence stays NOT PROVEN on its real duty, authority gate silent', () => {
    const root = f4Repo('f4-d');
    f4Task(root, 'fix the crash', '--kind', 'bugfix');
    f4Candidate(root, (c) => fs.writeFileSync(path.join(c, 'src', 'fix.js'), 'no test added\n'));
    const r = f4Verify(root);
    assert.equal(r.status, 2, `bugfix without a test must not PASS:\n${r.stdout}`);
    assert.match(r.stdout, /CANDIDATE NOT PROVEN/, 'NOT PROVEN verdict');
    assert.match(r.stdout, /obligation \[regression-evidence\] UNPROVEN/, 'named on its actual duty');
    assert.ok(!/task-authority/.test(r.stdout), 'with kinds registered the authority gate stands down');
    assert.ok(!f4Obs(f4Bundle(root)).some((x) => x.id === 'task-authority'), 'and it is absent from the bundle too');
  });

  test('F4-E: an objective violation still BLOCKS while taskless — unmet outranks the new unproven duty', () => {
    const root = f4Repo('f4-e');
    f4Candidate(root, (c) => {
      fs.rmSync(path.join(c, 'tests', 'keep.test.js'));
      fs.writeFileSync(path.join(c, 'src', 'a.js'), '2\n');
    });
    const r = f4Verify(root);
    assert.equal(r.status, 2, `violated coverage must block:\n${r.stdout}`);
    assert.match(r.stdout, /CANDIDATE BLOCKED — the sealed/, 'BLOCKED, not NOT PROVEN — the violation outranks the missing authority');
    assert.match(r.stdout, /obligation \[coverage-loss\] UNMET/, 'the violation is named');
    const obs = f4Obs(f4Bundle(root));
    assert.equal(obs.find((x) => x.id === 'coverage-loss')!.status, 'unmet', 'violation rides the bundle');
    assert.ok(obs.some((x) => x.id === 'task-authority' && x.status === 'unproven'), 'the authority duty rides too — visible, but not deciding');
  });

  test('F4-F: no knob opens it — an env var and an unknown flag cannot restore the authority that registration must give', () => {
    const root = f4Repo('f4-f');
    f4Candidate(root, (c) => fs.writeFileSync(path.join(c, 'src', 'tweak.js'), 'behavior-preserving\n'));
    const withEnv = spawnSync(process.execPath,
      [CLI, 'isolate', '--verify', 'f1', root],
      { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, CANARY_NO_TASK_OK: '1', CANARY_SKIP_TASK_AUTHORITY: '1' } });
    assert.equal(withEnv.status, 2, `an env var must be inert:\n${withEnv.stdout}`);
    assert.match(withEnv.stdout, /CANDIDATE NOT PROVEN/, 'and the verdict is unchanged');
    const withFlag = canary(['isolate', '--verify', 'f1', root, '--no-task-ok'], root);
    assert.notEqual(withFlag.status, 0, 'an invented flag cannot reach PASS either');
    assert.ok(!/CANDIDATE PASS|ELIGIBLE for promotion/.test(withFlag.stdout), 'no PASS through any knob');
  });

  test('F4-G: precedence holds with the gate in play — fail > unmet > unproven(taskless) > pass', () => {
    // fail beats everything: red plan while an unmet violation also stands
    const red = f4Repo('f4-g-red');
    f4Task(red, 'restructure', '--kind', 'refactor');
    f4Candidate(red, (c) => {
      fs.writeFileSync(path.join(c, 'red.flag'), 'red\n');
      fs.rmSync(path.join(c, 'tests', 'keep.test.js'));
    });
    const rf = f4Verify(red);
    assert.equal(rf.status, 2, `red plan:\n${rf.stdout}`);
    assert.match(rf.stdout, /CANDIDATE FAIL/, 'FAIL outranks the violation read');
    const obR = f4Obs(f4Bundle(red));
    assert.equal(obR.find((x) => x.id === 'coverage-loss')!.status, 'unmet', 'the violation still rides the FAIL bundle (M11 fuel)');
    // unmet beats unproven is F4-E; unproven beats pass is F4-A; pass needs a
    // registered met candidate (F4-C) — the full chain is pinned leg by leg.
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
