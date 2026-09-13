#!/usr/bin/env node
/**
 * pre10-acceptance — blocker 3's acceptance law, through the real CLI.
 * Proven here:
 *   - a UI/performance/dependency/requirement duty no longer dead-ends: the
 *     printed recovery advice, FOLLOWED LITERALLY from a real pty terminal,
 *     closes the duty and the candidate PASSes (recovery-advice end-to-end);
 *   - MIXED tasks need BOTH: acceptance never touches an objective duty;
 *   - non-TTY invocation (every coding agent's posture) is REFUSED, no file;
 *   - no flag and no env var escapes the terminal gate; --yes is usage;
 *   - a forged-shape record (acceptedBy agent) is unreadable; a stale binding
 *     (candidate commit moved) reopens the duty with named advice;
 *   - acceptance of a candidate WITHOUT frozen task authority is refused with
 *     the real recovery (register + re-isolate) — accept never recommends a
 *     dead end;
 *   - base HEAD never moves on refusal paths; an accepted+PASSed candidate
 *     still promotes honestly (positive control).
 * Same-UID total-byte forgery of a WELL-SHAPED fresh record is the documented
 * M2 ceiling; this probe covers the USUAL agent paths, which is the contract.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminal } from '../test-support/terminal.mjs';
import { addRegression } from '../test-support/regression-fixture.mjs';
import { materialDigest } from '../../apps/cli/dist/src/authorization.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const TWO = { test: `node "${path.join(FX, 'f-regression.cjs')}"`, build: `node "${path.join(FX, 'f-build.js')}"` };

let failures = 0;
let caseStart = 0;
function check(name, fn) {
  caseStart = Date.now();
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000, env: env ?? process.env });
}
/** A REAL terminal for the human act — util-linux script gives the child a
 *  pty on stdin+stdout, exactly what a coding agent's pipe streams are not.
 *  On a host with no drivable pty the shared provider falls back to the repo's
 *  in-process terminal driver and the probe reports an explicit host-bound SKIP
 *  (exit 3) naming exactly what could not be proven — it never claims a pass. */
const TERMINAL = createTerminal({ repo: REPO, cli: CLI });
let hostSkips = 0;
if (!TERMINAL.provenRealPty) {
  hostSkips++;
  console.log(`SKIP  acceptance-terminal-provider  ${TERMINAL.skipReason}`);
}
const acceptPty = (cwd, args, input) => TERMINAL.run(cwd, args, input);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-accept-'));
function makeRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;\n');
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
  return path.join(root, '.canary', 'candidates', name);
}
function candCommit(c, files, msg = 'candidate work', proof = true) {
  if (proof) addRegression(c);
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(c, f)), { recursive: true });
    fs.writeFileSync(path.join(c, f), content);
  }
  git(c, 'add', '-A');
  git(c, 'commit', '-m', msg);
}
function latestCandidateBundle(root) {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.readdirSync(d).filter((x) => x.endsWith('-candidate')).sort();
  assert(dirs.length > 0, 'no candidate bundle written');
  const b = JSON.parse(fs.readFileSync(path.join(d, dirs.at(-1), 'verification.json'), 'utf8'));
  assert(Date.parse(b.at) >= caseStart - 2_000, `newest bundle predates this case: ${b.at}`);
  return b;
}
const accPath = (root, name) => path.join(root, '.canary', 'acceptance', `${name}.json`);

