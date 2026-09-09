#!/usr/bin/env node
/**
 * M10.1 F4 adversarial reproduction — the taskless obligation bypass, run
 * end to end against the REAL product CLI on REAL git. This probe exists to
 * answer one audit finding (GLM M10 audit, F4 — MATERIAL NORTHSTAR BYPASS):
 *
 *   no registered task kind -> testless bugfix candidate -> §10 derives ZERO
 *   obligations (kinds are empty and the diff implies no tests step is owed)
 *   -> CANDIDATE PASS -> --promote exit 0 -> APPLIED to the trusted base ->
 *   promotion bundle written. Omitting task registration was the strongest
 *   agent move precisely because registration is AGENT_REPORTED with zero
 *   authority (it can only ADD obligations).
 *
 * LEG 1 (the attack): a fresh base, NO task ever registered, a candidate that
 * changes source with no test, then verify and promote. The probe prints the
 * observed facts and a verdict line:
 *   F4-BYPASS: OPEN   — base actually moved under a taskless PASS  (exit 1)
 *   F4-BYPASS: CLOSED — verify NOT PROVEN, zero promotion bundles, base HEAD
 *                       byte-unchanged, and the unproven obligation names the
 *                       missing task-obligation authority (exit 0)
 * LEG 2 (positive control — closing F4 must not close the door behind it):
 * the SAME attack shape WITH a registered task and the real proof (a
 * committed regression test) still reaches CANDIDATE PASS and promotion is
 * ACCEPTED, landing the verified commit. If Leg 2 breaks, the "fix" became a
 * lockout, not a closure.
 *
 * Convention: fixtures under the OS temp dir only, PASS/FAIL lines, self-
 * cleaning, exit 0 only when everything passed. NO PROOF, NO DONE.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(hay, re, msg) { assert(re.test(hay), `${msg}\n     expected /${re}/ in:\n     ${hay.split('\n').slice(0, 25).join('\n     ')}`); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-f4-repro-'));
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.stdout?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
}
function makeRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: 'node checks/verify.js' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'checks', 'verify.js'),
    "const fs = require('node:fs');\nprocess.exit(fs.readFileSync('marker.txt', 'utf8').includes('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(root, 'marker.txt'), 'ok\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'repro@canary.local');
  git(root, 'config', 'user.name', 'Canary Repro');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
  return root;
}
const candPath = (root, name) => path.join(root, '.canary', 'candidates', name);
function bundles(root, suffix) {
  const d = path.join(root, '.canary', 'evidence');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => x.endsWith(suffix)).sort()
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')));
}
// The attack body, shared by both legs: candidate edits marker-adjacent SOURCE
// only (the testless "bugfix"), commits, then verify + promote. Returns the
// observed facts — this function never asserts which side of the line they land on.
function runAttack(root, name, { withTask, addTest }) {
  if (withTask) {
    const t = canary(['task', 'fix the timer crash', '--kind', 'bugfix'], root);
    assertEq(t.status, 0, `task registration failed: ${t.stdout}`);
  }
  assertEq(canary(['isolate', name, root], root).status, 0, 'isolate failed');
  const c = candPath(root, name);
  fs.writeFileSync(path.join(c, 'src-timer.js'), 'fixed without touching a test\n');
  if (addTest) {
    fs.mkdirSync(path.join(c, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(c, 'tests', 'timer-crash.test.js'), '// reproduces the crash\n');
  }
  git(c, 'add', '-A');
  git(c, 'commit', '-m', 'testless bugfix-shaped change');
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const v = canary(['isolate', '--verify', name, root], root);
  const p = canary(['isolate', '--promote', name, root], root);
  const headAfter = git(root, 'rev-parse', 'HEAD');
  return {
    vExit: v.status, vOut: v.stdout, pExit: p.status, pOut: p.stdout,
    baseMoved: headBefore !== headAfter,
    applied: headAfter === git(c, 'rev-parse', 'HEAD'),
    candidateBundles: bundles(root, '-candidate').map((b) => b.status),
    promotionBundles: bundles(root, '-promotion').map((b) => b.status),
  };
}

let bypassOpen = false;
try {
  // ============ LEG 1: the attack exactly as the audit ran it ============
  let obs = null;
  check('f4-leg1: taskless testless candidate runs verify+promote end to end (observations recorded)', () => {
    const root = makeRepo('attack');
    obs = runAttack(root, 'f4', { withTask: false, addTest: false });
    console.log(`     F4-OBSERVE verify-exit=${obs.vExit} bundle=${JSON.stringify(obs.candidateBundles)}`);
    console.log(`     F4-OBSERVE promote-exit=${obs.pExit} promotion-bundles=${JSON.stringify(obs.promotionBundles)} base-moved=${obs.baseMoved} applied=${obs.applied}`);
  });
  if (obs && obs.baseMoved && obs.applied && obs.pExit === 0) {
    bypassOpen = true;
    console.log('F4-BYPASS: OPEN — a taskless candidate PASSED, promoted, and was APPLIED to the trusted base (this is the audit finding, unfixed)');
  } else {
    check('f4-leg1-closed: verify is NOT PROVEN with the missing-authority obligation named', () => {
      assertEq(obs.vExit, 2, 'F4-closed: a taskless candidate must exit 2, never a PASS');
      assert(!/CANDIDATE PASS/.test(obs.vOut), 'F4-closed: no PASS wording without task obligation authority');
      assertMatch(obs.vOut, /CANDIDATE NOT PROVEN/, 'F4-closed: honest NOT PROVEN verdict line');
      assertMatch(obs.vOut, /obligation \[task-authority\] UNPROVEN/, 'F4-closed: the evidence NAMES the absent task-obligation authority');
      assertEq(obs.candidateBundles.at(-1), 'unproven', 'F4-closed: the bundle status is honest unproven');
      const last = bundles(path.join(TMP, 'attack'), '-candidate').at(-1);
      const ta = last.obligations.find((x) => x.id === 'task-authority');
      assert(ta && ta.status === 'unproven', `F4-closed: task-authority rides the bundle bytes: ${JSON.stringify(last.obligations)}`);
      assertMatch(ta.note, /canary task/, 'F4-closed: the note prints the recovery path');
    });
    check('f4-leg1-closed: promotion is locked — zero promotion bundles, base HEAD byte-unchanged', () => {
      assertEq(obs.pExit, 2, 'F4-closed: promote must refuse an unproven candidate');
      assert(!/PROMOTED|ALREADY APPLIED|ACCEPTED/.test(obs.pOut), 'F4-closed: no apply wording');
      assertEq(obs.promotionBundles.length, 0, 'F4-closed: the act never began — zero promotion bundles');
      assert(!obs.baseMoved, 'F4-closed: the trusted base HEAD moved anyway');
    });
  }

  // ============ LEG 2: positive control — honest work still lands ============
  check('f4-leg2 positive control: registered bugfix + committed regression test → PASS → promote ACCEPTED', () => {
    const root = makeRepo('honest');
    const o = runAttack(root, 'f4', { withTask: true, addTest: true });
    assertEq(o.vExit, 0, `leg2 must PASS: ${o.vOut}`);
    assertMatch(o.vOut, /CANDIDATE PASS/, 'leg2: PASS on a registered task with real proof');
    assertEq(o.pExit, 0, `leg2 promote must accept: ${o.pOut}`);
    assertMatch(o.pOut, /PROMOTED/, 'leg2: PROMOTED line');
    assertMatch(o.pOut, /ACCEPTED/, 'leg2: post-proof ACCEPTED');
    assert(o.baseMoved && o.applied, 'leg2: the verified commit really landed on the base branch');
    assertEq(o.promotionBundles.at(-1), 'accepted', 'leg2: accepted promotion bundle written');
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 4 });
}

if (bypassOpen) {
  console.log('F4-VERDICT: NOT CLOSED');
  process.exit(1);
}
console.log(failures === 0
  ? 'F4-BYPASS: CLOSED — taskless candidates can no longer reach PASS or promotion; the honest path still lands (M10-f4-repro: ALL PASS)'
  : `F4-BYPASS: NOT PROVEN — ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
