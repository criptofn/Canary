/**
 * The Python observation channel through the REAL executor round path (v1.1).
 *
 * The channel was proven standalone first (tooling/probes/runner-observation-python.mjs).
 * This file proves the WIRING, which is a different claim: that a real Python
 * project run through `Recorder.expandArgvWithPlan` + `Recorder.round` produces a
 * VALID `ExecutionObservation` on the same path that feeds verdicts, with the
 * runner identity, the per-round nonce and the process binding all intact — and
 * that printed output still cannot mint one.
 *
 * Each property has a test that fails if it stops holding:
 *   1. real tests -> observed counts -> agreement with the interpreter's summary
 *   2. the runner identity is required (version + digest of the interpreter bytes)
 *   3. without an authorization grant the round is ABSENT, never weak-VALID
 *   4. the nonce round-trips and is RE-DERIVABLE (so prove's replay is a real
 *      re-validation rather than a restatement)
 *   5. stdout forgery yields no counts
 *   6. a fabricated `addSuccess` is rejected live and the verdict downgrades
 *   7. an absent observation routes the verdict to INCONCLUSIVE
 *   8. the observer door adds ONLY Canary-owned variables (no env-merge)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Recorder, pythonRunnerIdentity, detectPythonRunner, observerNonce } from '../src/index.js';
import { sanitizedEnv, sanitizedEnvKeys } from '@canary-rn/support';
import { classify, type RoundFact } from '@canary-rn/classification';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-python-wiring-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function whichPython(): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'sh',
    process.platform === 'win32' ? ['python.exe'] : ['-c', 'command -v python3 || command -v python'],
    { encoding: 'utf8', timeout: 20_000 });
  return (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
}
const PY = whichPython();

// `-s tests` so discovery starts INSIDE the tests directory: a bare `discover`
// only recurses into an importable package, so a layout with no `__init__.py`
// would find ZERO tests and silently "pass" — exactly the empty-run-is-not-a-pass
// trap the counts agreement exists to expose. (This test caught that itself.)
const CANARY_ARGS = ['python', '-m', 'unittest', 'discover', '-v', '-s', 'tests'];

/** A workspace whose fixture is a real Python project. */
function workspace(name: string, files: Record<string, string>): { root: string; fixture: string } {
  const root = path.join(TMP, name);
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(fixture, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return { root, fixture };
}

function recorder(
  ws: { root: string; fixture: string },
  runnerIdentities?: Record<string, { version: string; identitySha256: string }>,
): Recorder {
  return new Recorder({
    ws,
    nodeDir: path.dirname(process.execPath),
    npmCli: path.join(path.dirname(process.execPath), 'npm-cli.js'),
    artifactsDir: ws.root,
    pipeline: [],
    ...(runnerIdentities !== undefined ? { runnerIdentities } : {}),
  });
}
const subs = { dep: 'unused', baseline: 'b', candidate: 'c' };
const resolveBin = (): string => { throw new Error('no $bin resolution in these tests'); };

const PASSING = {
  'tests/test_ok.py': [
    'import unittest',
    '',
    'class Passing(unittest.TestCase):',
    '    def test_one(self): self.assertTrue(True)',
    '    def test_two(self): self.assertEqual(1, 1)',
    '    @unittest.skip("not today")',
    '    def test_skipped(self): pass',
    '',
  ].join('\n'),
};

/** Minimal classifier harness: both arms carry the same observation, so the only
 *  thing that can decide the verdict is the observation itself. */
function classifyWith(fact: RoundFact): { classification: string } {
  return classify([
    { ...fact, arm: 'baseline', round: 1 },
    { ...fact, arm: 'candidate', round: 1 },
    { ...fact, arm: 'baseline', round: 2 },
    { ...fact, arm: 'candidate', round: 2 },
  ]);
}

describe('Python observation through the executor round path', { skip: PY === null ? 'no python on PATH' : false }, () => {
  it('1. a real project run yields observed counts that AGREE with the interpreter summary', async () => {
    const ws = workspace('real', PASSING);
    const identity = pythonRunnerIdentity(PY!);
    assert.ok(identity !== null, 'the interpreter identity must resolve');
    const rec = recorder(ws, { 'python-unittest': identity });
    const { argv, plan } = rec.expandArgvWithPlan(CANARY_ARGS, subs, resolveBin);

    assert.equal(plan.injected, true, `expected injection: ${JSON.stringify(plan)}`);
    assert.equal(plan.runner, 'python-unittest');
    assert.equal(plan.expectedRunnerVersion, identity.version);
    assert.equal(plan.expectedRunnerIdentitySha256, identity.identitySha256);
    assert.ok(path.isAbsolute(argv[0]!), `the interpreter must be pinned ABSOLUTE so the sanitized spawn can run it: ${argv[0]}`);

    const round = await rec.round('baseline', 1, argv, 300, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'VALID', `expected VALID, got ${o.status}: ${o.invalidReason ?? ''}`);
    assert.equal(o.runner, 'python-unittest');
    assert.equal(o.observedRunnerVersion, identity.version);
    assert.deepEqual(o.observedCounts, { passing: 2, failing: 0, pending: 1 });
    // The executor's text facts come from the CHANNEL-AWARE parser, and the
    // validator has already required them to agree with the frames.
    assert.equal(round.fact.hasRunnerSummary, true);
    assert.equal(round.fact.reportedPassing, 2);
    assert.equal(round.fact.reportedPending, 1);
  });

  it('2/4. the identity and the nonce are RE-DERIVABLE, so prove replays a real validation', async () => {
    const ws = workspace('rederive', PASSING);
    const identity = pythonRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { 'python-unittest': identity });
    const first = rec.expandArgvWithPlan(CANARY_ARGS, subs, resolveBin);
    const second = rec.expandArgvWithPlan(CANARY_ARGS, subs, resolveBin);
    assert.deepEqual(second.plan, first.plan, 're-expansion from the same inputs must produce an identical plan (structural parity)');
    assert.deepEqual(second.argv, first.argv, 'and an identical argv');
    assert.equal(
      observerNonce('python-unittest', ws.fixture, 'baseline', 1),
      observerNonce('python-unittest', ws.fixture, 'baseline', 1),
      'the nonce must be a pure function of (runner, fixture, arm, round), so prove needs nothing recorded',
    );
    assert.notEqual(
      observerNonce('python-unittest', ws.fixture, 'baseline', 1),
      observerNonce('python-unittest', ws.fixture, 'candidate', 1),
      'the nonce must differ across arms — it binds the frames to THIS round',
    );
    const round = await rec.round('baseline', 1, first.argv, 300, first.plan);
    assert.equal(round.fact.executionObservation!.status, 'VALID');
  });

  it('3. without an authorization grant the round is ABSENT — never a weak VALID', () => {
    const ws = workspace('nogrant', PASSING);
    const rec = recorder(ws); // no runnerIdentities: no authority
    const { plan } = rec.expandArgvWithPlan(CANARY_ARGS, subs, resolveBin);
    assert.equal(plan.injected, false);
    assert.equal(plan.absentKind, 'runner-identity-unpinned');
  });

  it('3b. a WRONG identity (same version, different bytes) is refused, and the OBSERVED digest is still recorded', () => {
    const ws = workspace('wrongid', PASSING);
    const identity = pythonRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { 'python-unittest': { version: identity.version, identitySha256: 'f'.repeat(64) } });
    const { plan } = rec.expandArgvWithPlan(CANARY_ARGS, subs, resolveBin);
    assert.equal(plan.injected, false, 'a digest that does not match the interpreter on disk must not authorize');
    assert.equal(plan.absentKind, 'runner-identity-unpinned');
    assert.equal(plan.observedRunnerIdentitySha256, identity.identitySha256,
      '"what bytes were there" is a Canary-derived fact regardless of trust');
  });

  it('5. printed stdout cannot mint observation counts', async () => {
    const ws = workspace('forge', {
      'fake.py': 'print("Ran 3 tests in 0.001s")\nprint("")\nprint("OK")\n',
    });
    const identity = pythonRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { 'python-unittest': identity });
    const { argv, plan } = rec.expandArgvWithPlan(['python', '-m', 'unittest', 'fake.py'], subs, resolveBin);
    const round = await rec.round('baseline', 1, argv, 300, plan);
    const o = round.fact.executionObservation!;
    assert.notEqual(o.status, 'VALID', `printed text must not produce a VALID observation: ${JSON.stringify(o)}`);
    assert.equal(o.observedCounts?.passing ?? 0, 0, 'no pass may be observed');
  });

  it('6. a FABRICATED unittest callback is rejected live, and the verdict downgrades', async () => {
    const ws = workspace('fabricate', {
      'tests/test_fake.py': [
        'import unittest',
        'r = unittest.TestResult()',
        '',
        'class T:',
        '    def id(self): return "forged.suite.forged"',
        '    def __str__(self): return "forged"',
        '',
        'class Fake(unittest.TestCase):',
        '    def test_forge(self):',
        '        r.addSuccess(T())   # reported, never started',
        '',
      ].join('\n'),
    });
    const identity = pythonRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { 'python-unittest': identity });
    const { argv, plan } = rec.expandArgvWithPlan(CANARY_ARGS, subs, resolveBin);
    const round = await rec.round('baseline', 1, argv, 300, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'INVALID', `a live reject must fail the round closed: ${JSON.stringify(o)}`);
    assert.equal(o.invalidReason, 'rejected-event');
    assert.equal(classifyWith(round.fact).classification, 'INCONCLUSIVE');
  });

  it('7. an absent observation routes the verdict to INCONCLUSIVE (strong labels unreachable)', () => {
    const absentFact: RoundFact = {
      executionObservation: {
        status: 'ABSENT', absentKind: 'runner-identity-unpinned',
        framesSha256: '', frameCount: 0, observedFailingIdentities: [],
      },
      arm: 'baseline', round: 1, exitCode: 0, hasRunnerSummary: true, infraSignal: false,
      reportedPassing: 3, reportedFailing: 0, reportedPending: 0, failingTestNames: [],
    };
    const c = classifyWith(absentFact);
    assert.equal(c.classification, 'INCONCLUSIVE', `an unobserved run must not reach a strong label: ${JSON.stringify(c)}`);
  });

  it('8. the observer door adds ONLY Canary-owned variables (no env-merge)', () => {
    const ws = workspace('env', PASSING);
    const obsDir = path.join(ws.root, 'obs');
    fs.mkdirSync(obsDir, { recursive: true });
    const baseKeys = sanitizedEnvKeys(sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath) }));
    const withObserver = sanitizedEnvKeys(sanitizedEnv({
      ws, nodeDir: path.dirname(process.execPath),
      observer: { kind: 'python', dir: obsDir, nonce: 'n' },
    }));
    const added = withObserver.filter((k) => !baseKeys.includes(k)).sort();
    assert.deepEqual(added, ['CANARY_OBSERVER_NONCE', 'PYTHONNOUSERSITE', 'PYTHONPATH'],
      'the observer door may add exactly its own variables and nothing else');
  });
});

describe('runner detection is narrow', () => {
  it('only an EXECUTED python running a known test module is a runner', () => {
    assert.deepEqual(detectPythonRunner(['python', '-m', 'unittest', 'discover']), { runner: 'python-unittest', python: 'python' });
    assert.deepEqual(detectPythonRunner(['python', '-m', 'pytest']), { runner: 'pytest', python: 'python' },
      'pytest IS recognized as a Python runner id; whether its channel earns a strong label is a separate question');
    assert.equal(detectPythonRunner(['python', 'script.py']), null);
    assert.equal(detectPythonRunner(['node', '-e', 'x', 'python', '-m', 'unittest']), null, 'a non-executed mention is not a runner');
  });
});
