#!/usr/bin/env node
/**
 * lazy-connect-status — PART I (Lazy Connect) + PART III (failure UX) +
 * PART IV (eliminate work, do not cache it) contract, real git, product CLI:
 *
 *   - `canary status` answers "does Canary already know this repo?" WITHOUT
 *     executing a single project command and WITHOUT writing a byte: proven by
 *     a whole-tree (incl. .git) byte manifest around every status run, and by
 *     a plan that TOUCHES a sentinel file — status never creates it, doctor
 *     always does.
 *   - Honest state vocabulary: NOT CONNECTED (never set up / unreadable /
 *     untrusted) — NEEDS ATTENTION (wiring or sealed authority broken) —
 *     CONNECTED (a statement about state; never a claim the project passes).
 *   - Subdirectory entry routes to the repo root (the agent's cwd is not a
 *     config problem to solve manually).
 *   - Bare `canary` inside a repo is no longer a dead end: usage + a footer
 *     naming the repo's state, exit still 3.
 *   - Unattended `setup` without --yes (no TTY) runs the smoke test like
 *     doctor already does; a failing project still never reads READY.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000, stdio: opts.stdinNull ? ['ignore', 'pipe', 'pipe'] : undefined, ...opts.extra });
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-status-'));
function manifest(root) {
  const m = new Map();
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.name === 'sentinel.txt') continue; // the probe's own tripwire
      m.set(path.relative(root, p).replaceAll('\\', '/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  }
  return m;
}
function assertStable(root, before, tag) {
  const after = manifest(root);
  const diff = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
  assertEq(diff.join(', '), '', `${tag}: status must write ZERO bytes (tree changed: ${diff.join(', ')})`);
}
// a plan whose ONLY effect is touching a sentinel — proof nothing executed
function makeRepo(name, { setup = true } = {}) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'checks', 'touch.cjs'), "require('node:fs').writeFileSync('sentinel.txt', 'executed\\n');\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'node checks/touch.cjs' } }, null, 2) + '\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  if (setup) {
    const s = canary(['setup', '--yes', root], root);
    assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
    fs.rmSync(path.join(root, 'sentinel.txt'), { force: true }); // the setup run's own touch is not evidence
  }
  return root;
}

check('outside any git repo: NOT CONNECTED, tells the human the one next command', () => {
  const bare = path.join(TMP, 'not-a-repo'); fs.mkdirSync(bare, { recursive: true });
  const r = canary(['status'], bare);
  assertEq(r.status, 2, `exit: ${r.stdout}\n${r.stderr}`);
  assert(/NOT CONNECTED/.test(r.stdout), 'NOT CONNECTED verdict');
  assert(/next:|canary setup/.test(r.stdout), 'PART III: says what to do next');
});

check('git repo, never set up: NOT CONNECTED with zero writes', () => {
  const root = makeRepo('fresh', { setup: false });
  const before = manifest(root);
  const r = canary(['status', root], root);
  assertEq(r.status, 2, `exit: ${r.stdout}`);
  assert(/NOT CONNECTED/.test(r.stdout), 'NOT CONNECTED verdict');
  assert(/never set up/.test(r.stdout), 'names WHY (PART III)');
  assertStable(root, before, 'not-set-up');
});

check('connected repo: CONNECTED — read-only facts, ZERO commands executed, ZERO bytes written', () => {
  const root = makeRepo('connected');
  const before = manifest(root);
  const r = canary(['status', root], root);
  assertEq(r.status, 0, `exit: ${r.stdout}\n${r.stderr}`);
  assert(/CONNECTED/.test(r.stdout) && !/NOT CONNECTED/.test(r.stdout), 'CONNECTED verdict');
  assert(/plan: 1 step/.test(r.stdout), 'plan facts line');
  assert(/sealed authority intact/.test(r.stdout), 'seal fact');
  assert(/task:/.test(r.stdout) && /candidates:/.test(r.stdout) && /last checkpoint:/.test(r.stdout), 'state lines present');
  assert(!/✓/.test(r.stdout), 'no plan step lines printed — status never runs the plan');
  assert(!fs.existsSync(path.join(root, 'sentinel.txt')), 'the plan was NOT executed (sentinel absent)');
  assert(/NOT a claim|statement about state/.test(r.stdout), 'CONNECTED never claims the project passes');
  assertStable(root, before, 'connected');
  // positive control that the sentinel really does work: doctor executes
  const d = canary(['doctor', root], root);
  assertEq(d.status, 0, `doctor: ${d.stdout}`);
  assert(fs.existsSync(path.join(root, 'sentinel.txt')), 'doctor DID execute (tripwire live)');
});

check('from a subdirectory: status still answers about the repo root', () => {
  const root = makeRepo('subdir');
  const sub = path.join(root, 'checks');
  const r = canary(['status'], sub);
  assertEq(r.status, 0, `subdir status exit: ${r.stdout}\n${r.stderr}`);
  assert(r.stdout.includes(root), `repo line names the root:\n${r.stdout}`);
});

check('drifted authority (sealed script text edited after setup): NEEDS ATTENTION, not a fake CONNECTED', () => {
  const root = makeRepo('drift');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.scripts.test = 'node checks/touch.cjs && echo watered-down';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  const before = manifest(root);
  const r = canary(['status', root], root);
  assertEq(r.status, 2, `drift must not read CONNECTED: ${r.stdout}`);
  assert(/NEEDS ATTENTION/.test(r.stdout), 'NEEDS ATTENTION verdict');
  assert(/authority changed since setup/.test(r.stdout), 'names the drift (PART III: what is missing)');
  assert(/next:/.test(r.stdout), 'names the repair');
  assert(!fs.existsSync(path.join(root, 'sentinel.txt')), 'a broken plan is still NOT executed by status');
  assertStable(root, before, 'drift');
});

check('hook registration removed: NEEDS ATTENTION names the broken wiring', () => {
  const root = makeRepo('unhooked');
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  doc.hooks.Stop = [];
  fs.writeFileSync(settingsPath, JSON.stringify(doc, null, 2));
  const before = manifest(root); // AFTER the deliberate break
  const r = canary(['status', root], root);
  assertEq(r.status, 2, `broken wiring must not read CONNECTED: ${r.stdout}`);
  assert(/no longer registered|NOT registered/.test(r.stdout), 'names the missing hook');
  assertStable(root, before, 'unhooked');
});

check('corrupt config: NOT CONNECTED, plain words, zero writes', () => {
  const root = makeRepo('corrupt');
  fs.writeFileSync(path.join(root, '.canary', 'canary.local.json'), '{nope');
  const before = manifest(root);
  const r = canary(['status', root], root);
  assertEq(r.status, 2, `exit: ${r.stdout}`);
  assert(/NOT CONNECTED/.test(r.stdout) && /unreadable/.test(r.stdout), 'corrupt verdict');
  assertStable(root, before, 'corrupt');
});

check('tracked config (git-committed .canary/canary.local.json): never CONNECTED — ownership distrust holds', () => {
  const root = makeRepo('tracked');
  git(root, 'add', '-f', '.canary/canary.local.json');
  git(root, 'commit', '-m', 'launder config through git');
  const before = manifest(root);
  const r = canary(['status', root], root);
  assert(/^CONNECTED —/m.test(r.stdout) === false, `tracked config must never read CONNECTED:\n${r.stdout}`);
  assert(/NOT CONNECTED/.test(r.stdout), 'tracked config is distrusted, loudly');
  assertEq(r.status, 2, 'exit 2 (not trusted)');
  assertStable(root, before, 'tracked');
});

check('bare `canary` in a connected repo: usage + CONNECTED footer hint, exit still 3', () => {
  const root = makeRepo('bare');
  const r = canary([], root);
  assertEq(r.status, 3, 'bare usage keeps exit 3');
  assert(/^CONNECTED —/m.test(r.stdout) && /canary status/.test(r.stdout), 'footer points at the read-only state command:\n' + r.stdout);
  const bare = makeRepo('bare-unconnected', { setup: false });
  const r2 = canary([], bare);
  assertEq(r2.status, 3, 'exit 3');
  assert(/NOT CONNECTED/.test(r2.stdout), 'unconnected git repo footer');
  const nb = path.join(TMP, 'bare-nonrepo'); fs.mkdirSync(nb, { recursive: true });
  const r3 = canary([], nb);
  assertEq(r3.status, 3, 'exit 3 outside git');
  // Some machines keep TEMP inside an ancestor git repo (e.g. a dotfile-homed
  // Windows profile) — then the honest footer names the UNTRUSTED repo, which
  // is correct behavior. What must never happen: claiming CONNECTED here.
  assert(!/^CONNECTED —/m.test(r3.stdout), 'never claims CONNECTED outside a connected repo:\n' + r3.stdout);
});

check('unattended setup without --yes (no TTY): smoke test RUNS — READY is earned, failures still never pass', () => {
  const good = makeRepo('notty-good', { setup: false });
  const r = canary(['setup', good], good, { stdinNull: true });
  assertEq(r.status, 0, `unattended setup must now run the smoke test: ${r.stdout}\n${r.stderr}`);
  assert(/READY/.test(r.stdout), 'READY after a passing run');
  assert(fs.existsSync(path.join(good, '.canary', 'last-checkpoint.json')), 'checkpoint written by the run');
  assert(!/NEEDS ATTENTION/.test(r.stdout), 'no more demand for a memorized flag when the checks pass');
  const bad = makeRepo('notty-bad', { setup: false });
  fs.writeFileSync(path.join(bad, 'checks', 'touch.cjs'), "process.exit(7);\n");
  git(bad, 'add', '-A'); git(bad, 'commit', '-m', 'break the check');
  const rb = canary(['setup', bad], bad, { stdinNull: true });
  assertEq(rb.status, 2, `failing checks must still block READY: ${rb.stdout}`);
  assert(!/READY/.test(rb.stdout), 'executing is not forgiving');
});

console.log(`\n=== lazy-connect-status: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ===`);
process.exit(failures === 0 ? 0 : 1);