// A — the recovery advice, FOLLOWED VERBATIM, closes the loop end to end.
check('A happy path: split verdict → printed `canary accept c` run from a pty → re-verify PASS (advice is executable)', () => {
  const root = makeRepo('a-happy');
  register(root, 'make the landing page prettier', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/hero.js': 'new gradient\n' });
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const v1 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v1.status, 2, 'A: subjective duty must be open before acceptance');
  assert(/OVERALL COMPLETION: NOT PROVEN/.test(v1.stdout), `A: split verdict expected:\n${v1.stdout}`);
  const m = v1.stdout.match(/canary accept ([A-Za-z0-9._-]+)/);
  assert(m, 'A: the verdict must PRINT the exact acceptance command');
  const a = acceptPty(root, ['accept', m[1]], `${m[1]}\n`);
  assert(/ACCEPTED from this interactive terminal/.test(a.stdout), `A: pty accept must land:\n${a.stdout}`);
  assert(fs.existsSync(accPath(root, 'c')), 'A: acceptance record written');
  assertEq(git(root, 'rev-parse', 'HEAD'), headBefore, 'A: acceptance must not touch the base');
  const v2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v2.status, 0, `A: after acceptance the candidate must PASS:\n${v2.stdout}`);
  assert(/CANDIDATE PASS/.test(v2.stdout), 'A: PASS line');
  const b = latestCandidateBundle(root);
  const ui = b.obligations.find((x) => x.id === 'ui-proof');
  assert(ui && ui.status === 'met' && /accepted from an interactive terminal/.test(ui.note), `A: bundle must record the acceptance:\n${JSON.stringify(b.obligations)}`);
});

// B — MIXED: acceptance closes the subjective half, the objective half stays open.
check('B mixed task: acceptance never launders an objective gap; proof+acceptance together PASS', () => {
  const root = makeRepo('b-mixed');
  register(root, 'fix the crash and make the dialog prettier', ['bugfix']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/dialog.js': 'fixed + styled\n' }, 'candidate work', false);
  const v1 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v1.status, 2, 'B: open duties before proof/acceptance');
  assert(/\[regression-evidence\] UNPROVEN \(objective\)/.test(v1.stdout), `B: objective gap named:\n${v1.stdout}`);
  assert(/\[ui-proof\] UNPROVEN \(non-objective\)/.test(v1.stdout), `B: subjective half named alongside — the --kind bugfix flag did not drop it:\n${v1.stdout}`);
  const a = acceptPty(root, ['accept', 'c'], 'c\n');
  assert(/ACCEPTED from this interactive terminal/.test(a.stdout), `B: accept itself must work:\n${a.stdout}`);
  const v2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v2.status, 2, 'B: PASS with only acceptance on a mixed task would be laundering');
  assert(/\[regression-evidence\] UNPROVEN \(objective\)/.test(v2.stdout), `B: objective duty must STILL be open:\n${v2.stdout}`);
  const b2 = latestCandidateBundle(root);
  assert(b2.obligations.find((x) => x.id === 'ui-proof')?.status === 'met', 'B: subjective duty closed by acceptance in the bundle');
  // the new regression-test commit changes the reviewed bytes → the signature
  // is now stale; proof arriving must not silently ride an old acceptance
  candCommit(c, { 'tests/dialog.test.js': '// reproduces the crash\n' }, 'add regression test');
  const v3 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v3.status, 2, 'B: proof alone after a byte-change must NOT PASS on the stale signature');
  assert(/STALE/.test(v3.stdout), `B: staleness named:\n${v3.stdout}`);
  const a2 = acceptPty(root, ['accept', 'c'], 'c\n');
  assert(/ACCEPTED from this interactive terminal/.test(a2.stdout), `B: re-accept the final bytes:\n${a2.stdout}`);
  const v4 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v4.status, 0, `B: proof AND a fresh acceptance together must PASS:\n${v4.stdout}`);
  const p = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p.status, 0, `B positive control: mixed-complete promotes honestly:\n${p.stdout}`);
  assert(git(root, 'rev-parse', 'HEAD') === git(c, 'rev-parse', 'HEAD'), 'B: base now carries the accepted work');
});

