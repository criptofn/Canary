#!/usr/bin/env node
/**
 * f3-acceptance-growth — GLM finding F-3, closed and attacked.
 * The invariant: a terminal acceptance authorizes EXACTLY the subjective
 * (non-objective) duties that existed WHEN IT WAS SIGNED. The binding is
 * `acceptanceScopeDigest` — the sorted non-objective duty ids + the task's
 * requirement count + per-requirement content digests (identity, not prose).
 * Proven here through the real CLI (accepts run under a pty via `script`):
 *   A1 no change              → acceptance stays FRESH, verify PASSes;
 *   A2 +1 requirement         → STALE → NOT PROVEN;
 *   A3 exact GLM repro 0→2    → USER JUDGMENT REQUIRED, duties reopen;
 *   A4 same-count replacement → STALE (count was never identity);
 *   A5 +1 subjective kind     → STALE;
 *   A6 +objective duty        → acceptance NOT stale, objective still UNPROVEN
 *                              (it never was acceptance-material);
 *   A7 candidate commit moves → STALE;
 *   A8 same-count prose change→ STALE (semantic criterion identity);
 *   A9 PASS → grow → promote  → PROMOTION REFUSED, base HEAD unmoved, no
 *                              accepted promotion bundle; fresh accept recovers;
 *   A10 stale → fresh terminal acceptance → PASS again (no dead end);
 *   MIXED control per spec: objective proof stands through requirement
 *      growth; only the subjective half reopens; fresh acceptance re-PASSes.
 * PTY automation / direct-file forgery remain the documented same-UID ceiling
 * (see SECURITY.md) — this battery attacks scope, not identity.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const TWO = { test: `node "${path.join(FX, 'f-pass.js')}"`, build: `node "${path.join(FX, 'f-build.js')}"` };

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
/** A REAL terminal for the acceptance act — util-linux script gives the child
 *  a pty on stdin+stdout. POSIX-only by nature (the tool is util-linux
 *  `script`); the Windows story for this gate is documented, not claimed. */
function acceptPty(cwd, args, input) {
  const cmd = `${process.execPath} ${CLI} ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`;
  return spawnSync('script', ['-qec', cmd, '/dev/null'], { cwd, encoding: 'utf8', timeout: 120_000, input });
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-f3-'));
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
function candCommit(c, files, msg = 'candidate work') {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(c, f)), { recursive: true });
    fs.writeFileSync(path.join(c, f), content);
  }
  git(c, 'add', '-A');
  git(c, 'commit', '-m', msg);
}
function latestBundle(root, cls) {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.readdirSync(d).filter((x) => x.endsWith(`-${cls}`)).sort();
  assert(dirs.length > 0, `no ${cls} bundle written`);
  const b = JSON.parse(fs.readFileSync(path.join(d, dirs.at(-1), 'verification.json'), 'utf8'));
  assert(Date.parse(b.at) >= caseStart - 2_000, `newest ${cls} bundle predates this case: ${b.at}`);
  return b;
}
const ob = (b, id) => b.obligations.find((x) => x.id === id);
const accPath = (root, name) => path.join(root, '.canary', 'acceptance', `${name}.json`);
/** accept via a real pty and require it to land */
function accept(root, name) {
  const a = acceptPty(root, ['accept', name], `${name}\n`);
  assert(/ACCEPTED from this interactive terminal/.test(a.stdout), `pty accept must land:\n${a.stdout}`);
  return a;
}
/** the acceptance record as written — lets cases inspect the binding */
function accOf(root, name) { return JSON.parse(fs.readFileSync(accPath(root, name), 'utf8')); }

// ---------------------------------------------------------------- headline --
check('F3 GLM exact repro: accept at 0 requirements → grow to 2 → old acceptance does NOT ride it (NOT PROVEN, USER JUDGMENT REQUIRED) → fresh acceptance recovers', () => {
  const root = makeRepo('f3-headline');
  register(root, 'make the dialog warmer', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/dialog.js': 'warmer palette\n' });
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 2, 'F3: subjective duty open before acceptance');
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'F3: accepted scope PASSes (pre-growth)');
  // THE ATTACK: the live task registration GROWS after the acceptance rode it.
  register(root, 'make the dialog warmer', ['ui'], ['make dialog warmer', 'improve icon spacing']);
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, 'F3: grown acceptance-eligible scope must NOT be closed by the old acceptance');
  assert(/SUBJECTIVE ACCEPTANCE: USER JUDGMENT REQUIRED/.test(v.stdout), `F3: the verdict must demand judgment on the NEW scope:\n${v.stdout}`);
  assert(/OVERALL COMPLETION: NOT PROVEN/.test(v.stdout), 'F3: overall NOT PROVEN');
  assert(/STALE/.test(v.stdout), 'F3: the stale binding is named, not hidden');
  const b = latestBundle(root, 'candidate');
  assertEq(ob(b, 'ui-proof').status, 'unproven', 'F3: previously-accepted duty reopens (it rides the growth)');
  assertEq(ob(b, 'per-requirement').status, 'unproven', 'F3: the new duty is UNPROVEN, never silently MET');
  // A10 — no dead end: a fresh terminal acceptance over the NEW scope passes.
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'F3/A10: fresh acceptance over the new scope honestly PASSes again');
});

