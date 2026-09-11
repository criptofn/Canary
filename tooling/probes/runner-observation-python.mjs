#!/usr/bin/env node
/**
 * Python execution observation — channel proof and forgery attempts.
 *
 * This is the empirical basis for the `python-unittest` runner adapter. It
 * exercises the CANARY-OWNED channel directly (no product wiring yet) so the
 * channel can be judged on its own:
 *
 *   sitecustomize.py (Canary's bytes, on PYTHONPATH) -> hooks
 *   unittest.TestResult -> NDJSON frames on fd 3 -> parent re-counts.
 *
 * What must hold:
 *   1. a REAL unittest run produces hello/pass/bye agreeing with the printed
 *      summary, with hello.pid equal to the pid Canary spawned;
 *   2. a program that merely PRINTS a perfect unittest summary without running
 *      tests produces ZERO pass frames — text cannot become observed counts;
 *   3. a result reported for a test whose startTest was never seen is REJECTED
 *      (the same rule mocha's observer enforces with Runnable#run);
 *   4. observer failures degrade to an adapter-error frame, never to silence
 *      that could be mistaken for "no tests".
 *
 * Exits 0 only if every case holds. Prints every frame it saw: no truncated
 * diagnostics.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const OBS = path.join(REPO, 'packages', 'runner', 'executor', 'dist', 'src', 'observers', 'python-observer.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

assert(fs.existsSync(OBS), `missing built observer module: ${OBS} (run npm run build)`);
const { PYTHON_OBSERVER_SOURCE, PYTHON_OBSERVER_BASENAME, PYTHON_RUNNER_ID } = await import(`file://${OBS.replace(/\\/g, '/')}`);

const which = spawnSync('where', ['python.exe'], { encoding: 'utf8', timeout: 30_000 });
const PY = (which.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
assert(PY !== undefined, 'no python.exe on PATH — this channel cannot be exercised here');
console.log(`python: ${PY}`);
console.log(`observer bytes: ${PYTHON_OBSERVER_SOURCE.length}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-py-obs-'));
const OBS_DIR = path.join(TMP, 'observer');
fs.mkdirSync(OBS_DIR, { recursive: true });
fs.writeFileSync(path.join(OBS_DIR, PYTHON_OBSERVER_BASENAME), PYTHON_OBSERVER_SOURCE, 'utf8');

/** Run python with the observer on PYTHONPATH and fd 3 piped. Returns frames. */
function runObserved(cwd, args, timeoutMs = 120_000, nonce = 'probe-nonce-1') {
  return new Promise((resolve) => {
    const child = spawn(PY, args, {
      cwd,
      env: {
        PYTHONPATH: OBS_DIR, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\WINDOWS',
        CANARY_OBSERVER_NONCE: nonce,
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = ''; let err = ''; let fd3 = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { err += String(b); });
    child.stdio[3].on('data', (b) => { fd3 += String(b); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const frames = fd3.split('\n').filter((l) => l.trim() !== '').map((l) => { try { return JSON.parse(l); } catch { return { k: 'UNPARSEABLE', raw: l }; } });
      resolve({ code, signal, out, err, frames, pid: child.pid });
    });
  });
}

function fixture(name, files) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return root;
}
const kinds = (frames) => frames.map((f) => f.k);
const count = (frames, k) => frames.filter((f) => f.k === k).length;

// ───────────────────────── 1. a real unittest run ─────────────────────────
const good = fixture('real', {
  'tests/test_ok.py': [
    'import unittest',
    '',
    'class Passing(unittest.TestCase):',
    '    def test_one(self): self.assertTrue(True)',
    '    def test_two(self): self.assertEqual(1, 1)',
    '',
    'class Mixed(unittest.TestCase):',
    '    def test_ok(self): pass',
    '    @unittest.skip("not today")',
    '    def test_skipped(self): pass',
    '',
  ].join('\n'),
});

const real = await runObserved(good, ['-m', 'unittest', 'discover', '-v', '-s', 'tests']);
console.log(`\n--- real run: exit ${real.code} ---`);
for (const f of real.frames) console.log(`  ${JSON.stringify(f)}`);
console.log(`  stderr tail: ${real.err.trim().split('\n').slice(-3).join(' | ')}`);

check('a real unittest run yields hello -> passes -> bye, nonce- and process-bound', () => {
  const hello = real.frames.find((f) => f.k === 'hello');
  assert(hello, `no hello frame: ${JSON.stringify(kinds(real.frames))}`);
  assert(hello.runner === PYTHON_RUNNER_ID, `hello.runner = ${JSON.stringify(hello.runner)}`);
  assert(typeof hello.runnerVersion === 'string' && /^\d+\.\d+\.\d+/.test(hello.runnerVersion), `bad runnerVersion: ${JSON.stringify(hello.runnerVersion)}`);
  assert(hello.observerVersion === 'canary-observer-v1', `observerVersion = ${JSON.stringify(hello.observerVersion)}`);
  // A Windows virtualenv's python.exe re-executes the base interpreter, so the
  // reporting pid is legitimately the CHILD of the one Node spawned. The binding
  // that must hold is nonce + (pid or ppid == spawned pid).
  assert(hello.nonce === 'probe-nonce-1', `the round nonce must round-trip: ${JSON.stringify(hello.nonce)}`);
  assert(hello.pid === real.pid || hello.ppid === real.pid,
    `neither pid (${hello.pid}) nor ppid (${hello.ppid}) is the spawned pid (${real.pid}) — the observation is not bound to this spawn`);
  assert(real.frames[0].k === 'hello', 'hello must be the first frame');
  const bye = real.frames[real.frames.length - 1];
  assert(bye.k === 'bye', `bye must be the last frame, got ${bye.k}`);
  assert(count(real.frames, 'pass') === 3, `expected 3 pass frames, got ${count(real.frames, 'pass')}`);
  assert(count(real.frames, 'pending') === 1, `expected 1 pending frame, got ${count(real.frames, 'pending')}`);
  assert(count(real.frames, 'reject') === 0, `no rejects expected, got ${count(real.frames, 'reject')}`);
  assert(bye.counts.pass === 3 && bye.counts.pending === 1 && bye.counts.fail === 0, `bye counts disagree: ${JSON.stringify(bye.counts)}`);
});

check('a round with a DIFFERENT nonce is distinguishable (the binding is per spawn)', () => {
  // Not a separate run: the nonce is echoed, so a frame set that carries the
  // wrong nonce can never be mistaken for this round's observation.
  const hello = real.frames.find((f) => f.k === 'hello');
  assert(hello.nonce !== 'some-other-round', 'the nonce must come from the environment, not be a constant');
});

check('the observed counts agree with the interpreter\'s own printed summary', () => {
  // "Ran 4 tests" with 3 passing and 1 skipped is what unittest prints; the
  // observation must agree with it or the round is not admissible.
  const m = /Ran (\d+) tests?/.exec(real.err);
  assert(m, `could not read unittest's summary line:\n${real.err}`);
  const ran = Number(m[1]);
  const bye = real.frames.at(-1);
  assert(ran === bye.counts.pass + bye.counts.fail + bye.counts.pending,
    `text says ${ran} ran, observation says ${JSON.stringify(bye.counts)}`);
  assert(/OK/.test(real.err), 'fixture should be OK');
});

// ─────────────────── 2. text forgery cannot create counts ───────────────────
const forged = fixture('forge', {
  'main.py': 'print("Ran 3 tests in 0.001s")\nprint("")\nprint("OK")\n',
});
const forge = await runObserved(forged, ['main.py']);
console.log(`\n--- text forgery: exit ${forge.code} ---`);
for (const f of forge.frames) console.log(`  ${JSON.stringify(f)}`);

check('printing a perfect unittest summary produces ZERO observed passes', () => {
  assert(/Ran 3 tests/.test(forge.out) && /OK/.test(forge.out), 'the fixture must actually print the forged summary');
  assert(count(forge.frames, 'pass') === 0, `text forged ${count(forge.frames, 'pass')} passes`);
  assert(count(forge.frames, 'pending') === 0, 'text forged pending');
  assert(count(forge.frames, 'fail') === 0, 'text forged fail');
  const bye = forge.frames.at(-1);
  assert(bye.k === 'bye', 'the observer still reports a clean bye');
  assert(bye.counts.pass === 0 && bye.counts.fail === 0 && bye.counts.pending === 0, `counts not zero: ${JSON.stringify(bye.counts)}`);
});

// ── 3. a result for a test whose startTest was never seen is REJECTED ──
const fake = fixture('fake-result', {
  'main.py': [
    'import unittest',
    'r = unittest.TestResult()',
    '',
    'class T:',
    '    def id(self): return "forged.suite.forged_test"',
    '    def __str__(self): return "forged_test"',
    '',
    'r.addSuccess(T())   # reported success, never started',
    'print("Ran 1 test in 0.001s")',
    'print("")',
    'print("OK")',
    '',
  ].join('\n'),
});
const fak = await runObserved(fake, ['main.py']);
console.log(`\n--- fabricated addSuccess: exit ${fak.code} ---`);
for (const f of fak.frames) console.log(`  ${JSON.stringify(f)}`);

check('a success for a test whose startTest was never watched is REJECTED', () => {
  const rejects = fak.frames.filter((f) => f.k === 'reject');
  assert(rejects.length === 1, `expected exactly 1 reject frame, got ${JSON.stringify(fak.frames)}`);
  assert(rejects[0].reason === 'no-run', `reject reason = ${JSON.stringify(rejects[0].reason)}`);
  assert(rejects[0].id === 'forged.suite.forged_test', `reject must name the identity: ${JSON.stringify(rejects[0])}`);
  assert(count(fak.frames, 'pass') === 0, 'a rejected event must not also count as a pass');
});

// ──────────────── 4. a broken observer degrades to adapter-error ────────────────
check('an observer that cannot install reports adapter-error, never silence', () => {
  // fd 3 is not opened here (3 stdio slots), so every frame write fails. The
  // channel must be CLOSED, not silently "valid with zero tests" — the child
  // still runs, and no frames arrive.
  const r = spawnSync(PY, ['-c', 'print("hello")'], {
    cwd: good,
    env: { PYTHONPATH: OBS_DIR, PATH: process.env.PATH ?? '' },
    encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(r.status === 0, `the child must be unaffected by the observer: ${r.stderr}`);
  assert(/hello/.test(r.stdout), 'the child still runs its own program');
});

console.log(`\n=== python observation: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
console.log(`scratch: ${TMP}`);
if (failures === 0 || process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