// C — non-TTY (the coding-agent posture) is refused outright; no file exists.
check('C agent self-accept: pipe streams REFUSED; env/flag escapes do not exist; nothing written', () => {
  const root = makeRepo('c-agent');
  register(root, 'restyle the header', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/header.js': 'restyled\n' });
  const v1 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v1.status, 2, 'C: duty open first');
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const plain = canary(['accept', 'c'], root); // spawnSync: pipes, no TTY
  assertEq(plain.status, 2, `C: non-TTY accept must refuse:\n${plain.stdout}`);
  assert(/REFUSED — the supported acceptance flow requires an interactive terminal/.test(plain.stdout), 'C: refusal names the boundary');
  assert(!fs.existsSync(accPath(root, 'c')), 'C: no record from a pipe session');
  // supply the exact typed name THROUGH the pipe too: with the gate removed
  // (mutation M10) this is the line that would write a record — a real refusal
  // never even reads it
  const piped = spawnSync(process.execPath, [CLI, 'accept', 'c'], { cwd: root, encoding: 'utf8', timeout: 60_000, input: 'c\n' });
  assert(piped.status !== 0 && !/ACCEPTED from this interactive terminal/.test(piped.stdout), `C: a piped name is still not a terminal:\n${piped.stdout}`);
  assert(!fs.existsSync(accPath(root, 'c')), 'C: nothing written from a pipe even with the name supplied');
  const withEnv = canary(['accept', 'c'], root, { ...process.env, CANARY_ACCEPT: '1', CANARY_ACCEPTED_BY: 'tty-human' });
  assertEq(withEnv.status, 2, 'C: no env var flips the gate');
  const withFlag = canary(['accept', 'c', '--yes'], root);
  assert(withFlag.status !== 0 && !/ACCEPTED/.test(withFlag.stdout), `C: a --yes flag cannot bypass the terminal check:\n${withFlag.stdout}`);
  assert(!fs.existsSync(accPath(root, 'c')), 'C: still nothing written');
  // wrong name typed even on a pty does not accept
  const wrong = acceptPty(root, ['accept', 'c'], 'yes i accept\n');
  assert(/NOT ACCEPTED/.test(wrong.stdout), `C: freeform yes must refuse:\n${wrong.stdout}`);
  assert(!fs.existsSync(accPath(root, 'c')), 'C: still nothing written after typed mismatch');
  const v2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v2.status, 2, 'C: verdict unchanged by the attempted acceptance');
  assertEq(git(root, 'rev-parse', 'HEAD'), headBefore, 'C: base untouched');
});

// D — staleness: the bytes reviewed moved; the duty reopens with named advice.
check('D stale acceptance: new candidate commit reopens the duty, advice says re-accept', () => {
  const root = makeRepo('d-stale');
  register(root, 'make the charts look better', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/charts.js': 'v1 styling\n' }, 'style v1');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 2, 'D: open first');
  const a = acceptPty(root, ['accept', 'c'], 'c\n');
  assert(/ACCEPTED from this interactive terminal/.test(a.stdout), `D: fresh accept:\n${a.stdout}`);
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'D: accepted state PASSes');
  candCommit(c, { 'src/charts.js': 'v2 styling pushed AFTER the human signed\n' }, 'style v2');
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, 'D: unreviewed bytes must not ride an old signature');
  assert(/STALE/.test(v.stdout), `D: staleness named:\n${v.stdout}`);
  assert(/canary accept c/.test(v.stdout), 'D: advice names the re-accept command');
  const b = latestCandidateBundle(root);
  assertEq(b.obligations.find((x) => x.id === 'ui-proof')?.status, 'unproven', 'D: duty reopened in the bundle');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assert(p.status !== 0, 'D: promotion stays locked on the stale acceptance');
  const a2 = acceptPty(root, ['accept', 'c'], 'c\n');
  assert(/ACCEPTED from this interactive terminal/.test(a2.stdout), 'D: re-accept works');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'D: recovers to PASS — the advice is a real path');
});

// E — forged shapes: agent-authored records carry zero weight; the old v1
// schema fails CLOSED (the binding moved, so a pre-scope record is no record).
check('E forged acceptance file: agent shape + legacy schemas are refused; only the current complete subject binds', () => {
  const root = makeRepo('e-forge');
  register(root, 'polish the menu', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/menu.js': 'polished\n' });
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 2, 'E: open first');
  const head = git(c, 'rev-parse', 'HEAD');
  const base = git(root, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(root, '.canary', 'acceptance'), { recursive: true });
  const v2rec = { schema: 'canary-acceptance/2', at: new Date().toISOString(), candidate: 'c', baseHead: base, candidateHead: head, intentDigest: '0'.repeat(64), acceptanceScopeDigest: '0'.repeat(64), acceptedBy: 'agent' };
  fs.writeFileSync(accPath(root, 'c'), JSON.stringify(v2rec));
  let v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, 'E: fully v2-shaped acceptedBy:agent record must carry zero weight');
  assert(!/accepted from an interactive terminal/.test(JSON.stringify(latestCandidateBundle(root))), 'E: no fabricated MET');
  const v1rec = { schema: 'canary-acceptance/1', at: new Date().toISOString(), candidate: 'c', baseHead: base, candidateHead: head, intentDigest: '0'.repeat(64), acceptedBy: 'tty-human' };
  fs.writeFileSync(accPath(root, 'c'), JSON.stringify(v1rec));
  v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, 'E: legacy schema/1 record (no acceptanceScopeDigest binding) must fail CLOSED, not pass');
  assert(!/accepted from an interactive terminal/.test(JSON.stringify(latestCandidateBundle(root))), 'E: legacy record fabricates no MET');
});