// ------------------------------------------------------ A1 freshness control --
check('A1 accept → change nothing → verify PASSes: accept-side and verify-side compute the SAME scope digest', () => {
  const root = makeRepo('a1');
  register(root, 'restyle the header', ['ui'], ['header reads warmer']);
  const c = isolate(root, 'c1');
  candCommit(c, { 'src/header.js': 'restyled\n' });
  accept(root, 'c1');
  const v = canary(['isolate', '--verify', 'c1', root], root);
  assertEq(v.status, 0, `A1: untouched scope must stay FRESH:\n${v.stdout}`);
  assert(!/STALE/.test(v.stdout), 'A1: no staleness note without a change');
  assert(/accepted from an interactive terminal/.test(ob(latestBundle(root, 'candidate'), 'ui-proof').note), 'A1: duty closed BY the acceptance');
});

// -------------------------------------------------------- A2 add one duty --
check('A2 accept → add ONE requirement → STALE → NOT PROVEN', () => {
  const root = makeRepo('a2');
  register(root, 'make the dialog warmer', ['ui'], ['dialog uses the new palette']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/dialog.js': 'palette v1\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A2: fresh before the growth');
  register(root, 'make the dialog warmer', ['ui'], ['dialog uses the new palette', 'spacing on the dialog is calmer']);
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, `A2: +1 requirement must reopen everything acceptance-eligible:\n${v.stdout}`);
  assert(/STALE/.test(v.stdout), 'A2: staleness named');
  assert(/OVERALL COMPLETION: NOT PROVEN/.test(v.stdout), 'A2: NOT PROVEN overall');
});

// --------------------------------------------- A4 same-count, different reqs --
check('A4 accept [A,B] → replace with [C,D] (same count) → STALE: requirement identity, not a count', () => {
  const root = makeRepo('a4');
  register(root, 'two-part polish', ['ui'], ['make dialog warmer', 'improve icon spacing']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/dialog.js': 'warmer\n', 'src/icon.js': 'spaced\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A4: fresh before the swap');
  register(root, 'two-part polish', ['ui'], ['change soundtrack', 'make combat prettier']);
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, `A4: an equal COUNT with different content must NOT share the acceptance:\n${v.stdout}`);
  assert(/STALE/.test(v.stdout), 'A4: staleness named');
  assertEq(ob(latestBundle(root, 'candidate'), 'per-requirement').status, 'unproven', 'A4: requirement duty reopened');
});

// ------------------------------------------------------ A5 new subjective duty --
check('A5 accept → grow a NEW subjective kind into scope → STALE', () => {
  const root = makeRepo('a5');
  register(root, 'polish the menu', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/menu.js': 'polished\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A5: fresh before the growth');
  register(root, 'polish the menu', ['ui', 'dependency']);
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, `A5: a new acceptance-eligible duty must not ride the old signature:\n${v.stdout}`);
  assert(/STALE/.test(v.stdout), 'A5: staleness named');
  assert(/\[dependency-change\] UNPROVEN \(non-objective\)/.test(v.stdout), `A5: the NEW duty is visible and open:\n${v.stdout}`);
});

// ------------------------------------------------ A6 objective duty control --
check('A6 accept → grow an OBJECTIVE duty → acceptance does NOT close it, and stays fresh for exactly what it signed', () => {
  const root = makeRepo('a6');
  register(root, 'make the landing page prettier', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/hero.js': 'prettier\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A6: fresh ui-only scope PASSes');
  register(root, 'make the landing page prettier', ['ui', 'bugfix']);
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, `A6: the objective half must block despite a fresh acceptance:\n${v.stdout}`);
  assert(/\[regression-evidence\] UNPROVEN \(objective\)/.test(v.stdout), `A6: objective duty named UNPROVEN:\n${v.stdout}`);
  assert(!/STALE/.test(v.stdout), 'A6: objective growth is NOT acceptance-scope — the signature still covers [ui-proof] exactly');
  const b = latestBundle(root, 'candidate');
  assertEq(ob(b, 'ui-proof').status, 'met', 'A6: the signed subjective duty stays closed');
  assertEq(ob(b, 'regression-evidence').status, 'unproven', 'A6: acceptance never launders an objective duty');
  // real proof lands — and completing the objective half legitimately moves
  // the bytes, so re-acceptance is the honest next step (no dead end).
  candCommit(c, { 'tests/hero.test.js': '// crash repro\n' }, 'add regression test');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 2, 'A6: proof alone does not ride the pre-proof signature');
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A6: proof AND a fresh acceptance complete the mixed task');
});

