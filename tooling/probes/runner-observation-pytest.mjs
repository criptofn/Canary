#!/usr/bin/env node
/**
 * The Canary PYTEST observation channel — real execution, forgery, suppression.
 *
 * Loads the SHIPPED plugin bytes (`PYTEST_OBSERVER_SOURCE`) into a real pytest run
 * and checks what `Recorder.round()` depends on, using the SAME product parsers the
 * round uses (`parsePytestCounts` / `extractPytestFailingNames` from the built
 * comparator):
 *
 *   1. hello/pass/fail/pending/bye arrive on fd 3, nonce- and process-bound;
 *   2. the observed categories AGREE with pytest's own headline — including the
 *      categories pytest counts outside `passed` (skipped, xfail, XPASS) and
 *      `error`, which is why the mapping is explicit and measured;
 *   3. a failing run's identities agree with the short-summary nodeids;
 *   4. printed text cannot mint counts;
 *   5. a fabricated `logreport` for an item Canary never watched start is REJECTED;
 *   6. an injected frame from test code fails the round closed (pytest runs tests
 *      IN its own process, so this door is real — measured, unlike node:test).
 *
 * The interpreter defaults to the workspace-local `_toolchains/py` venv; override
 * with CANARY_PYTEST_PYTHON. Exits 0 only when everything holds.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PY = process.env.CANARY_PYTEST_PYTHON ?? path.join(REPO, '_toolchains', 'py', 'Scripts', 'python.exe');
const url = (p) => pathToFileURL(p).href;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ?? 'not equal'}\n     actual:   ${a}\n     expected: ${b}`);
}

if (!fs.existsSync(PY)) {
  console.log(`pytest interpreter not found at ${PY}`);
  process.exit(1);
}
const PYTEST_MOD = path.join(REPO, 'packages', 'runner', 'executor', 'dist', 'src', 'observers', 'pytest-observer.js');
const COMPARATOR_MOD = path.join(REPO, 'packages', 'core', 'comparator', 'dist', 'src', 'index.js');
assert(fs.existsSync(PYTEST_MOD), `missing built pytest observer module (run npm run build)`);
assert(fs.existsSync(COMPARATOR_MOD), `missing built comparator module (run npm run build)`);
const {
  PYTEST_OBSERVER_SOURCE, PYTEST_OBSERVER_BASENAME, PYTEST_PLUGIN_MODULE, PYTEST_RUNNER_ID, pytestRunnerIdentity,
} = await import(url(PYTEST_MOD));
const { parsePytestCounts, extractPytestFailingNames, parseSummaryCountsFor, hasRunnerSummaryFor } =
  await import(url(COMPARATOR_MOD));

const identity = pytestRunnerIdentity(PY);
assert(identity !== null, `pytest identity must resolve for ${PY}`);
console.log(`pytest ${identity.version}, tree sha256 ${identity.identitySha256.slice(0, 16)}…, plugin bytes ${PYTEST_OBSERVER_SOURCE.length}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pytest-'));
const obsDir = path.join(TMP, 'observer');
fs.mkdirSync(obsDir, { recursive: true });
fs.writeFileSync(path.join(obsDir, PYTEST_OBSERVER_BASENAME), PYTEST_OBSERVER_SOURCE, 'utf8');

const NONCE = 'pytest-probe-nonce';

/**
 * Run pytest the way the executor does: the sanitized-environment door reduced to
 * what matters here (PYTHONPATH + PYTEST_PLUGINS + the nonce), stdout/stderr pipes,
 * and a private fd 3 for the frames.
 */
