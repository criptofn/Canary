#!/usr/bin/env node
/**
 * M10.2 adversarial battery — the FROZEN task-authority law A..L, run end to
 * end against the REAL product CLI on REAL git. The GLM re-audit of M10.1
 * confirmed two HIGH bypasses; this probe owns their closure plus every
 * neighbouring agent move:
 *
 *   F4-GATE-1  a taskless candidate registers a task AFTER isolation and the
 *              M10.1 gate read that live byte as authority → PASS → promoted.
 *   F4-GATE-2  deleting `rec.intent` from the agent-writable record made the
 *              gate conditional on the field it trusted → legacy-PASS bypass.
 *
 * The law here (candidate.ts, M10.2): task-authority is discharged ONLY by
 * kinds FROZEN in this candidate's own intent snapshot at isolation. None
 * frozen → NOT PROVEN (exit 2, promotion locked, zero bundles, base
 * unmoved). Registration after isolation ADDS duties but can never mint
 * authority — the recovery is register + RE-ISOLATE. No snapshot, no legacy
 * compatibility: absence fails safe. Cases:
 *   A taskless @ isolation           B post-isolation refactor self-mint
 *   C post-isolation other kinds      D register + re-isolate recovery
 *   E delete rec.intent               F intent/task shape spoofing
 *   G hand-forged legacy-shaped rec    H task churn vs the frozen snapshot
 *   I env/flag escapes                J planted/stale PASS bundles
 *   K precedence combos exact          L positive control: honest PASS→ACCEPTED
 * Every check is load-bearing: the verdicts, exits, obligation bytes,
 * promotion-bundle counts and base HEADs are asserted, not counted.
 * NO PROOF, NO DONE.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addRegression } from '../test-support/regression-fixture.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

let failures = 0;
const bases = new Map(); // root -> HEAD pinned at makeRepo; sweep proves blocked cases never moved it
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(hay, re, msg) { assert(re.test(hay), `${msg}\n     expected /${re}/ in:\n     ${hay.split('\n').slice(0, 25).join('\n     ')}`); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m10-2-'));
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.stdout?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000, ...(env ? { env: { ...process.env, ...env } } : {}) });
}
// f4Repo shape: 'test' seals as plan kind 'tests'; green unless red.flag appears;
// tests/keep.test.js is coverage a deletion can violate (UNMET), distinct from
// the missing authority (UNPROVEN). The sealed plan carries the shared
// discrimination fixture (a no-op until a candidate adds the expected value),
// so every leg that must PASS has to carry REAL regression proof: a green suite
// that cannot tell the candidate from its base proves nothing (M10.2 law, and
// the reason these legs assert PASS rather than "green + authority frozen").
function makeRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'check.cjs'), "const fs = require('node:fs');\nprocess.exit(fs.existsSync('red.flag') ? 1 : 0);\n");
  fs.writeFileSync(path.join(root, 'tests', 'keep.test.js'), 'test();\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), '1\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: `node check.cjs && node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', 'f-regression.cjs')}"` } }, null, 2) + '\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'm102@canary.local');
  git(root, 'config', 'user.name', 'Canary M10.2');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'base');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
  bases.set(root, git(root, 'rev-parse', 'HEAD'));
  return root;
}
const candPath = (root, name) => path.join(root, '.canary', 'candidates', name);
const recP = (root, name) => path.join(root, '.canary', 'candidates', `${name}.json`);
const recOf = (root, name) => JSON.parse(fs.readFileSync(recP(root, name), 'utf8'));
function recRewrite(root, name, mut) {
  const rec = recOf(root, name);
  mut(rec);
  fs.writeFileSync(recP(root, name), JSON.stringify(rec, null, 2) + '\n');
}
function bundles(root, suffix) {
  const d = path.join(root, '.canary', 'evidence');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => x.endsWith(suffix)).sort()
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')));
}
function register(root, text, kind) {
  const t = canary(['task', text, '--kind', kind], root);
  assertEq(t.status, 0, `task registration failed: ${t.stdout}\n${t.stderr}`);
}
function isolate(root, name) {
  const i = canary(['isolate', name, root], root);
  assertEq(i.status, 0, `isolate failed: ${i.stdout}\n${i.stderr}`);
}
function work(root, name, files) {
  const c = candPath(root, name);
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(c, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(c, 'add', '-A');
  git(c, 'commit', '-m', 'candidate work');
}
const verify = (root, name, env) => canary(['isolate', '--verify', name, root], root, env);
const promote = (root, name) => canary(['isolate', '--promote', name, root], root);
const notProvenRe = /CANDIDATE NOT PROVEN/;
const authRe = /obligation \[task-authority\] UNPROVEN \(objective\)/;
function assertNoPass(out, msg) { assert(!/CANDIDATE PASS|ELIGIBLE for promotion/.test(out), `${msg}\n     PASS wording appeared:\n     ${out.split('\n').slice(0, 25).join('\n     ')}`); }
// the locked-promotion half of the Northstar assertion, shared by every BLOCKED leg
function assertLocked(root, name, v, label) {
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const p = promote(root, name);
  assertEq(p.status, 2, `${label}: promote must refuse`);
  assertNoPass(p.stdout, `${label}: promote output`);
  assertEq(bundles(root, '-promotion').length, 0, `${label}: zero promotion bundles`);
  assertEq(git(root, 'rev-parse', 'HEAD'), headBefore, `${label}: the trusted base moved`);
  assertEq(v.status, 2, `${label}: verify must exit 2, never a PASS path`);
}

// ================= A: the origin bypass — taskless @ isolation ============
check('A taskless at isolation, green plan, real work → NOT PROVEN naming [task-authority]; promote locked', () => {
  const root = makeRepo('a-taskless');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  const r = verify(root, 'c');
  assertEq(r.status, 2, `A: taskless must never PASS:\n${r.stdout}`);
  assertMatch(r.stdout, notProvenRe, 'A: NOT PROVEN verdict');
  assertNoPass(r.stdout, 'A: no PASS, no eligibility');
  assertMatch(r.stdout, authRe, 'A: the missing FROZEN authority is named');
  assertMatch(r.stdout, /RE-ISOLATE/, 'A: the note names the only recovery');
  const b = bundles(root, '-candidate').at(-1);
  assertEq(b.status, 'unproven', 'A: honest unproven bundle');
  const ta = b.obligations.find((x) => x.id === 'task-authority');
  assert(ta && ta.status === 'unproven' && ta.mode === 'objective', 'A: duty rides the bundle bytes');
  assertLocked(root, 'c', r, 'A');
});

// ============ B: GLM F4-GATE-1 — post-isolation refactor self-mint =========
check('B register refactor AFTER isolation, every refactor duty MET → the old candidate is STILL NOT PROVEN; promotion locked', () => {
  const root = makeRepo('b-gate1');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  assertEq(verify(root, 'c').status, 2, 'B: precondition — taskless verify refuses');
  register(root, 'retroactive tidy', 'refactor'); // the audited move: mint authority from live bytes
  const r = verify(root, 'c');
  assertEq(r.status, 2, `B: post-isolation registration must not mint authority:\n${r.stdout}`);
  assertMatch(r.stdout, notProvenRe, 'B: NOT PROVEN stands');
  assertMatch(r.stdout, authRe, 'B: the frozen-authority duty still stands');
  const b = bundles(root, '-candidate').at(-1);
  assert(b.obligations.some((x) => x.id === 'task-authority' && x.status === 'unproven'),
    `B: authority unproven rides the bundle even though every derived duty is met: ${JSON.stringify(b.obligations)}`);
  assert(b.obligations.filter((x) => x.status === 'met').length >= 1, 'B: the registration DID add duties it met — growth works; authority does not');
  assertLocked(root, 'c', r, 'B');
});

// ============ C: other kinds cannot mint it either =========================
check('C post-isolation registration of bugfix/dependency/performance/ui/multi mints nothing (bugfix even adds an UNMET-grade duty it cannot discharge)', () => {
  for (const kind of ['bugfix', 'dependency', 'performance', 'ui', 'multi']) {
    const root = makeRepo(`c-${kind}`);
    isolate(root, 'c');
    work(root, 'c', { 'src/tweak.js': `${kind}-shaped change\n` });
    register(root, `retroactive ${kind} claim`, kind);
    const r = verify(root, 'c');
    assertEq(r.status, 2, `C-${kind}: must never mint authority:\n${r.stdout}`);
    assertMatch(r.stdout, authRe, `C-${kind}: [task-authority] still UNPROVEN`);
    assertNoPass(r.stdout, `C-${kind}`);
    assertLocked(root, 'c', r, `C-${kind}`);
  }
});

// ============ D: the legitimate recovery — register + RE-ISOLATE ===========
check('D register → re-isolate under a fresh name → the new snapshot freezes the authority → PASS (old candidate stays blocked throughout)', () => {
  const root = makeRepo('d-reisolate');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  assertEq(verify(root, 'c').status, 2, 'D: taskless c starts NOT PROVEN');
  register(root, 'tidy the module layout', 'refactor');
  assertEq(verify(root, 'c').status, 2, 'D: registration alone must not revive c');
  assertMatch(verify(root, 'c').stdout, authRe, 'D: c still hears the frozen-authority duty');
  const headBefore = git(root, 'rev-parse', 'HEAD');
  isolate(root, 'c2'); // the recovery: a fresh isolation freezes the honest task
  addRegression(candPath(root, 'c2')); // real discrimination proof: the plan fails on the sealed base
  work(root, 'c2', { 'src/tweak.js': 'behavior-preserving\n' });
  assertEq(recOf(root, 'c2').intent.task.kinds.join(','), 'refactor', 'D: the fresh snapshot carries the authority');
  const r2 = verify(root, 'c2');
  assertEq(r2.status, 0, `D: register + re-isolate must recover:\n${r2.stdout}`);
  assertMatch(r2.stdout, /CANDIDATE PASS/, 'D: PASS on frozen authority');
  assertEq(git(root, 'rev-parse', 'HEAD'), headBefore, 'D: verify touched nothing');
  // and c remains what it always was — the recovery never retroactively launders it
  assertEq(verify(root, 'c').status, 2, 'D: c stays NOT PROVEN even after c2 legitimately passed');
});

// ================= E: GLM F4-GATE-2 — delete rec.intent ====================
check('E delete rec.intent after isolation (out of window, agent-writable bytes) → NOT PROVEN fails safe; promote locked', () => {
  const root = makeRepo('e-gate2');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  recRewrite(root, 'c', (rec) => { delete rec.intent; });
  const r = verify(root, 'c');
  assertEq(r.status, 2, `E: absence must never PASS:\n${r.stdout}`);
  assertMatch(r.stdout, notProvenRe, 'E: NOT PROVEN, not legacy PASS');
  assertMatch(r.stdout, authRe, 'E: [task-authority] named');
  assertMatch(r.stdout, /no intent snapshot/, 'E: the note explains absence proves nothing about age');
  assert(!/weakened after isolation/.test(r.stdout), 'E: grudgeless — absence is not a §11 event');
  assertLocked(root, 'c', r, 'E');
});

// ================= F: intent/task shape spoofing ===========================
check('F intent {} / null / malformed / task null / task missing / kinds [] / kinds non-array — none reaches PASS; invalid shapes refuse as malformed, readable ones fail safe to UNPROVEN', () => {
  const unproven = [
    ['task-null', (rec) => { rec.intent.task = null; }],
    ['task-missing', (rec) => { delete rec.intent.task; }],
    ['kinds-empty', (rec) => { rec.intent.task = { kinds: [], requirementCount: 0 }; }],
  ];
  for (const [label, mut] of unproven) {
    const root = makeRepo(`f-${label}`);
    isolate(root, 'c');
    work(root, 'c', { 'src/tweak.js': 'x\n' });
    recRewrite(root, 'c', mut);
    const r = verify(root, 'c');
    assertEq(r.status, 2, `F-${label}: must not PASS:\n${r.stdout}`);
    assertMatch(r.stdout, authRe, `F-${label}: fails safe to the frozen-authority duty`);
    assertNoPass(r.stdout, `F-${label}`);
  }
  const malformed = [
    ['intent-empty', (rec) => { rec.intent = {}; }],
    ['intent-null', (rec) => { rec.intent = null; }],
    ['kinds-string', (rec) => { rec.intent.task = { kinds: 'refactor', requirementCount: 0 }; }],
    ['plan-garbage', (rec) => { rec.intent.plan = 'not-an-array'; }],
  ];
  for (const [label, mut] of malformed) {
    const root = makeRepo(`f-${label}`);
    isolate(root, 'c');
    work(root, 'c', { 'src/tweak.js': 'x\n' });
    recRewrite(root, 'c', mut);
    const r = verify(root, 'c');
    assertEq(r.status, 2, `F-${label}: a shape the guard cannot read must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /malformed/, `F-${label}: refused as malformed, fail-closed`);
    assertNoPass(r.stdout, `F-${label}`);
  }
});

// ============ G: hand-forged "legacy-looking" record =======================
check('G a record hand-WRITTEN in the pre-M10 shape (never had an intent, backdated createdAt) → NOT PROVEN; there is no legacy-PASS interpretation', () => {
  const root = makeRepo('g-forged');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  // keep every shape-proved identity byte, remove the snapshot, backdate the
  // record — the most convincing "this predates M10" forgery an agent can write
  recRewrite(root, 'c', (rec) => {
    delete rec.intent;
    rec.createdAt = '2020-01-01T00:00:00.000Z';
  });
  const r = verify(root, 'c');
  assertEq(r.status, 2, `G: the forged legacy shape must never PASS:\n${r.stdout}`);
  assertMatch(r.stdout, notProvenRe, 'G: NOT PROVEN — age is not a verdict');
  assertMatch(r.stdout, authRe, 'G: the frozen-authority duty fires on the forged shape');
  assertLocked(root, 'c', r, 'G');
});

// ============ H: churn of the live task file vs the frozen snapshot ========
check('H remove/re-add of the task record after isolation cannot change the frozen verdict either way', () => {
  // H1: taskless origin — churn the live file through three kinds, authority stays unproven
  const root = makeRepo('h-churn-taskless');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'x\n' });
  const tf = path.join(root, '.canary', 'task', 'current.json');
  register(root, 'claim one', 'refactor');
  fs.rmSync(tf); // the agent "cancels" the claim
  register(root, 'claim two', 'bugfix'); // and re-files it as something else
  const r = verify(root, 'c');
  assertEq(r.status, 2, 'H1: churn cannot mint the frozen authority');
  assertMatch(r.stdout, authRe, 'H1: [task-authority] still stands');
  // H2: honest origin — removing the task shrinks authority BELOW the freeze and
  // the §11 guard blocks; restoring it is the recovery (growth allowed, shrink not)
  const root2 = makeRepo('h-churn-frozen');
  register(root2, 'behavior-preserving restructure', 'refactor');
  isolate(root2, 'c');
  addRegression(candPath(root2, 'c'));
  work(root2, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  assertEq(verify(root2, 'c').status, 0, 'H2: precondition — frozen authority PASSes while the task stands');
  fs.rmSync(path.join(root2, '.canary', 'task', 'current.json'));
  const r2 = verify(root2, 'c');
  assertEq(r2.status, 2, `H2: deleting a frozen authority is a §11 weakening, blocked before execution:\n${r2.stdout}`);
  assertMatch(r2.stdout, /weakened after isolation/, 'H2: the §11 guard owns the shrink vector');
  register(root2, 'behavior-preserving restructure', 'refactor');
  const r3 = verify(root2, 'c');
  assertEq(r3.status, 0, `H3: restoring the live task to the frozen one recovers PASS — churn never forged anything:\n${r3.stdout}`);
});

// ============ I: env vars and flags are inert ==============================
check('I env vars (CANARY_NO_TASK_OK / CANARY_LEGACY / CANARY_FORCE_PASS / ...) and invented flags cannot open the gate', () => {
  const root = makeRepo('i-knobs');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'x\n' });
  const r = verify(root, 'c', {
    CANARY_NO_TASK_OK: '1', CANARY_SKIP_TASK_AUTHORITY: '1', CANARY_LEGACY: '1',
    CANARY_FORCE_PASS: '1', CANARY_TASK_AUTHORITY: 'frozen', CANARY_ALLOW_TASKLESS: '1',
  });
  assertEq(r.status, 2, 'I: env must be inert');
  assertMatch(r.stdout, authRe, 'I: verdict unchanged under every knob');
  for (const flag of ['--no-task-ok', '--task-authority-ok', '--legacy', '--force-pass']) {
    const f = canary(['isolate', '--verify', 'c', root, flag], root);
    assert(f.status !== 0, `I: flag ${flag} must not reach exit 0:\n${f.stdout}`);
    assertNoPass(f.stdout, `I: flag ${flag}`);
  }
});

// ============ J: planted / stale PASS bundles are inert ====================
check('J a hand-planted PASS bundle (byte-copied from a genuinely-PASSED repo) changes no verdict and no promotion', () => {
  // source of a genuine PASS bundle: honest frozen-authority repo
  const honest = makeRepo('j-source');
  register(honest, 'behavior-preserving restructure', 'refactor');
  isolate(honest, 'c');
  addRegression(candPath(honest, 'c'));
  work(honest, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  assertEq(verify(honest, 'c').status, 0, 'J: precondition — honest repo PASSes (its bundle is the copy source)');
  const srcDir = fs.readdirSync(path.join(honest, '.canary', 'evidence')).filter((x) => x.endsWith('-candidate')).at(-1);
  // attack repo: taskless
  const root = makeRepo('j-attack');
  isolate(root, 'c');
  work(root, 'c', { 'src/tweak.js': 'behavior-preserving\n' });
  fs.cpSync(path.join(honest, '.canary', 'evidence', srcDir), path.join(root, '.canary', 'evidence', srcDir), { recursive: true });
  const r = verify(root, 'c');
  assertEq(r.status, 2, 'J: a planted PASS bundle cannot make verify PASS — verdicts are live runs');
  assertMatch(r.stdout, authRe, 'J: the frozen-authority duty stands beside the planted bytes');
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const p = promote(root, 'c');
  assertEq(p.status, 2, 'J: promote re-verifies live; the plant is never read back as authority');
  assertNoPass(p.stdout, 'J');
  assertEq(bundles(root, '-promotion').length, 0, 'J: zero promotion bundles');
  assertEq(git(root, 'rev-parse', 'HEAD'), headBefore, 'J: base unmoved under the plant');
  // and a STALE genuine bundle: re-run promote twice — still no acceptance
  const p2 = promote(root, 'c');
  assertEq(p2.status, 2, 'J: repetition of a refused promote stays refused');
});

// ============ K: precedence combos, exact ==================================
check('K fail > unmet > unproven > pass holds on every combination the agent can build', () => {
  // red plan while taskless: FAIL decides (unproven must not soften it)
  const red = makeRepo('k-red');
  isolate(red, 'c');
  work(red, 'c', { 'red.flag': 'red\n' });
  const r1 = verify(red, 'c');
  assertEq(r1.status, 2, 'K-red: exit 2');
  assertMatch(r1.stdout, /CANDIDATE FAIL/, 'K-red: FAIL outranks the missing authority');
  assert(!notProvenRe.test(r1.stdout), 'K-red: NOT PROVEN does not dilute a FAIL');
  assertEq(bundles(red, '-candidate').at(-1).status, 'fail', 'K-red: fail bundle');
  // test deletion while taskless: UNMET decides, authority visible but not the headline
  const del = makeRepo('k-del');
  isolate(del, 'c');
  const dc = candPath(del, 'c');
  fs.rmSync(path.join(dc, 'tests', 'keep.test.js'));
  git(dc, 'add', '-A'); git(dc, 'commit', '-m', 'coverage loss');
  const r2 = verify(del, 'c');
  assertMatch(r2.stdout, /CANDIDATE BLOCKED/, 'K-del: unmet outranks unproven');
  assert(!notProvenRe.test(r2.stdout), 'K-del: the BLOCKED verdict is the headline');
  const b2 = bundles(del, '-candidate').at(-1);
  assertEq(b2.obligations.find((x) => x.id === 'coverage-loss').status, 'unmet', 'K-del: violation rides');
  assertEq(b2.obligations.find((x) => x.id === 'task-authority').status, 'unproven', 'K-del: authority rides too — visible, not deciding');
  // taskless + green + met duties: UNPROVEN decides (A already proves it; assert it is NOT BLOCKED here)
  const gr = makeRepo('k-green');
  isolate(gr, 'c');
  work(gr, 'c', { 'src/tweak.js': 'x\n' });
  const r3 = verify(gr, 'c');
  assertMatch(r3.stdout, notProvenRe, 'K-green: unproven decides over pass');
  // frozen authority + unmet: BLOCKED (authority present, duty violated)
  const fa = makeRepo('k-frozen-unmet');
  register(fa, 'fix the crash', 'bugfix');
  isolate(fa, 'c');
  const fc = candPath(fa, 'c');
  fs.rmSync(path.join(fc, 'tests', 'keep.test.js'));
  git(fc, 'add', '-A'); git(fc, 'commit', '-m', 'bugfix, coverage loss');
  const r4 = verify(fa, 'c');
  assertMatch(r4.stdout, /CANDIDATE BLOCKED/, 'K-frozen: unmet still decides with authority present');
  assert(!/task-authority/.test(r4.stdout), 'K-frozen: the authority gate is silent (frozen kinds exist)');
});

// ============ L: positive control — the honest path lands ===================
let honestLanded = false;
check('L POSITIVE CONTROL: bugfix registered BEFORE isolation + committed regression test + green plan → PASS → promote ACCEPTED, base moved, exactly one accepted bundle', () => {
  const root = makeRepo('l-honest');
  register(root, 'fix the timer crash', 'bugfix');
  isolate(root, 'c');
  addRegression(candPath(root, 'c')); // the bugfix must be pinned by a check that fails without it
  work(root, 'c', { 'src-timer.js': 'fixed\n', 'tests/timer-crash.test.js': '// reproduces the crash\n' });
  const r = verify(root, 'c');
  assertEq(r.status, 0, `L: the honest path must PASS:\n${r.stdout}`);
  assertMatch(r.stdout, /CANDIDATE PASS/, 'L: PASS verdict');
  assert(!/task-authority/.test(r.stdout), 'L: a frozen-authority candidate never hears the gate');
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const p = promote(root, 'c');
  assertEq(p.status, 0, `L: promote must accept a proven candidate:\n${p.stdout}`);
  assertMatch(p.stdout, /ACCEPTED/, 'L: post-proof ACCEPTED');
  assertEq(git(root, 'rev-parse', 'HEAD'), git(candPath(root, 'c'), 'rev-parse', 'HEAD'), 'L: the verified commit landed on the base');
  assert(headBefore !== git(root, 'rev-parse', 'HEAD'), 'L: the base actually moved');
  const pb = bundles(root, '-promotion');
  assertEq(pb.length, 1, 'L: exactly one promotion bundle');
  assertEq(pb[0].status, 'accepted', 'L: accepted');
  bases.delete(root); // this repo's base MOVED legitimately — exempt it from the sweep
  honestLanded = true;
});

// ================= cross-case hygiene ======================================
check('hygiene: no quarantine stamped by any modeled attack (all record edits are out-of-window, all windows stable)', () => {
  for (const root of bases.keys()) {
    assert(!fs.existsSync(path.join(root, '.canary', 'authority-quarantine.json')), `hygiene: ${path.basename(root)} carries an unexplained quarantine`);
  }
});
check('hygiene: every blocked case left its trusted base byte-unchanged', () => {
  for (const [root, head] of bases) {
    assertEq(git(root, 'rev-parse', 'HEAD'), head, `hygiene: ${path.basename(root)} base HEAD moved under a blocked case`);
  }
});

fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 4 });
console.log('\n=== M10.2 ADVERSARIAL SUMMARY ===');
console.log(failures === 0 && honestLanded
  ? 'M10.2 authority battery: ALL PASS (both former bypasses modeled; honest path lands)'
  : `M10.2 authority battery: ${failures} FAILURE(S)${honestLanded ? '' : ' + positive control L did not land'}`);
process.exit(failures === 0 && honestLanded ? 0 : 1);