// ----------------------------------------------------- A7 candidate moves --
check('A7 accept → candidate commit changes → STALE (already law; stays law under the new binding)', () => {
  const root = makeRepo('a7');
  register(root, 'make the charts look better', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/charts.js': 'v1\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A7: fresh');
  candCommit(c, { 'src/charts.js': 'v2 pushed after the signature\n' }, 'style v2');
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, 'A7: unreviewed bytes do not ride an old signature');
  assert(/STALE/.test(v.stdout), 'A7: staleness named');
});

// -------------------------------------------- A8 same-count prose identity --
check('A8 accept → change a requirement WITHOUT changing the count → STALE (criterion identity is semantic)', () => {
  const root = makeRepo('a8');
  register(root, 'one-part polish', ['ui'], ['make the dialog warmer']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/dialog.js': 'warm\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A8: fresh');
  register(root, 'one-part polish', ['ui'], ['make the dialog COOLER']);
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, `A8: the reviewed criterion changed — same count must not save the old acceptance:\n${v.stdout}`);
  assert(/STALE/.test(v.stdout), 'A8: staleness named');
  const rec = accOf(root, 'c');
  assert(/^[0-9a-f]{64}$/.test(rec.acceptanceScopeDigest), 'A8: the record binds a scope digest (identity, not prose)');
});

// -------------------------------------------------- A9 promotion re-check --
check('A9 PASS → grow subjective scope → promote → REFUSED (base unmoved, no accepted promotion bundle); fresh acceptance recovers promotion', () => {
  const root = makeRepo('a9');
  register(root, 'make the sidebar prettier', ['ui']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/sidebar.js': 'prettier\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'A9: PASS pre-growth');
  register(root, 'make the sidebar prettier', ['ui'], ['the sidebar animation feels calmer']);
  const baseHead = git(root, 'rev-parse', 'HEAD');
  const p = canary(['isolate', '--promote', 'c', root], root);
  assert(p.status !== 0, `A9: promotion over a stale acceptance must refuse:\n${p.stdout}`);
  // gate 1 of promotion IS the live verify — its NOT-PROVEN verdict is the
  // refusal (same law pre10 case D pins; PROMOTION REFUSED text belongs to
  // the post-verify gates):
  assert(/STALE/.test(p.stdout), `A9: the live re-verification names the stale acceptance:\n${p.stdout}`);
  assert(/promotion stays locked/.test(p.stdout), `A9: refusal states promotion stays locked:\n${p.stdout}`);
  assertEq(git(root, 'rev-parse', 'HEAD'), baseHead, 'A9: trusted base HEAD did not move');
  const d = path.join(root, '.canary', 'evidence');
  const promo = fs.readdirSync(d).filter((x) => x.endsWith('-promotion'))
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')));
  assert(promo.every((b) => b.status !== 'accepted'), 'A9: no promotion bundle carries an accepted verdict');
  accept(root, 'c');
  const p2 = canary(['isolate', '--promote', 'c', root], root);
  assertEq(p2.status, 0, `A9 no-dead-end: fresh acceptance over the new scope promotes:\n${p2.stdout}`);
  assert(git(root, 'rev-parse', 'HEAD') !== baseHead, 'A9: base now carries the re-accepted work');
});

// ------------------------------------------------------- MIXED task law --
check('MIXED control: proof+acceptance PASS; +1 requirement after acceptance → objective proof STANDS, old subjective acceptance STALE, NOT PROVEN; fresh acceptance → PASS', () => {
  const root = makeRepo('mixed');
  register(root, 'fix the crash and make the dialog prettier', ['bugfix']);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/dialog.js': 'fixed + styled\n', 'tests/dialog.test.js': '// crash repro\n' });
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'MIX: technical proof + acceptance over the current UI duty PASSes');
  register(root, 'fix the crash and make the dialog prettier', ['bugfix'], ['make the menu animation feel calmer']);
  const v = canary(['isolate', '--verify', 'c', root], root);
  assertEq(v.status, 2, `MIX: the grown subjective duty must block:\n${v.stdout}`);
  assert(/STALE/.test(v.stdout), 'MIX: old subjective acceptance named stale');
  const b = latestBundle(root, 'candidate');
  assertEq(ob(b, 'regression-evidence').status, 'met', 'MIX: the objective proof is UNTOUCHED by subjective growth — it stays met on its own evidence');
  assertEq(ob(b, 'ui-proof').status, 'unproven', 'MIX: accepted duty reopens (it rides the scope change)');
  assertEq(ob(b, 'per-requirement').status, 'unproven', 'MIX: the new duty is open for judgment');
  accept(root, 'c');
  assertEq(canary(['isolate', '--verify', 'c', root], root).status, 0, 'MIX: fresh acceptance → PASS reachable again');
});

console.log(`\n=== f3-acceptance-growth: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ===`);
process.exit(failures === 0 ? 0 : 1);