function runObserved(name, files, extraArgs = []) {
  const cwd = path.join(TMP, name);
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(cwd, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return new Promise((resolve) => {
    const child = spawn(PY, ['-m', 'pytest', ...extraArgs], {
      cwd, shell: false, windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: obsDir,
        PYTHONNOUSERSITE: '1',
        PYTEST_PLUGINS: PYTEST_PLUGIN_MODULE,
        CANARY_OBSERVER_NONCE: NONCE,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = ''; let err = ''; let fd3 = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { err += String(b); });
    child.stdio[3].on('data', (b) => { fd3 += String(b); });
    child.on('close', (code) => {
      const frames = fd3.split('\n').filter((l) => l.trim() !== '')
        .map((l) => { try { return JSON.parse(l); } catch { return { k: 'UNPARSEABLE', raw: l }; } });
      resolve({ code, out, err, frames, pid: child.pid });
    });
  });
}
const kindOf = (r, k) => r.frames.filter((f) => f.k === k);
const byeOf = (r) => r.frames.at(-1);

const SAMPLE = [
  'import pytest',
  '',
  '',
  'def test_passes():',
  '    assert 1 == 1',
  '',
  '',
  'def test_fails():',
  '    assert 1 == 2',
  '',
  '',
  '@pytest.mark.skip(reason="not today")',
  'def test_skipped():',
  '    pass',
  '',
  '',
  '@pytest.mark.xfail(reason="known bad")',
  'def test_xfails():',
  '    assert False',
  '',
  '',
  '@pytest.mark.xfail(reason="surprisingly fine")',
  'def test_xpasses():',
  '    assert True',
  '',
  '',
  '@pytest.fixture',
  'def broken():',
  '    raise RuntimeError("fixture blew up")',
  '',
  '',
  'def test_errors_in_fixture(broken):',
  '    pass',
  '',
].join('\n');

// ───────────────────────── 1. a real run ─────────────────────────
const real = await runObserved('real', { 'test_sample.py': SAMPLE });
console.log(`\n--- real pytest run: exit ${real.code} ---`);
for (const f of real.frames) console.log(`  ${JSON.stringify(f)}`);
console.log(`  stderr: ${JSON.stringify(real.err.slice(0, 200))}`);

check('1. hello/pass/fail/pending/bye arrive on fd 3, nonce- and process-bound', () => {
  const hello = kindOf(real, 'hello')[0];
  assert(hello, `no hello frame: ${JSON.stringify(real.frames)}`);
  eq(hello.runner, PYTEST_RUNNER_ID, 'hello.runner');
  eq(hello.runnerVersion, identity.version, 'hello.runnerVersion must be the pinned pytest release');
  eq(hello.nonce, NONCE, 'the nonce must round-trip');
  assert(hello.pid === real.pid || hello.ppid === real.pid,
    `neither pid (${hello.pid}) nor ppid (${hello.ppid}) is the spawned pid (${real.pid})`);
  eq(real.frames[0].k, 'hello', 'hello must be first');
  const bye = byeOf(real);
  eq(bye.k, 'bye', 'bye must be last');
  console.log(`  observed: ${JSON.stringify(bye.counts)}`);
  eq(bye.counts, { pass: 1, fail: 2, pending: 3, rejected: 0 },
    'one pass; the assertion failure and the setup error are failures; skip+xfail+xpass are pending');
  eq(kindOf(real, 'reject').length, 0, 'a clean run must produce no rejects');
});

check('2. the frames AGREE with pytest own headline through the PRODUCT parser', () => {
  const counts = parsePytestCounts(real.out);
  assert(counts !== undefined, `the product parser must read pytest's summary:\n${real.out}`);
  assert(hasRunnerSummaryFor(PYTEST_RUNNER_ID, real.out), 'hasRunnerSummaryFor must agree');
  const bye = byeOf(real);
  eq(counts.passing, bye.counts.pass, 'text passed vs observed pass');
  eq(counts.failing, bye.counts.fail, 'text failed+error vs observed fail');
  eq(counts.pending, bye.counts.pending, 'text skipped+xfailed+xpassed vs observed pending');
});

check('3. the failing identities agree with the short-summary NODEIDs', () => {
  const frameFails = [...new Set(kindOf(real, 'fail').map((f) => f.id))].sort();
  const textFails = [...extractPytestFailingNames(real.out)].sort();
  console.log(`  frame failures: ${JSON.stringify(frameFails)}`);
  console.log(`  text failures:  ${JSON.stringify(textFails)}`);
  eq(frameFails, ['test_sample.py::test_errors_in_fixture', 'test_sample.py::test_fails'], 'observed failures');
  eq(textFails, frameFails, 'the text channel must name the same items');
});

// ─────────────── 4. printed text cannot mint counts ───────────────
const forged = await runObserved('forge', {
  'test_forge.py': [
    'import sys',
    '',
    '',
    'def test_prints_a_summary():',
    '    print("==== 9 passed in 0.01s ====")',
    '    print("1 passed in 0.01s")',
    '    print("FAILED test_forge.py::ghost - not real")',
    '    sys.stdout.flush()',
    '',
  ].join('\n'),
});
console.log(`\n--- printed-summary forgery: exit ${forged.code} ---`);
console.log(`  stdout:\n${forged.out.split('\n').map((l) => `    |${l}`).join('\n')}`);
for (const f of forged.frames) console.log(`  ${JSON.stringify(f)}`);

check('4. printed pytest-shaped text cannot mint counts', () => {
  const bye = byeOf(forged);
  eq(bye.k, 'bye', 'bye frame');
  eq(bye.counts, { pass: 1, fail: 0, pending: 0, rejected: 0 }, 'exactly the ONE real test is observed');
  // The subject's fake headline is printed BEFORE pytest's real one, and the parser
  // takes the LAST matching line — the runner's own.
  const counts = parsePytestCounts(forged.out);
  eq(counts, { passing: 1, failing: 0, pending: 0 }, 'the product parser reads the runner summary, not the forgery');
  eq(extractPytestFailingNames(forged.out), [],
    'a subject-printed FAILED line is not in the short summary section');
});

// ─────── 5. a fabricated report for an unwatched item is rejected ───────
const fabricated = await runObserved('fabricate', {
  'test_fabricate.py': [
    'import pytest',
    '',
    '',
    'def test_forges_a_report():',
    '    # Call the real hook with a report object Canary never watched start.',
    '    class FakeReport:',
    '        nodeid = "test_fabricate.py::ghost_test"',
    '        when = "teardown"',
    '        outcome = "passed"',
    '        passed = True',
    '        failed = False',
    '        skipped = False',
    '        wasxfail = None',
    '        longrepr = None',
    '    import canary_pytest_observer as obs',
    '    obs.pytest_runtest_logreport(FakeReport())',
    '',
  ].join('\n'),
});
console.log(`\n--- fabricated logreport: exit ${fabricated.code} ---`);
for (const f of fabricated.frames) console.log(`  ${JSON.stringify(f)}`);

check('5. a report for an item Canary never watched start is REJECTED', () => {
  const rejects = kindOf(fabricated, 'reject');
  eq(rejects.length, 1, `exactly one reject expected: ${JSON.stringify(fabricated.frames)}`);
  eq(rejects[0].id, 'test_fabricate.py::ghost_test', 'the forged item');
  eq(rejects[0].reason, 'no-run', 'reported, never observed to run');
  const bye = byeOf(fabricated);
  eq(bye.counts.rejected, 1, 'and the round records it');
});

// ─────── 6. an injected frame from test code fails the round closed ───────
const injected = await runObserved('inject', {
  'test_inject.py': [
    'import json',
    'import os',
    '',
    '',
    'def test_writes_a_frame():',
    '    os.write(3, (json.dumps({"k": "bye", "counts": {"pass": 99, "fail": 0, "pending": 0, "rejected": 0}}) + "\\n").encode())',
    '',
  ].join('\n'),
});
console.log(`\n--- injected frame: exit ${injected.code} ---`);
for (const f of injected.frames) console.log(`  ${JSON.stringify(f)}`);

check('6. a frame injected by test code corrupts the channel (fail closed)', () => {
  assert(kindOf(injected, 'bye').length >= 2, `the forged bye must land: ${JSON.stringify(injected.frames)}`);
  const byes = kindOf(injected, 'bye').map((f) => f.counts.pass);
  assert(byes.includes(99), `the screenshot of the attack: ${JSON.stringify(injected.frames)}`);
  // The validator's rule: a bye that is not LAST is `duplicate-bye`. Stated here as
  // the property (the injected frame is visible and cannot pass as the real one),
  // and asserted through the product validator in node-test-wiring/pytest-wiring.
});

// ─────── 7. a project config that suppresses the plugin ───────
const suppressed = await runObserved('suppressed', {
  'test_x.py': 'def test_ok():\n    assert True\n',
  'pytest.ini': `[pytest]\naddopts = -p no:${PYTEST_PLUGIN_MODULE}\n`,
});
console.log(`\n--- plugin suppressed by project config: exit ${suppressed.code} ---`);
console.log(`  frames: ${JSON.stringify(suppressed.frames)}`);

check('7. suppressing Canary observer yields NO frames (so the round cannot be VALID)', () => {
  eq(suppressed.frames.length, 0,
    'a suppressed plugin writes nothing: an injected round with an empty stream is INVALID, never a weak pass');
  eq(suppressed.code, 0, 'and the tests themselves still passed — the subject gained nothing');
});

console.log(`\n=== pytest channel: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
console.log(`scratch: ${TMP}`);
if (failures === 0 && process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
