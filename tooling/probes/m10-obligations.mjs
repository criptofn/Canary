#!/usr/bin/env node
/**
 * M10 real-git probe — directive §10 (the obligation ladder at the candidate
 * boundary) + §11 (the trusted intent snapshot). The sealed plan passing is
 * the FLOOR, not the finish: TESTS PASSING != TASK PROVEN COMPLETE. Proven
 * here on real git, end to end through the product CLI:
 *   - the ladder: bugfix candidate WITHOUT a test change → CANDIDATE NOT
 *     PROVEN, exit 2, an 'unproven' bundle that STILL CARRIES THE STEPS, and
 *     --promote refuses it (no promotion bundle, base bytes untouched) —
 *     a green plan can no more launder its way into an apply than a red one;
 *     adding the real regression test recovers PASS (closing an obligation is
 *     actual work). A committed test DELETION → CANDIDATE BLOCKED (obligation
 *     objectively violated, steps + obligations in the bundle); restoring the
 *     deleted file and committing recovers PASS. A red plan stays CANDIDATE
 *     FAIL — and the FAIL bundle now carries the obligation read (M11 repair
 *     fuel), recovered by deleting the marker the same run.
 *   - M10.2 (GLM re-audit, F4-GATE-1/2): registering NOTHING is not a way
 *     through, and neither is minting authority after the fact — task
 *     AUTHORITY must be FROZEN in the candidate's own record at isolation.
 *     A candidate with no frozen task kinds is NOT PROVEN against nothing
 *     (exit 2; obligation [task-authority] UNPROVEN names the missing
 *     authority; promotion locked, zero bundles); registering afterwards
 *     ADDS duties but can never mint it — the recovery is register +
 *     RE-ISOLATE (S12 owns that law). A record with no snapshot at all is
 *     never "pre-M10 legacy, PASS-compatible": its shape is agent-writable
 *     between windows, so absence fails safe to the same NOT PROVEN with
 *     RE-ISOLATE advice (S5 owns that law).
 *   - §11: the candidate record freezes {plan, script digests, task} at
 *     isolation; weakening that authority AFTER isolation — dropping a step
 *     via re-setup, re-sealing a step's text to other commands, shrinking the
 *     registered task — blocks BEFORE anything runs (zero-step blocked bundle
 *     carrying intentEvent), refuses promotion, and leaves NO quarantine
 *     stamp (the block is grudgeless: the snapshot is frozen at record-write
 *     and the record rides M9's fingerprint set). Restoring the authority
 *     bytes IS the recovery; re-running the block does not re-baseline the
 *     snapshot (record bytes identical before/after). Growing the plan or the
 *     task is always allowed — but growth can never restore a stripped
 *     snapshot or mint frozen authority (S5/S12).
 * Positive control first: the guard and the ladder must not shout when the
 * candidate is genuinely proven. NO PROOF, NO DONE.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const FPASS = `node "${path.join(FX, 'f-pass.js')}"`;
const FBUILD = `node "${path.join(FX, 'f-build.js')}"`;

let failures = 0;
let caseStart = 0; // set per check(); latest() refuses a bundle older than the current case
function check(name, fn) {
  caseStart = Date.now();
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(hay, re, msg) { assert(re.test(hay), `${msg}\n     expected /${re}/ in:\n     ${hay.split('\n').slice(0, 25).join('\n     ')}`); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m10-probe-'));
const weakenedRe = /the verification intent was weakened after isolation/;
const notProvenRe = /CANDIDATE NOT PROVEN/;

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.stdout?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
}
function makeRepo(name, scripts, files = {}) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'tests', 'baseline.test.js'), '// baseline coverage\n');
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(root, f), content);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts }, null, 2) + '\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
  return root;
}
const pkgOf = (root) => path.join(root, 'package.json');
function reSeal(root, scripts) { // the mechanical "revision" an agent could do alone: edit base scripts + re-run setup
  fs.writeFileSync(pkgOf(root), JSON.stringify({ name: path.basename(root), private: true, scripts }, null, 2) + '\n');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `re-setup failed: ${s.stdout}\n${s.stderr}`);
}
// M10.1 (GLM F4 close): the ladder needs TASK-OBLIGATION AUTHORITY — a
// taskless record with an intent snapshot is NOT PROVEN (S12 owns that law;
// m10-f4-bypass-repro.mjs proves the promotion lock end to end). The
// recovery-PASS legs of S4a/S4a2/S8/S9/S11 do behavior-preserving work under
// a sealed test plan, so REFACTOR is their honest description — registration
// adds only obligations this fixture already METS (tests-green via the sealed
// 'test' step, coverage-loss via a resolvable diff without deletions) and
// lifts no floor: intents and violations still block on their own grounds.
function registerWork(root, text) {
  const t = canary(['task', text, '--kind', 'refactor'], root);
  assertEq(t.status, 0, `task registration failed: ${t.stdout}\n${t.stderr}`);
}
const candPath = (root, name) => path.join(root, '.canary', 'candidates', name);
const recOf = (root, name) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'candidates', `${name}.json`), 'utf8'));
function isolate(root, name) {
  const r = canary(['isolate', name, root], root);
  assert(r.status === 0, `isolate ${name} failed: ${r.stdout}\n${r.stderr}`);
}
function candCommit(root, name, files, remove = []) {
  const c = candPath(root, name);
  for (const f of remove) fs.rmSync(path.join(c, f), { force: true });
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(c, f)), { recursive: true });
    fs.writeFileSync(path.join(c, f), content);
  }
  git(c, 'add', '-A');
  git(c, 'commit', '-m', 'candidate work');
}
function bundles(root, suffix) {
  const d = path.join(root, '.canary', 'evidence');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => x.endsWith(suffix)).sort()
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')));
}
// The newest -candidate bundle must come from THIS case's runs (2s slack: same
// machine, same clock, process spawn between caseStart and the CLI's write).
// Without it a stale bundle from a prior case could mask a run that wrote none.
const latest = (root) => { const bs = bundles(root, '-candidate'); assert(bs.length > 0, 'no candidate bundle'); const b = bs.at(-1); assert(Date.parse(b.at) >= caseStart - 2_000, `newest candidate bundle predates this case (stale-bundle masking): ${b.at}`); return b; };
const obOf = (b, id) => b.obligations.find((x) => x.id === id);

// full two-step plan everywhere: tests + build (kind 'build' adds no obligation)
const TWO = { test: FPASS, build: FBUILD };
const RED_GREEN = { test: 'node check.cjs' }; // S6: committed RED file turns the plan red

const repoStatus = []; // cross-case hygiene: [root, label] pairs whose base HEAD we pin
function pinBase(root) { repoStatus.push([root, git(root, 'rev-parse', 'HEAD')]); return root; }

// ================= S1: positive control — genuinely proven candidate PASSes,
// obligations ride the bundle, the record froze the intent =================
check('S1 positive control: bugfix candidate WITH a test change → CANDIDATE PASS, 2/2 obligations MET, intent frozen in the record', () => {
  const root = pinBase(makeRepo('s1', TWO));
  const t = canary(['task', 'fix the login crash', '--kind', 'bugfix'], root);
  assertEq(t.status, 0, `task failed: ${t.stdout}`);
  isolate(root, 'c');
  const rec = recOf(root, 'c');
  assert(rec.intent && typeof rec.intent === 'object', 'the record carries an intent snapshot');
  assertEq(rec.intent.plan.map((s) => s.script).join(','), 'test,build', 'snapshot = the plan at isolation');
  assert(rec.intent.seal && /^[0-9a-f]{64}$/.test(rec.intent.seal.test ?? ''), 'snapshot carries the sealed digest of the test text');
  assertEq(rec.intent.task.kinds.join(','), 'bugfix', 'snapshot froze the registered task kinds');
  candCommit(root, 'c', { 'src/login.js': 'fixed\n', 'tests/login.test.js': '// reproduces the crash\n' });
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 0, `S1 verify must PASS: ${r.stdout}`);
  assertMatch(r.stdout, /CANDIDATE PASS/, 'S1-pass: PASS line');
  const b = latest(root);
  assertEq(b.status, 'pass', 'S1-pass: bundle status');
  assertMatch(JSON.stringify(b), /obligations/, 'S1-pass: the obligation read is in the bundle bytes');
  assertEq(b.obligations.length, 2, 'S1-pass: two obligations ride the bundle');
  assertEq(obOf(b, 'regression-evidence').status, 'met', 'S1-pass: test touched → regression met');
  assertEq(obOf(b, 'tests-green').status, 'met', 'S1-pass: sealed tests step ran green');
});

// ================= S2: green plan, missing proof → NOT PROVEN, promotion
// stays locked, real work recovers =================
check('S2 green plan + bugfix WITHOUT a test → CANDIDATE NOT PROVEN exit 2, unproven bundle still carries steps; promote refuses; adding the test recovers PASS', () => {
  const root = pinBase(makeRepo('s2', TWO));
  const t = canary(['task', 'fix the flaky timer', '--kind', 'bugfix'], root);
  assertEq(t.status, 0, `task failed: ${t.stdout}`);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/timer.js': 'changed without a test\n' });
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S2-notproven: exit code');
  assertMatch(r.stdout, notProvenRe, 'S2-notproven: the NOT PROVEN line');
  assertMatch(r.stdout, /NO PROOF, NO DONE/, 'S2-notproven: names the doctrine');
  assert(!/CANDIDATE PASS|ELIGIBLE for promotion/.test(r.stdout), 'S2-notproven: no PASS wording on an unproven run');
  const b = latest(root);
  assertEq(b.status, 'unproven', 'S2-notproven: bundle status is unproven, never pass');
  assertEq(b.steps.length, 2, 'S2-notproven: the steps DID run — the ladder sits on top of them');
  assertEq(obOf(b, 'regression-evidence').status, 'unproven', 'S2-notproven: the gap is named');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S2-notproven: promote must refuse an unproven candidate');
  assert(!/PROMOTED|ALREADY APPLIED/.test(p.stdout), 'S2-notproven: no apply wording');
  assertEq(bundles(root, '-promotion').length, 0, 'S2-notproven: zero promotion bundles');
  candCommit(root, 'c', { 'tests/timer.test.js': '// real regression test\n' });
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S2-notproven: closing the obligation with actual work recovers PASS: ${r2.stdout}`);
  assertMatch(r2.stdout, /CANDIDATE PASS/, 'S2-notproven: PASS after real proof');
});

// ================= S3: committed test deletion → BLOCKED (objective
// violation, steps included), restore recovers =================
check('S3 committed test deletion → CANDIDATE BLOCKED exit 2 (steps + coverage-loss UNMET in the bundle); restore + commit → PASS; promote refused the whole time', () => {
  const root = pinBase(makeRepo('s3', TWO));
  const t = canary(['task', 'restructure the store', '--kind', 'refactor'], root);
  assertEq(t.status, 0, `task failed: ${t.stdout}`);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/store.js': 'refactored\n' }, ['tests/baseline.test.js']); // deleted the coverage
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S3-unmet: exit code');
  assertMatch(r.stdout, /CANDIDATE BLOCKED — the sealed plan passed/, 'S3-unmet: BLOCKED-on-obligation line (not NOT PROVEN)');
  assertMatch(r.stdout, /coverage-loss\] UNMET/, 'S3-unmet: names the violated obligation');
  assertMatch(r.stdout, /git -C .* restore --source=/, 'S3-unmet: prints the restore advice');
  const b = latest(root);
  assertEq(b.status, 'blocked', 'S3-unmet: bundle status');
  assertEq(b.steps.length, 2, 'S3-unmet: objective violation still evidences the steps that ran');
  assertEq(obOf(b, 'coverage-loss').status, 'unmet', 'S3-unmet: obligation status unmet in bytes');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S3-unmet: promote refuses');
  assertEq(bundles(root, '-promotion').length, 0, 'S3-unmet: zero promotion bundles');
  const base = recOf(root, 'c').baseHead;
  git(candPath(root, 'c'), 'restore', '--source=' + base, '--staged', '--worktree', 'tests/baseline.test.js');
  git(candPath(root, 'c'), 'add', '-A');
  git(candPath(root, 'c'), 'commit', '-m', 'restore the deleted coverage');
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S3-unmet: restored coverage must PASS: ${r2.stdout}`);
  assertMatch(r2.stdout, /CANDIDATE PASS/, 'S3-unmet: PASS after restore');
  assertEq(obOf(latest(root), 'coverage-loss').status, 'met', 'S3-unmet: coverage-loss flips to met (resolved diff, nothing deleted)');
});

// ================= S4a: authority weakened via legitimate-looking re-setup —
// plan drop and re-seal — blocked before ANYTHING runs =================
check('S4a plan step dropped after isolation (re-setup with a smaller script set) → zero-step intent block, intentEvent names it, promote refused, record snapshot NOT re-baselined; restoring the bytes recovers', () => {
  const root = pinBase(makeRepo('s4a', TWO));
  registerWork(root, 'tidy the module layout'); // M10.1: the PASS legs need task authority (S12 owns the law)
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/tweak.js': 'ready to pass\n' });
  const pre = canary(['isolate', '--verify', 'c', root], root);
  assertEq(pre.status, 0, `S4a-drop: pre-condition PASS: ${pre.stdout}`);
  reSeal(root, { test: FPASS }); // the dropped "build" step
  const recP = path.join(root, '.canary', 'candidates', 'c.json');
  const recBytesBefore = fs.readFileSync(recP, 'utf8');
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S4a-drop: exit code');
  assertMatch(r.stdout, weakenedRe, 'S4a-drop: the §11 block');
  assertMatch(r.stdout, /"build" present at isolation is no longer in the plan/, 'S4a-drop: names the dropped step');
  assert(!/CANDIDATE PASS|CANDIDATE FAIL|NOT PROVEN|CANDIDATE BLOCKED — the sealed/.test(r.stdout), 'S4a-drop: blocked BEFORE execution — no verdict of any kind');
  assert(!/QUARANTIN|modified by the candidate/.test(r.stdout), 'S4a-drop: grudgeless — this is not a §9 mandate');
  assert(!fs.existsSync(path.join(root, '.canary', 'authority-quarantine.json')), 'S4a-drop: no quarantine stamp');
  const b = latest(root);
  assertEq(b.status, 'blocked', 'S4a-drop: blocked bundle');
  assertEq(b.steps.length, 0, 'S4a-drop: zero steps — the block precedes the window');
  assertMatch(JSON.stringify(b.intentEvent), /no longer in the plan/, 'S4a-drop: intentEvent in the bundle bytes');
  assertEq(fs.readFileSync(recP, 'utf8'), recBytesBefore, 'S4a-drop: the frozen snapshot is NOT re-baselined by the block');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S4a-drop: promote re-verifies and is refused too');
  assertEq(bundles(root, '-promotion').length, 0, 'S4a-drop: zero promotion bundles');
  // second refusal run: still blocked, snapshot still the original
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertMatch(r2.stdout, weakenedRe, 'S4a-drop: re-running cannot wear the block down');
  assertEq(fs.readFileSync(recP, 'utf8'), recBytesBefore, 'S4a-drop: snapshot survives repeat refusals unchanged');
  reSeal(root, TWO); // the human restores the promised authority
  const r3 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r3.status, 0, `S4a-drop: restored authority must recover PASS: ${r3.stdout}`);
  assertMatch(r3.stdout, /CANDIDATE PASS/, 'S4a-drop: PASS after human restore');
});

check('S4a2 sealed text re-locked to different (green) commands after isolation → intent block names the re-seal; restore recovers', () => {
  const root = pinBase(makeRepo('s4a2', TWO));
  registerWork(root, 'tidy the module layout'); // M10.1: restore-recovery asserts PASS — needs task authority
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/tweak.js': 'ready\n' });
  reSeal(root, { test: FBUILD, build: FBUILD }); // same step NAMES, different sealed texts (all green — the laundering target)
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S4a-reseal: exit code');
  assertMatch(r.stdout, weakenedRe, 'S4a-reseal: the §11 block');
  assertMatch(r.stdout, /sealed text of "test" changed since isolation/, 'S4a-reseal: names the re-sealed step');
  const b = latest(root);
  assertEq(b.steps.length, 0, 'S4a-reseal: blocked before execution');
  assert(!fs.existsSync(path.join(root, '.canary', 'authority-quarantine.json')), 'S4a-reseal: grudgeless');
  reSeal(root, TWO);
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S4a-reseal: restore must recover: ${r2.stdout}`);
});

// ================= S4b: the registered task shrunk / grown after isolation ==========
check('S4b task kinds+requirements shrink after isolation → intent block; growing back (and beyond) is allowed and verifies', () => {
  const root = pinBase(makeRepo('s4b', TWO));
  const t = canary(['task', 'fix auth bug', '--kind', 'bugfix', '--requirement', 'login works', '--requirement', 'logout works'], root);
  assertEq(t.status, 0, `task failed: ${t.stdout}`);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/auth.js': 'fixed\n', 'tests/auth.test.js': '// proof\n' });
  const pre = canary(['isolate', '--verify', 'c', root], root);
  // Registered requirements can NEVER yield a candidate PASS until M15 lands
  // a way to prove them — the honest pre-state is NOT PROVEN, guard silent.
  assertEq(pre.status, 2, 'S4b-shrink: pre-condition is NOT PROVEN (requirements unproven), never PASS');
  assertMatch(pre.stdout, notProvenRe, 'S4b-shrink: pre-condition NOT PROVEN line');
  assert(!weakenedRe.test(pre.stdout), 'S4b-shrink: guard silent at match');
  const t2 = canary(['task', 'tidy up'], root); // re-registered smaller: no kind, no requirements
  assertEq(t2.status, 0, `re-task failed: ${t2.stdout}`);
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S4b-shrink: exit code');
  assertMatch(r.stdout, weakenedRe, 'S4b-shrink: the §11 block');
  assertMatch(r.stdout, /task kind "bugfix" registered at isolation is gone/, 'S4b-shrink: names the vanished kind');
  assertMatch(r.stdout, /frozen requirement removed or replaced/, 'S4b-shrink: names the requirement delta');
  const evs = JSON.stringify(latest(root).intentEvent);
  assertMatch(evs, /bugfix/, 'S4b-shrink: both events in the bundle');
  // grow back to exactly the frozen shape: allowed
  canary(['task', 'fix auth bug', '--kind', 'bugfix', '--requirement', 'login works', '--requirement', 'logout works'], root);
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assert(!weakenedRe.test(r2.stdout), `S4b-grow: restoring the frozen task must clear the guard: ${r2.stdout}`);
  assertMatch(r2.stdout, notProvenRe, 'S4b-grow: guard cleared, honest verdict restored (NOT PROVEN — requirements still unprovable pre-M15)');
  // grow BEYOND it (a third requirement) — increases always allowed
  canary(['task', 'fix auth bug', '--kind', 'bugfix', '--requirement', 'login works', '--requirement', 'logout works', '--requirement', 'sessions expire'], root);
  const r3 = canary(['isolate', '--verify', 'c', root], root);
  assert(!weakenedRe.test(r3.stdout), 'S4b-grow: an authority that GREW is never a weakening');
  assertMatch(r3.stdout, notProvenRe, 'S4b-grow: the grown task adds obligations honestly → NOT PROVEN (per-requirement)');
  assertEq(obOf(latest(root), 'per-requirement').status, 'unproven', 'S4b-grow: per-requirement rides the bundle');
});

// ================= S5: an intent-less record FAILS SAFE (M10.2) ===========
// M10.1 read a missing `intent` as "pre-M10 shape, verify exactly as
// before" — but the record is agent-writable bytes BETWEEN windows (M9's
// sandwich only covers the duration of a run), so hand-stripping the
// snapshot re-opened the taskless bypass end to end (GLM F4-GATE-2). Law
// now: absence of the snapshot proves nothing about the record's age — it
// means NO FROZEN AUTHORITY → NOT PROVEN with RE-ISOLATE advice, never a
// legacy PASS.
check('S5 record with the intent hand-stripped → NOT PROVEN naming [task-authority], RE-ISOLATE advice, promote locked — never a legacy PASS', () => {
  const root = pinBase(makeRepo('s5', TWO));
  isolate(root, 'c');
  const recP = path.join(root, '.canary', 'candidates', 'c.json');
  const rec = recOf(root, 'c');
  delete rec.intent;
  fs.writeFileSync(recP, JSON.stringify(rec, null, 2) + '\n');
  candCommit(root, 'c', { 'src/tweak.js': 'taskless, snapshot-less\n' });
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, `S5-failsafe: an intent-less record must never PASS:\n${r.stdout}`);
  assertMatch(r.stdout, notProvenRe, 'S5-failsafe: NOT PROVEN verdict');
  assertMatch(r.stdout, /obligation \[task-authority\] UNPROVEN/, 'S5-failsafe: the missing frozen authority is named');
  assertMatch(r.stdout, /RE-ISOLATE/, 'S5-failsafe: the advice is re-isolation, not "verify as before"');
  assert(!weakenedRe.test(r.stdout), 'S5-failsafe: no snapshot, no §11 guard, no noise — the ladder fails safe');
  const b = latest(root);
  assertEq(b.status, 'unproven', 'S5-failsafe: unproven bundle, never pass');
  assertEq(b.intentEvent, undefined, 'S5-failsafe: grudgeless — absence fails safe, it is not a §11 weakening event');
  assertEq(obOf(b, 'task-authority').status, 'unproven', 'S5-failsafe: the duty rides the bundle bytes');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S5-failsafe: promote rides the refusal');
  assertEq(bundles(root, '-promotion').length, 0, 'S5-failsafe: zero promotion bundles');
});

// ================= S6: FAIL stays FAIL and carries the obligation read ====
check('S6 red plan → CANDIDATE FAIL (exit 2) whose bundle carries the obligations (M11 repair fuel); removing the cause recovers', () => {
  const root = pinBase(makeRepo('s6', RED_GREEN, {
    'check.cjs': "const fs = require('node:fs');\nprocess.exit(fs.existsSync('RED') ? 1 : 0);\n",
  }));
  const t = canary(['task', 'fix the crash', '--kind', 'bugfix'], root);
  assertEq(t.status, 0, `task failed: ${t.stdout}`);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/crash.js': 'fixed\n', 'tests/crash.test.js': '// proof\n', 'RED': '' });
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S6-fail: exit code');
  assertMatch(r.stdout, /CANDIDATE FAIL/, 'S6-fail: FAIL verdict, not NOT PROVEN');
  assert(!notProvenRe.test(r.stdout), 'S6-fail: red is red — the ladder does not dress it up');
  const b = latest(root);
  assertEq(b.status, 'fail', 'S6-fail: bundle status');
  assertEq(b.steps.length, 1, 'S6-fail: the failing step is in the bundle');
  assertEq(b.obligations.length, 2, 'S6-fail: obligations ride the FAIL bundle');
  assertEq(obOf(b, 'regression-evidence').status, 'met', 'S6-fail: proof already earned is visible even on FAIL');
  fs.rmSync(path.join(candPath(root, 'c'), 'RED'));
  git(candPath(root, 'c'), 'add', '-A');
  git(candPath(root, 'c'), 'commit', '-m', 'drop the cause');
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S6-fail: green + proven must PASS: ${r2.stdout}`);
});

// ================= S8: the index can be told to LIE about dirtiness =======
// `git update-index --assume-unchanged` hides a tracked edit from `git
// status` entirely. If dirtiness were read from status alone, a candidate
// with hollowed tests + a lying index would PASS gate 2 and promotion would
// ff-apply the COMMITTED (untouched-test) bytes — verdict judging bytes it
// will never ship. candidateIdentity folds `ls-files -v` flag letters into
// dirty (fail-closed), so the refusal happens at the apply gate.
check('S8 lying index (--assume-unchanged) is seen as dirty: verify reports it, promote refuses; clearing the flag still refuses until the bytes are honest', () => {
  const root = pinBase(makeRepo('s8', TWO));
  registerWork(root, 'add src/a.js honestly'); // M10.1: the honest-bytes recovery asserts PASS — needs task authority
  isolate(root, 'c');
  const c = candPath(root, 'c');
  candCommit(root, 'c', { 'src/a.js': 'committed candidate work\n' });
  fs.writeFileSync(path.join(c, 'tests', 'baseline.test.js'), '// hollowed — hidden from status by the index flag\n');
  git(c, 'update-index', '--assume-unchanged', 'tests/baseline.test.js');
  const r = canary(['isolate', '--verify', 'c', root, '--verbose'], root);
  // the note is a --verbose detail (Out.detail), like every honesty caveat
  assertMatch(r.stdout, /dirty/, 'S8: the lying index does not hide dirtiness from candidateIdentity');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S8: promote gate 2 refuses while the index lies');
  assertMatch(p.stdout, /UNCOMMITTED/, 'S8: the refusal names the hidden edits at DEFAULT verbosity');
  assert(!/PROMOTED|ALREADY APPLIED/.test(p.stdout), 'S8: no apply wording on hidden edits');
  // A refusal writes its own -promotion bundle (refusal-as-evidence), so the
  // invariant is zero ACCEPTED applies, not zero files:
  const pr = bundles(root, '-promotion');
  assertEq(pr.length, 0, 'S8: live verification rejects before promotion starts');
  assertEq(bundles(root, '-candidate').at(-1).status, 'blocked', 'S8: candidate evidence records the refusal');
  git(c, 'update-index', '--no-assume-unchanged', 'tests/baseline.test.js');
  const p2 = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p2.status, 2, 'S8: clearing the flag EXPOSES the real edit — still dirty, still refused');
  assert(bundles(root, '-promotion').every((b) => b.status === 'blocked'), 'S8: still zero accepted promotions');
  git(c, 'checkout', '--', 'tests/baseline.test.js');
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S8: honest bytes recover: ${r2.stdout}`);
  assertMatch(r2.stdout, /CANDIDATE PASS/, 'S8: PASS on restored bytes');
});

// ================= S9: the rename-out escape (suffix survives) =============
// git mv tests/x.test.js src/x.test.js keeps the .test.js SUFFIX but leaves
// the test DIRECTORY — the common runner's include scope is directory-
// shaped, so coverage silently stops executing while the path still LOOKS
// like a test. delPaths now attributes it: coverage-loss UNMET, BLOCKED.
check('S9 committed git mv tests→src keeping the .test.js suffix → CANDIDATE BLOCKED coverage-loss (F3); moving it back recovers', () => {
  const root = pinBase(makeRepo('s9', TWO));
  registerWork(root, 'relocate a module'); // M10.1: the move-back recovery asserts PASS — needs task authority; UNMET coverage-loss still blocks (unmet > unproven precedence rides live on this repo)
  isolate(root, 'c');
  const c = candPath(root, 'c');
  git(c, 'mv', 'tests/baseline.test.js', 'src/baseline.test.js');
  git(c, 'commit', '-m', 'relocate — the suffix stays so nobody notices');
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S9: the suffix-surviving escape must block');
  assertMatch(r.stdout, /CANDIDATE BLOCKED — the sealed plan passed/, 'S9: objective violation');
  assertMatch(r.stdout, /coverage-loss\] UNMET/, 'S9: names the violated obligation');
  const b = latest(root);
  assertEq(obOf(b, 'coverage-loss').status, 'unmet', 'S9: unmet in the bundle bytes');
  assertMatch(JSON.stringify(b), /tests[\\/]baseline\.test\.js/, 'S9: the OLD path is named as the loss');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S9: promote locked');
  git(c, 'mv', 'src/baseline.test.js', 'tests/baseline.test.js');
  git(c, 'commit', '-m', 'back where it runs');
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S9: move-back → committed diff is empty → PASS: ${r2.stdout}`);
});

// ================= S10: evidence the step itself minted (pre-window fix) ===
// The sealed test step WRITES tests/ghost.test.js mid-window and exits
// green. A post-window diff read would count that write as the bugfix's
// regression evidence and PASS — promoting committed bytes that contain no
// test at all. Signals are collected BEFORE the window, exactly like
// cid.head: what the verdict binds is what the verdict judged.
check('S10 a plan step writing a test mid-window cannot mint its own regression evidence → NOT PROVEN; a COMMITTED test (pre-window) passes', () => {
  const Fghost = `node "${path.join(FX, 'm10-ghost-writer.cjs')}"`;
  const root = pinBase(makeRepo('s10', { test: Fghost, build: FBUILD }));
  const t = canary(['task', 'fix the timer', '--kind', 'bugfix'], root);
  assertEq(t.status, 0, `task failed: ${t.stdout}`);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/timer.js': 'fixed without a test\n' });
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, 'S10: green-on-self-written-test must NOT PROVEN (the old post-window read said PASS)');
  assertMatch(r.stdout, notProvenRe, 'S10: the NOT PROVEN line');
  const b = latest(root);
  assertEq(b.steps.length, 2, 'S10: the ghost step really ran green — green is still not proof');
  assertEq(obOf(b, 'regression-evidence').status, 'unproven', 'S10: pre-window bytes: no test in the candidate diff');
  assert(fs.existsSync(path.join(candPath(root, 'c'), 'tests', 'ghost.test.js')),
    'S10: the ghost landed in the worktree — this proves the write happened INSIDE the window');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S10: promote locked');
  fs.rmSync(path.join(candPath(root, 'c'), 'tests', 'ghost.test.js')); // drop the untracked mint
  candCommit(root, 'c', { 'tests/timer.test.js': '// an honest committed regression test\n' });
  candCommit(root, 'c', { 'tests/ghost.test.js': '// ghost — written by the plan step itself\n' }); // every file the step writes now already belongs to the reviewed commit
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S10: a test committed BEFORE the window is real work: ${r2.stdout}`);
  assertMatch(r2.stdout, /CANDIDATE PASS/, 'S10: PASS on genuine evidence');
});

// ================= S11: the clean premise is ASSERTED, not assumed =========
// A post-checkout hook dirties the fresh worktree during `git worktree add`.
// Isolate must roll back (every M10 attribution rests on "the candidate
// began provably clean") and leave NOTHING registered.
check('S11 isolate refuses to register a candidate that is not provably clean (post-checkout hook); removing the hook recovers', () => {
  const root = pinBase(makeRepo('s11', TWO));
  registerWork(root, 'clean-isolation control'); // M10.1: the final clean verify asserts exit 0 — needs task authority
  const hookFile = path.join(root, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hookFile, '#!/bin/sh\necho injected > hooked.txt\n');
  // R1 (M10.1, GLM): on POSIX git executes hooks only when the executable
  // bit is set — a mode-0644 hook is silently skipped and S11 would pass
  // VACUOUSLY (isolate "clean" because the injection never ran). Windows
  // ignores the exec bit; git runs the hook there either way.
  if (process.platform !== 'win32') fs.chmodSync(hookFile, 0o755);
  const r = canary(['isolate', 'c', root], root);
  assertEq(r.status, 2, 'S11: a dirty-at-birth candidate is refused');
  assertMatch(r.stdout, /not provably clean/, 'S11: the refusal names the premise it protects');
  assert(!fs.existsSync(candPath(root, 'c')), 'S11: the worktree was rolled back — no half-created candidate');
  assert(!fs.existsSync(path.join(root, '.canary', 'candidates', 'c.json')), 'S11: nothing was registered');
  fs.rmSync(path.join(root, '.git', 'hooks', 'post-checkout'));
  isolate(root, 'c'); // the helper asserts exit 0 — recovery
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 0, `S11: with the hook gone, isolation verifies clean: ${r2.stdout}`);
});

// ================= S12: the task-obligation AUTHORITY is FROZEN (M10.2) ===
// The audit's two strongest agent moves both lived here. (1) Register
// NOTHING: obligationsFor derives duties from registered kinds, so a
// taskless candidate derived zero duties and a green plan was the whole
// verdict. (2) M10.1's own fix leaked — register AFTER isolation and the
// gate read the LIVE bytes as authority (GLM F4-GATE-1). The law now:
// authority is what THIS candidate's snapshot froze at isolation. Nothing
// frozen → NOT PROVEN, exit 2, [task-authority] named, promotion locked
// with zero bundles. Post-isolation registration ADDS duties (the live
// ladder) but can never mint the authority retroactively; the honest
// recovery is register + RE-ISOLATE, and the fresh candidate then proves
// normally. No flag, env var, or agent-writable field bypasses this.
check('S12 taskless green candidate → NOT PROVEN naming [task-authority]; promote locked, zero bundles; post-isolation registration CANNOT self-mint; register + RE-ISOLATE recovers PASS', () => {
  const root = pinBase(makeRepo('s12', TWO));
  isolate(root, 'c');
  const c = candPath(root, 'c');
  fs.writeFileSync(path.join(c, 'src', 'tweak.js'), 'behavior-preserving\n');
  git(c, 'add', '-A'); git(c, 'commit', '-m', 'tweak');
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 2, `S12: taskless must never PASS:\n${r.stdout}`);
  assertMatch(r.stdout, notProvenRe, 'S12: NOT PROVEN verdict');
  assertMatch(r.stdout, /obligation \[task-authority\] UNPROVEN/, 'S12: names the missing authority');
  assertMatch(r.stdout, /canary task/, 'S12: the note points at the honest path');
  assertMatch(r.stdout, /RE-ISOLATE/, 'S12: the note names re-isolation, not re-verification');
  const b = latest(root);
  assertEq(b.status, 'unproven', 'S12: unproven bundle');
  const ta = obOf(b, 'task-authority');
  assert(ta && ta.status === 'unproven' && ta.mode === 'objective', 'S12: bundle carries the authority obligation');
  assertEq(b.steps.length, 2, 'S12: the executed green steps still ride the bundle');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 2, 'S12: promote locked by gate 1');
  assert(!/PROMOTED|ALREADY APPLIED|ACCEPTED/.test(p.stdout), 'S12: no apply wording');
  assertEq(bundles(root, '-promotion').length, 0, 'S12: zero promotion bundles');
  // F4-GATE-1 pinned here: register AFTER isolation — growth is allowed and
  // adds duties, but the OLD candidate must stay NOT PROVEN. Self-minting
  // the frozen authority from live bytes is dead.
  registerWork(root, 'tidy the module layout');
  const r2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r2.status, 2, `S12-mint: post-isolation registration must NOT mint authority:\n${r2.stdout}`);
  assertMatch(r2.stdout, notProvenRe, 'S12-mint: still NOT PROVEN after the self-mint attempt');
  assertMatch(r2.stdout, /obligation \[task-authority\] UNPROVEN/, 'S12-mint: the authority duty still stands');
  const p2 = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p2.status, 2, 'S12-mint: promote still locked after the self-mint attempt');
  assertEq(bundles(root, '-promotion').length, 0, 'S12-mint: still zero promotion bundles');
  // the legitimate recovery: the registered task rides into a NEW isolation,
  // whose snapshot then freezes it.
  isolate(root, 'c2');
  candCommit(root, 'c2', { 'src/tweak.js': 'behavior-preserving\n' });
  assertEq(recOf(root, 'c2').intent.task.kinds.join(','), 'refactor',
    'S12-reisolate: the fresh snapshot froze the registered authority');
  const r3 = canary(['isolate', '--verify', 'c2', root], root);
  assertEq(r3.status, 0, `S12-reisolate: register + re-isolate must recover: ${r3.stdout}`);
  assertMatch(r3.stdout, /CANDIDATE PASS/, 'S12-reisolate: PASS on the frozen authority');
});

// ================= cross-case hygiene =====================================
// Refusal EVIDENCE (the bundle each block writes) is asserted per scenario at
// each judged run (S2/S3/S4a read the bundle bytes); this sweep owns only the
// two cross-case invariants it actually checks.
check('cross-case hygiene: no quarantine stamped anywhere; every base HEAD unchanged', () => {
  for (const [root, head] of repoStatus) {
    assert(!fs.existsSync(path.join(root, '.canary', 'authority-quarantine.json')), `hygiene: ${path.basename(root)} carries a quarantine marker no scenario stamped`);
    assertEq(git(root, 'rev-parse', 'HEAD'), head, `hygiene: ${path.basename(root)} base HEAD moved during a judged run`);
  }
});

console.log('\n=== M10 PROBE SUMMARY ===');
console.log(failures === 0
  ? 'M10 obligations+intent: ALL PASS'
  : `M10 obligations+intent: ${failures} FAILURE(S)`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