// F — accept cannot mint task authority; it refuses with the REAL recovery.
check('F no frozen authority: accept refuses and recommends register+re-isolate (no dead end)', () => {
  const root = makeRepo('f-noauth');
  const c = isolate(root, 'c');
  candCommit(c, { 'src/thing.js': 'edited\n' });
  const a = acceptPty(root, ['accept', 'c'], 'c\n');
  assertEq(a.status, 2, 'F: refuse with code');
  assert(/RE-ISOLATE/.test(a.stdout), `F: the printed recovery must be the real one:\n${a.stdout}`);
  assert(!fs.existsSync(accPath(root, 'c')), 'F: nothing written');
  register(root, 'refactor', ['refactor']);
  const live = JSON.parse(fs.readFileSync(path.join(root, '.canary/task/current.json'), 'utf8'));
  const rp = path.join(root, '.canary/candidates/c.json');
  const record = JSON.parse(fs.readFileSync(rp, 'utf8'));
  record.intent.task = { ...live, kinds: [] };
  fs.writeFileSync(rp, JSON.stringify(record));
  const empty = acceptPty(root, ['accept', 'c'], 'c\n');
  assertEq(empty.status, 2, 'F: shape-valid empty frozen kind set cannot mint authority');
  assert(!fs.existsSync(accPath(root, 'c')), 'F: empty frozen kinds write nothing');
});

// G — dependency duties: declared-but-not-observed is honest, acceptance closes observed.
check('G dependency task: no-observed-change says so; after a lockfile edit acceptance closes it', () => {
  const root = makeRepo('g-dep');
  register(root, 'upgrade the parsing library', ['dependency']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/parse.js': 'new import shape\n' });
  const v1 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v1.status, 2, 'G: duty open');
  assert(/touches no dependency file/.test(v1.stdout), `G: must not claim a change it cannot see:\n${v1.stdout}`);
  candCommit(c, { 'package-lock.json': '{"name":"g-dep","lockfileVersion":3}\n' }, 'lockfile bump');
  const v2 = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v2.status, 2, 'G: still open after the edit (it is human-closable, not auto-met)');
  assert(/dependency change observed \(.*package-lock\.json.*\)/s.test(v2.stdout), `G: observed evidence is LISTED:\n${v2.stdout}`);
  const a = acceptPty(root, ['accept', 'c'], 'c\n');
  assert(/ACCEPTED from this interactive terminal/.test(a.stdout), 'G: accept closes the dependency duty after review');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'G: candidate completes');
});

