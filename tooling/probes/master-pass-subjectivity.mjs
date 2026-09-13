#!/usr/bin/env node
/**
 * master-pass-subjectivity — PART II split-verdict contract, real git, through
 * the product CLI. The law proven here:
 *   - A candidate whose TECHNICAL evidence is complete but whose remaining
 *     duties only a HUMAN can accept says so in split terms — TECHNICAL
 *     EVIDENCE: PROVEN / SUBJECTIVE ACCEPTANCE: USER JUDGMENT REQUIRED /
 *     OVERALL COMPLETION: NOT PROVEN — while STILL exiting 2, STILL writing
 *     an 'unproven' bundle, and STILL locking promotion. The split describes
 *     where the open duty sits; it never softens NO PROOF, NO DONE.
 *   - Any objective duty still open keeps the plain mixed message — the split
 *     must never launder an unmet technical duty into "evidence complete".
 *   - stdout lists only what is MISSING (the token tax of re-printing MET
 *     duties is gone); the FULL obligation ledger (met included) stays in the
 *     bundle bytes. The verdict branch is asserted to match the bundle's own
 *     obligation modes — message and evidence can never disagree silently.
 *   - bugfix with real proof still PASSes with no ladder ceremony.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { addRegression } from '../test-support/regression-fixture.mjs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const FPASS = `node "${path.join(FX, 'f-regression.cjs')}"`;
const FBUILD = `node "${path.join(FX, 'f-build.js')}"`;
const TWO = { test: FPASS, build: FBUILD };

let failures = 0;
let caseStart = 0;
function check(name, fn) {
  caseStart = Date.now();
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-subjectivity-'));
function makeRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'tests', 'baseline.test.js'), '// baseline coverage\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts: TWO }, null, 2) + '\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
  return root;
}
function register(root, text, kinds, requirements = []) {
  const args = ['task', text];
  for (const k of kinds) args.push('--kind', k);
  for (const r of requirements) args.push('--requirement', r);
  const t = canary(args, root);
  assert(t.status === 0, `task failed: ${t.stdout}\n${t.stderr}`);
}
function isolate(root, name) {
  const r = canary(['isolate', name, root], root);
  assert(r.status === 0, `isolate failed: ${r.stdout}\n${r.stderr}`);
}
function candCommit(root, name, files) {
  const c = path.join(root, '.canary', 'candidates', name);
  // Positive/split controls need actual technical proof. F/H deliberately lack it.
  if (!['f-objective', 'h-mixed'].includes(path.basename(root))) addRegression(c);
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(c, f)), { recursive: true });
    fs.writeFileSync(path.join(c, f), content);
  }
  git(c, 'add', '-A');
  git(c, 'commit', '-m', 'candidate work');
}
function latestCandidateBundle(root) {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.readdirSync(d).filter((x) => x.endsWith('-candidate')).sort();
  assert(dirs.length > 0, 'no candidate bundle written');
  const b = JSON.parse(fs.readFileSync(path.join(d, dirs.at(-1), 'verification.json'), 'utf8'));
  assert(Date.parse(b.at) >= caseStart - 2_000, `newest bundle predates this case (stale masking): ${b.at}`);
  return b;
}

const SPLIT = ['TECHNICAL EVIDENCE: PROVEN', 'SUBJECTIVE ACCEPTANCE: USER JUDGMENT REQUIRED', 'OVERALL COMPLETION: NOT PROVEN'];

// The one law under test, asserted for EVERY ladder outcome: the printed
// branch must equal the branch the BUNDLE's obligation ledger implies — split
// only when every open duty is non-objective, plain whenever an objective one
// stays open. Exit 2, bundle 'unproven', promotion locked, base untouched:
// none of that moves regardless of wording.
function verifyLadder(root, name, expectBranch) {
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const r = canary(['isolate', '--verify', name, root], root);
  const b = latestCandidateBundle(root);
  const open = (b.obligations ?? []).filter((x) => x.status === 'unproven');
  const met = (b.obligations ?? []).filter((x) => x.status === 'met');
  const implied = open.length > 0 && open.every((x) => x.mode === 'non-objective') ? 'split' : 'plain';
  if (r.status === 0) {
    assert(!open.length, `${name}: PASS with open obligations — the ladder leaked`);
    return { r, b };
  }
  assertEq(r.status, 2, `${name}: ladder exit code`);
  assert(b.status === 'unproven', `${name}: bundle status must be 'unproven', got ${b.status}`);
  assert(open.length > 0, `${name}: non-zero exit but no open obligations in bundle — verdict has no evidence`);
  assertEq(implied, expectBranch, `${name}: printed-branch expectation vs bundle-implied branch`);
  const splitLines = SPLIT.filter((s) => r.stdout.includes(s)).length;
  if (expectBranch === 'split') {
    assert(splitLines === 3, `${name}: split verdict must print all three lines, got ${splitLines}:\n${r.stdout}`);
    assert(/CANDIDATE NOT PROVEN/.test(r.stdout), `${name}: split verdict must still say NOT PROVEN — NO PROOF, NO DONE binds`);
  } else {
    assert(splitLines === 0, `${name}: plain branch must print NO split lines (objective duty open):\n${r.stdout}`);
    assert(/CANDIDATE NOT PROVEN/.test(r.stdout), `${name}: plain NOT PROVEN line`);
  }
  // compact stdout: only MISSING duties listed; the full ledger stays bundled
  for (const x of met) {
    assert(!r.stdout.includes(`[${x.id}] MET`), `${name}: stdout re-prints MET obligation ${x.id} — token tax is back`);
    assert((b.obligations ?? []).some((y) => y.id === x.id && y.status === 'met'), `${name}: MET obligation ${x.id} missing from the bundle ledger`);
  }
  for (const x of open) assert(r.stdout.includes(`[${x.id}] UNPROVEN`), `${name}: open obligation ${x.id} not listed on stdout`);
  assert(/next:/.test(r.stdout), `${name}: block message must say what to do next (PART III)`);
  const p = canary(['isolate', '--promote', name, root], root);
  assert(p.status !== 0, `${name}: promotion must stay locked after ${expectBranch === 'split' ? 'a split verdict' : 'NOT PROVEN'}`);
  assert(!/ELIGIBLE|PROMOTED|APPLIED/.test(p.stdout), `${name}: promote stdout leaks apply wording:\n${p.stdout}`);
  const promo = fs.existsSync(path.join(root, '.canary', 'evidence'))
    ? fs.readdirSync(path.join(root, '.canary', 'evidence')).filter((x) => x.endsWith('-promotion')) : [];
  assertEq(promo.length, 0, `${name}: zero promotion bundles`);
  assertEq(git(root, 'rev-parse', 'HEAD'), headBefore, `${name}: trusted base HEAD moved`);
  return { r, b };
}
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }

check('A positive control: bugfix WITH a test change → CANDIDATE PASS, zero ladder lines', () => {
  const root = makeRepo('a-pass');
  register(root, 'fix the login crash', ['bugfix']);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/login.js': 'fixed\n', 'tests/login.test.js': '// reproduces the crash\n' });
  const r = canary(['isolate', '--verify', 'c', root], root);
  assertEq(r.status, 0, `A: must PASS: ${r.stdout}`);
  assert(/CANDIDATE PASS/.test(r.stdout), 'A: PASS line');
  assert(!/TECHNICAL EVIDENCE|SUBJECTIVE ACCEPTANCE/.test(r.stdout), 'A: PASS must not carry ladder ceremony');
});

check('B ui task: technical evidence complete → split verdict, still NOT PROVEN, bundle complete, promotion locked', () => {
  const root = makeRepo('b-ui');
  register(root, 'restyle the dashboard header', ['ui']);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/header.js': 'new styles\n' });
  const { r, b } = verifyLadder(root, 'c', 'split');
  assert(b.obligations.some((x) => x.status === 'met'), 'B: objective duties (tests-green) must show MET in the bundle');
  assert(/obligations: \d+\/\d+ MET/.test(r.stdout), 'B: compact summary line must state the MET count');
});

check('C performance task without benchmark → split verdict (evidence done, human judgment open)', () => {
  const root = makeRepo('c-perf');
  register(root, 'make the list render faster', ['performance']);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/list.js': 'memoized render\n' });
  verifyLadder(root, 'c', 'split');
});

check('D dependency task → split verdict — the duty is human acceptance, not a greener run', () => {
  const root = makeRepo('d-dep');
  register(root, 'upgrade the parsing library', ['dependency']);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/parse.js': 'new import shape\n' });
  verifyLadder(root, 'c', 'split');
});

check('E multi task with requirements: bundle and branch always agree, whatever duties derive', () => {
  const root = makeRepo('e-multi');
  register(root, 'rebuild checkout with metrics', ['multi'], ['checkout flow works end to end', 'p95 latency improved']);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/checkout.js': 'rewritten\n' });
  // expect what the bundle implies; verifyLadder cross-checks both directions
  const probe = canary(['isolate', '--verify', 'c', root], root);
  assert(probe.status !== 0, 'E: open duties (per-requirement at minimum) must block PASS');
  const b = latestCandidateBundle(root);
  const open = b.obligations.filter((x) => x.status === 'unproven');
  assert(open.length > 0, 'E: requirements must each hold a non-objective duty');
  assert(open.every((x) => x.mode === 'non-objective' || x.mode === 'objective'), 'E: sane modes');
  // re-verify via the shared law (fresh bundle), branch computed from the bundle
  verifyLadder(root, 'c', open.every((x) => x.mode === 'non-objective') ? 'split' : 'plain');
});

check('F objective duty open (bugfix without a test) → plain branch, NO split lines, still exit 2 + locked', () => {
  const root = makeRepo('f-objective');
  register(root, 'fix the flaky timer', ['bugfix']);
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/timer.js': 'changed without a test\n' });
  const { r } = verifyLadder(root, 'c', 'plain');
  assert(/\[regression-evidence\] UNPROVEN \(objective\)/.test(r.stdout), 'F: the open objective duty is named:\n' + r.stdout);
});

check('H MIXED open duties (objective bugfix gap + non-objective lockfile change) → plain branch — the split must not fire while ANY objective duty is open', () => {
  // The every→some discriminator: every other scenario has a one-mode open
  // set; only here does `some(non-objective)` differ from `every(...)`.
  const root = makeRepo('h-mixed');
  register(root, 'bump the parser lockfile after fixing the crash', ['bugfix']);
  isolate(root, 'c');
  candCommit(root, 'c', {
    'src/fix.js': 'fixed without a test\n',
    'package-lock.json': '{"name":"h-mixed","lockfileVersion":3}\n', // lockfile ONLY = dep evidence surface
  });
  const { r } = verifyLadder(root, 'c', 'plain');
  assert(/\[regression-evidence\] UNPROVEN \(objective\)/.test(r.stdout), 'H: objective duty named:\n' + r.stdout);
  assert(/\[dependency-change\] UNPROVEN \(non-objective\)/.test(r.stdout), 'H: non-objective duty named alongside it:\n' + r.stdout);
});

check('G no task authority (M10.2 gate) → plain branch, never the split message laundering a missing authority', () => {
  const root = makeRepo('g-noauth');
  isolate(root, 'c');
  candCommit(root, 'c', { 'src/thing.js': 'edited\n' });
  const { r } = verifyLadder(root, 'c', 'plain');
  assert(/\[task-authority\] UNPROVEN \(objective\)/.test(r.stdout), 'G: task-authority duty named on stdout:\n' + r.stdout);
  assert(/RE-ISOLATE|re-isolate/.test(r.stdout), 'G: advice must say the recovery is register + re-isolate');
});

console.log(`\n=== master-pass-subjectivity: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ===`);
process.exit(failures === 0 ? 0 : 1);
