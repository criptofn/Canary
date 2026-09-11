/**
 * The PYTEST observation channel through the REAL executor round path (v1.1).
 *
 * The channel was proven standalone first (tooling/probes/runner-observation-pytest.mjs,
 * which also records the measured hook/phase/headline shapes the plugin and the text
 * parser depend on). This file proves the WIRING: a real pytest project run through
 * `Recorder.expandArgvWithPlan` + `Recorder.round` produces a VALID
 * `ExecutionObservation` on the same path that feeds verdicts.
 *
 * The trust difference from `node --test`, stated because it drives the tests below:
 * a pytest installation is NOT the runtime Canary is executing on, so the identity
 * pin must come from an authority — and in the product it comes from the operator's
 * sealed setup plan (apps/cli/src/runner-authority.ts). Here the grant is the
 * in-process test seam, so these tests exercise the CHANNEL and the fail-closed
 * behaviour of a missing or wrong authority.
 *
 *   1. a real project -> VALID observation -> counts agree with pytest's headline
 *   2. identity + nonce are RE-DERIVABLE (prove replays a real validation)
 *   3. without a grant the round is ABSENT; a WRONG identity is refused
 *   4. an explicit suppression token is refused (the injection point stays closed)
 *   5. printed pytest-shaped text cannot mint counts
 *   6. a fabricated phase report is rejected live -> INCONCLUSIVE
 *   7. a frame injected by test code fails the round closed (pytest runs tests
 *      in its OWN process, so this door is real)
 *   8. the observer door adds ONLY Canary-owned variables
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Recorder, isPytestObserverSuppressionToken, observerNonce, pytestRunnerIdentity } from '../src/index.js';
import { sanitizedEnv, sanitizedEnvKeys } from '@canary-rn/support';
import { classify, type RoundFact } from '@canary-rn/classification';

/** The workspace-local pytest interpreter (gitignored `_toolchains/py`), or null. */
function findPytestPython(): string | null {
  const env = process.env['CANARY_PYTEST_PYTHON'];
  if (env !== undefined && fs.existsSync(env)) return env;
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    const rel = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
    const candidate = path.join(dir, '_toolchains', 'py', ...rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const PY = findPytestPython();
const SKIP = PY === null
  ? 'no workspace-local pytest interpreter (create _toolchains/py and pip install pytest, or set CANARY_PYTEST_PYTHON)'
  : false;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pytest-wiring-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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
/**
 * The interpreter is named ABSOLUTELY, and that is the real-world shape too: pytest
 * lives in a project's (or Canary's) virtual environment, so a spec names that
 * venv's interpreter. `SPEC_LITERAL_EXECUTABLES` allows an absolute path whose
 * basename is a python, and the pin is then measured on exactly those bytes.
 * A bare `python` would resolve through PATH to whatever interpreter the host
 * happens to list first — which need not be the one with pytest installed.
 */
const PYTEST_ARGS = [PY!, '-m', 'pytest', '-q'];

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
].join('\n');

/** Both arms carry the same observation, so only the observation decides. */
function classifyWith(fact: RoundFact): { classification: string } {
  return classify([
    { ...fact, arm: 'baseline', round: 1 },
    { ...fact, arm: 'candidate', round: 1 },
    { ...fact, arm: 'baseline', round: 2 },
    { ...fact, arm: 'candidate', round: 2 },
  ]);
}

describe('pytest observation through the executor round path', { skip: SKIP }, () => {
  it('1. a real project run yields a VALID observation whose categories AGREE with pytest', async () => {
    const ws = workspace('real', { 'test_sample.py': SAMPLE });
    const identity = pytestRunnerIdentity(PY!);
    assert.ok(identity !== null, 'the pytest installation identity must resolve');
    const rec = recorder(ws, { pytest: identity });
    const { argv, plan } = rec.expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin);

    assert.equal(plan.injected, true, `expected injection: ${JSON.stringify(plan)}`);
    assert.equal(plan.runner, 'pytest');
    assert.equal(plan.expectedRunnerVersion, identity.version, 'the pin is the pytest RELEASE');
    assert.equal(plan.expectedRunnerIdentitySha256, identity.identitySha256, 'and its installed source tree');
    assert.equal(argv[0], PY, 'the interpreter must be pinned ABSOLUTE for the sanitized spawn');
    assert.deepEqual(argv.slice(1), ['-m', 'pytest', '-q'], 'pytest injects through the environment, not argv');

    const round = await rec.round('baseline', 1, argv, 600, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'VALID', `expected VALID, got ${o.status}: ${o.invalidReason ?? ''}`);
    assert.equal(o.runner, 'pytest');
    assert.equal(o.observedRunnerVersion, identity.version);
    assert.deepEqual(o.observedCounts, { passing: 1, failing: 1, pending: 2 },
      'one pass; the assertion failure; skip and xfail outside pytest own passed count');
    assert.deepEqual(o.observedFailingIdentities, ['test_sample.py::test_fails']);
    assert.equal(round.fact.hasRunnerSummary, true);
    assert.equal(round.fact.reportedPassing, 1);
    assert.equal(round.fact.reportedFailing, 1);
    assert.equal(round.fact.reportedPending, 2);

    // A CLEAN pytest project must be able to reach a strong label — that is the
    // whole point of the channel. (The failing run above is VALID evidence, but a
    // failing arm does not classify as PASS, and the classifier's own guards are
    // what decide that — so reachability is shown on a clean project, not asserted
    // from a hand-edited fact.)
    const clean = workspace('real-clean', { 'test_sample.py': 'def test_ok():\n    assert True\n' });
    const cleanRec = recorder(clean, { pytest: identity });
    const cleanEx = cleanRec.expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin);
    const cleanRound = await cleanRec.round('candidate', 1, cleanEx.argv, 600, cleanEx.plan);
    assert.equal(cleanRound.fact.executionObservation!.status, 'VALID',
      `a clean run must observe VALID: ${cleanRound.fact.executionObservation!.invalidReason ?? ''}`);
    assert.deepEqual(cleanRound.fact.executionObservation!.observedCounts, { passing: 1, failing: 0, pending: 0 });
    assert.equal(classifyWith(cleanRound.fact).classification, 'PASS',
      'a VALID pytest observation on both arms must reach PASS instead of INCONCLUSIVE');
  });

  it('2. the identity and nonce are RE-DERIVABLE, so prove replays a real validation', async () => {
    const ws = workspace('rederive', { 'test_sample.py': 'def test_ok():\n    assert True\n' });
    const identity = pytestRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { pytest: identity });
    const first = rec.expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin);
    const second = rec.expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin);
    assert.deepEqual(second.plan, first.plan, 're-expansion must reproduce the plan (structural parity)');
    assert.deepEqual(second.argv, first.argv, 'and the argv');
    assert.equal(observerNonce('pytest', ws.fixture, 'baseline', 1), observerNonce('pytest', ws.fixture, 'baseline', 1));
    assert.notEqual(observerNonce('pytest', ws.fixture, 'baseline', 1), observerNonce('pytest', ws.fixture, 'candidate', 1));
    const round = await rec.round('baseline', 1, first.argv, 600, first.plan);
    assert.equal(round.fact.executionObservation!.status, 'VALID',
      `re-derived round must validate: ${round.fact.executionObservation!.invalidReason ?? ''}`);
  });

  it('3. without a grant the round is ABSENT; a WRONG identity is refused with the digest recorded', () => {
    const ws = workspace('nogrant', { 'test_sample.py': 'def test_ok():\n    assert True\n' });
    const identity = pytestRunnerIdentity(PY!);
    assert.ok(identity !== null);

    const noGrant = recorder(ws).expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin).plan;
    assert.equal(noGrant.injected, false);
    assert.equal(noGrant.absentKind, 'runner-identity-unpinned');

    const wrong = recorder(ws, { pytest: { version: identity.version, identitySha256: 'f'.repeat(64) } })
      .expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin).plan;
    assert.equal(wrong.injected, false, 'a digest that does not match the installation must not authorize');
    assert.equal(wrong.observedRunnerIdentitySha256, identity.identitySha256,
      '"what bytes were there" is a Canary-derived fact regardless of trust');

    // A rename of the release (same bytes, different version claim) is refused too.
    const wrongVersion = recorder(ws, { pytest: { version: '0.0.0', identitySha256: identity.identitySha256 } })
      .expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin).plan;
    assert.equal(wrongVersion.injected, false, 'the version is part of the pin');
  });

  it('4. an explicit plugin-suppression token is refused, not left to fail later', () => {
    const ws = workspace('suppress', { 'test_sample.py': 'def test_ok():\n    assert True\n' });
    const identity = pytestRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { pytest: identity });
    for (const token of ['-p', 'no:canary_pytest_observer', '-pno:canary_pytest_observer']) {
      if (token === '-p' || token === '-pno:canary_pytest_observer') {
        assert.equal(isPytestObserverSuppressionToken(token), token === '-pno:canary_pytest_observer',
          `${token}: only the token that NAMES the observer is a suppression`);
        continue;
      }
      assert.equal(isPytestObserverSuppressionToken(token), true, `${token} must be recognized`);
      assert.throws(
        () => rec.expandArgvWithPlan([PY!, '-m', 'pytest', token], subs, resolveBin),
        /observer-suppression|disables Canary's observer plugin/,
        `a suppression token (${token}) must be refused`,
      );
    }
    // An unrelated -p is left alone: over-rejection would break legitimate projects.
    assert.equal(isPytestObserverSuppressionToken('no:cacheprovider'), false);
    assert.doesNotThrow(() => rec.expandArgvWithPlan([PY!, '-m', 'pytest', '-p', 'no:cacheprovider'], subs, resolveBin));
  });

  it('5. printed pytest-shaped text cannot mint counts', async () => {
    const ws = workspace('forge', {
      'test_forge.py': [
        'def test_prints_a_summary():',
        '    print("==== 9 passed in 0.01s ====")',
        '    print("1 passed in 0.01s")',
        '',
      ].join('\n'),
    });
    const identity = pytestRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { pytest: identity });
    // No -q here: with capture off, the printed line reaches stdout where the
    // parser could be tempted by it.
    const { argv, plan } = rec.expandArgvWithPlan([PY!, '-m', 'pytest', '-s'], subs, resolveBin);
    const round = await rec.round('baseline', 1, argv, 600, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'VALID', `the real run IS valid: ${o.invalidReason ?? ''}`);
    assert.deepEqual(o.observedCounts, { passing: 1, failing: 0, pending: 0 },
      'the ONE real test is counted; the printed 9 is not');
    assert.equal(round.fact.reportedPassing, 1, 'and the text channel reads the runner summary, not the forgery');
  });

  it('6. a fabricated phase report is rejected live, and the verdict downgrades', async () => {
    const ws = workspace('fabricate', {
      'test_fabricate.py': [
        'def test_forges_a_report():',
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
    const identity = pytestRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { pytest: identity });
    const { argv, plan } = rec.expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin);
    const round = await rec.round('baseline', 1, argv, 600, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'INVALID', `a live reject must fail the round closed: ${JSON.stringify(o)}`);
    assert.equal(o.invalidReason, 'rejected-event');
    assert.equal(classifyWith(round.fact).classification, 'INCONCLUSIVE');
  });

  it('7. a frame injected by test code fails the round closed', async () => {
    const ws = workspace('inject', {
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
    const identity = pytestRunnerIdentity(PY!);
    assert.ok(identity !== null);
    const rec = recorder(ws, { pytest: identity });
    const { argv, plan } = rec.expandArgvWithPlan(PYTEST_ARGS, subs, resolveBin);
    const round = await rec.round('baseline', 1, argv, 600, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'INVALID', `an injected frame must fail the round closed: ${JSON.stringify(o)}`);
    assert.equal(o.invalidReason, 'duplicate-bye', 'a second bye is a protocol violation, not a count source');
    assert.notEqual(o.observedCounts?.passing, 99, 'a forged count may never be credited');
    assert.equal(classifyWith(round.fact).classification, 'INCONCLUSIVE');
  });

  it('8. the observer door adds ONLY Canary-owned variables (no env-merge)', () => {
    const ws = workspace('env', { 'test_sample.py': 'def test_ok():\n    assert True\n' });
    const obsDir = path.join(ws.root, 'canary-pytest-observer');
    fs.mkdirSync(obsDir, { recursive: true });
    const baseKeys = sanitizedEnvKeys(sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath) }));
    const withObserver = sanitizedEnvKeys(sanitizedEnv({
      ws, nodeDir: path.dirname(process.execPath),
      observer: { kind: 'pytest', dir: obsDir, nonce: 'n' },
    }));
    assert.deepEqual(withObserver.filter((k) => !baseKeys.includes(k)).sort(),
      ['CANARY_OBSERVER_NONCE', 'PYTEST_PLUGINS', 'PYTHONNOUSERSITE', 'PYTHONPATH'],
      'the pytest door may add exactly its own variables and nothing else');
  });
});