// H — requirement tasks, under the v1.2 rule.
//
// v1.1 asserted that a mechanical requirement's `per-requirement` duty CLOSES VIA ACCEPTANCE. That
// was the defect, not the contract: the duty said "acceptance cannot replace measurement for an
// objective requirement" while being acceptance-eligible, so a TTY signature could close a
// requirement nobody had measured — and a worker told to satisfy it burned 1.5-1.85M tokens.
//
// H1 asserts the corrected completing path (a SEALED BINDING closes it, by measurement);
// H2 asserts the corrected refusing path (with no binding it stays open, and acceptance cannot
// close it — and, found while writing H2, `accept` now refuses to sign an empty duty set at all).
check('H1 requirement task: a sealed binding closes the requirement duty — by measurement, not a signature', () => {
  const root = makeRepo('h-requirement');
  const reqs = ['the rules are applied in the stated order', 'the save round-trips without data loss'];
  // No UI vocabulary in the task text: `ui-proof` is a separate duty with its own acceptance path,
  // and including it here would leave a NON-objective duty open and muddle what this case measures.
  register(root, 'apply the settings rules and fix the save bug', ['bugfix'], reqs);

  // The operator binds both requirements to the sealed plan's `test` script BEFORE isolating, which
  // is the documented order (declare -> bind -> setup -> hand off).
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.canary = { proofs: Object.fromEntries(reqs.map((r) => [materialDigest(r), 'test'])) };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'bind the requirements to the sealed test script');
  const reseal = canary(['setup', '--yes', root], root);
  assert(reseal.status === 0, `H1: re-seal after binding failed:\n${reseal.stdout}${reseal.stderr}`);

  const c = isolate(root, 'h');
  // The candidate carries a discriminating check (the probe's standard regression fixture), so the
  // ONLY thing that could keep the requirement duty open is the requirement itself.
  candCommit(c, { 'src/settings.js': 'the stated rules, applied\n' }, 'candidate work', true);

  const v1 = canary(['isolate', '--verify', 'h', root], root);
  assertEq(v1.status, 0, `H1: a BOUND requirement completes by measurement alone:\n${v1.stdout}`);
  const b1 = latestCandidateBundle(root);
  const perDuty = b1.obligations.find((x) => x.id === 'per-requirement');
  assert(perDuty, 'H1: the per-requirement duty must be in the bundle');
  assertEq(perDuty.mode, 'objective', 'H1: an unmeasured requirement is a MEASUREMENT duty, not a signature');
  assertEq(perDuty.status, 'met', 'H1: closed by the sealed binding, not by acceptance');
  const p = canary(['isolate', '--promote', 'h', root], root);
  assertEq(p.status, 0, `H1: promotes honestly:\n${p.stdout}`);
});

check('H2 requirement task: with NO binding the duty stays open, and acceptance CANNOT close it', () => {
  const root = makeRepo('h-unbound');
  register(root, 'apply the settings rules and fix the save bug', ['bugfix'],
    ['the rules are applied in the stated order', 'the save round-trips without data loss']);
  const c = isolate(root, 'h');
  candCommit(c, { 'src/settings.js': 'the stated rules, applied\n' }, 'candidate work', true);

  const v = canary(['isolate', '--verify', 'h', root], root);
  assertEq(v.status, 2, 'H2: an unmeasured requirement keeps the candidate NOT PROVEN');
  const b = latestCandidateBundle(root);
  const perDuty = b.obligations.find((x) => x.id === 'per-requirement');
  assert(perDuty, 'H2: the duty must be present');
  assertEq(perDuty.mode, 'objective', 'H2: an unmeasured requirement is a MEASUREMENT duty');
  assertEq(perDuty.status, 'unproven', 'H2: and it stays unproven until something measures it');

  // The act a human must NOT be able to use here. Found while writing this case: `accept` used to
  // sign an acceptance whose covered duty set was EMPTY, which is a standing authorisation over
  // nothing. It now refuses, and the refusal must not write a record.
  const a = acceptPty(root, ['accept', 'h'], 'h\n');
  assertEq(a.status, 2, `H2: accept must refuse: ${a.stdout}`);
  assert(!/ACCEPTED from this interactive terminal/.test(a.stdout),
    `H2: acceptance must not be able to close an objective requirement:\n${a.stdout}`);
  assert(!fs.existsSync(path.join(root, '.canary', 'acceptance', 'h.json')),
    'H2: no acceptance record may be written when there is no subjective duty to accept');
});

if (failures > 0) {
  console.log(`\n=== pre10-acceptance: ${failures} FAIL ===`);
  process.exit(1);
}
if (hostSkips > 0) {
  // Never a pass: the product assertions above all executed, but the pty
  // allocation this probe exists to exercise could not be proven here.
  console.log(`\n=== pre10-acceptance: every check EXECUTED and passed, with ${hostSkips} explicit host-bound SKIP(s) ===`);
  console.log(`PROBE-PASS-WITH-SKIP — ${hostSkips} explicit host-bound SKIP(s) above; NOT full acceptance on this host`);
  process.exit(3);
}
console.log('\n=== pre10-acceptance: ALL PASS ===');
process.exit(0);
