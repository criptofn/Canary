/**
 * The `node --test` observation channel through the REAL executor round path (v1.1).
 *
 * The channel was proven standalone first
 * (tooling/probes/runner-observation-node-test.mjs, which also records the measured
 * event surface the reporter depends on). This file proves the WIRING, which is a
 * different claim: that a real Node project run through
 * `Recorder.expandArgvWithPlan` + `Recorder.round` produces a VALID
 * `ExecutionObservation` on the same path that feeds verdicts.
 *
 * What makes this channel different from the Python one, and why there is no
 * authorization grant here: the runner IS the Node runtime Canary is executing on.
 * `node` resolves through the sanitized PATH to `dirname(process.execPath)`, and
 * expansion refuses any program whose realpath is not that file — so "the observed
 * runner" and "the verifying runtime" are the same bytes by construction, and a
 * spec that points at a foreign Node gets ABSENT instead of a strong label.
 *
 * Every property has a test that fails if it stops holding:
 *   1. a real project -> VALID observation -> counts agree with the runner's TAP
 *   2. the identity is Canary's OWN runtime, and re-expansion is byte-identical
 *      (so prove's replay is a real re-validation)
 *   3. a FOREIGN node binary is refused, never weakly credited
 *   4. a subject-supplied --test-reporter is refused (the reporter set stays closed)
 *   5. printed TAP-shaped text cannot mint counts
 *   6. frames injected onto fd 3 by the subject fail the round closed
 *   7. an absent observation routes the verdict to INCONCLUSIVE
 *   8. the observer door adds ONLY Canary-owned variables for this channel
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  Recorder, detectNodeTestRunner, isCanaryOwnRuntime, isNodeReporterToken,
  nodeRunnerIdentity, nodeTestReporterPath, observerNonce, NODE_TEST_RUNNER_ID,
} from '../src/index.js';
import { sanitizedEnv, sanitizedEnvKeys } from '@canary-rn/support';
import { classify, type RoundFact } from '@canary-rn/classification';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-nodetest-wiring-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A workspace whose fixture is a real Node project. */
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

function recorder(ws: { root: string; fixture: string }): Recorder {
  return new Recorder({
    ws,
    nodeDir: path.dirname(process.execPath),
    npmCli: path.join(path.dirname(process.execPath), 'npm-cli.js'),
    artifactsDir: ws.root,
    pipeline: [],
  });
}
const subs = { dep: 'unused', baseline: 'b', candidate: 'c' };
const resolveBin = (): string => { throw new Error('no $bin resolution in these tests'); };
// `node --test` with NO positional: MEASURED on this runtime, a directory argument
// is loaded as a MODULE (`node --test test/` dies in the CJS loader), so the
// runner's own discovery is what a Node project spec must use. Recorded in
// tooling/probes/node-test-reporter-events.mjs.
const NODE_TEST_ARGS = ['node', '--test'];

const passing = (name: string, id: string): string => [
  "const { test } = require('node:test');",
  "const assert = require('node:assert');",
  '',
  `test('${name} one', () => { assert.equal(1, 1); });`,
  `test('${name} two', () => { assert.ok(true); });`,
  `test('${name} skipped', { skip: 'not today' }, () => {});`,
  `test('${name} todo', { todo: 'later' }, () => {});`,
  '',
].join('\n');

const PASSING = { 'test/ok.test.js': passing('ok', 'ok') };

/** Both arms carry the same observation, so only the observation decides. */
function classifyWith(fact: RoundFact): { classification: string } {
  return classify([
    { ...fact, arm: 'baseline', round: 1 },
    { ...fact, arm: 'candidate', round: 1 },
    { ...fact, arm: 'baseline', round: 2 },
    { ...fact, arm: 'candidate', round: 2 },
  ]);
}

describe('node:test observation through the executor round path', () => {
  it('1. a real project run yields a VALID observation whose counts AGREE with the runner TAP', async () => {
    const ws = workspace('real', PASSING);
    const rec = recorder(ws);
    const { argv, plan } = rec.expandArgvWithPlan(NODE_TEST_ARGS, subs, resolveBin);

    assert.equal(plan.injected, true, `expected injection: ${JSON.stringify(plan)}`);
    assert.equal(plan.runner, NODE_TEST_RUNNER_ID);
    assert.equal(plan.expectedRunnerVersion, process.versions.node, 'the observed runner is the verifying runtime');
    const own = nodeRunnerIdentity(process.execPath);
    assert.equal(plan.expectedRunnerIdentitySha256, own.identitySha256);
    assert.equal(plan.observedRunnerIdentitySha256, own.identitySha256);
    assert.equal(plan.expectedRunnerIdentitySha256, plan.observedRunnerIdentitySha256);
    // The sealed argv carries both reporters: the ordinary TAP one Canary did NOT
    // produce, and Canary's own bytes by file URL (a bare Windows path would die
    // with ERR_UNSUPPORTED_ESM_URL_SCHEME — measured). They sit in the OPTION
    // region, before the spec's test path: Node stops reading its own options at
    // the first positional, so a suffix injection loads no reporter at all.
    assert.equal(argv[0], process.execPath, 'the runner must be pinned to Canary own Node');
    assert.equal(argv[1], '--test-reporter=tap');
    assert.equal(argv[2], '--test-reporter-destination=stdout');
    assert.equal(argv[3], `--test-reporter=${pathToFileURL(nodeTestReporterPath(ws.root)).href}`,
      'the reporter must be injected as a file URL, not a bare Windows path');
    assert.equal(argv[4], '--test-reporter-destination=stderr');
    assert.deepEqual(argv.slice(5), ['--test'], 'the spec own argv must be untouched and last');

    const round = await rec.round('baseline', 1, argv, 300, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'VALID', `expected VALID, got ${o.status}: ${o.invalidReason ?? ''}`);
    assert.equal(o.runner, NODE_TEST_RUNNER_ID);
    assert.equal(o.observedRunnerVersion, process.versions.node);
    assert.deepEqual(o.observedCounts, { passing: 2, failing: 0, pending: 2 },
      'a skipped and a todo test are pending, never passes');
    assert.equal(round.fact.hasRunnerSummary, true);
    assert.equal(round.fact.reportedPassing, 2);
    assert.equal(round.fact.reportedPending, 2);
    // The point of the whole channel: a strong label is now REACHABLE for a
    // node:test project instead of being structurally impossible.
    assert.equal(classifyWith(round.fact).classification, 'PASS',
      'a VALID node:test observation on both arms must be able to reach PASS');
  });

  it('2. the plan and argv are RE-DERIVABLE, so prove replays a real validation', async () => {
    const ws = workspace('rederive', PASSING);
    const rec = recorder(ws);
    const first = rec.expandArgvWithPlan(NODE_TEST_ARGS, subs, resolveBin);
    const second = rec.expandArgvWithPlan(NODE_TEST_ARGS, subs, resolveBin);
    assert.deepEqual(second.plan, first.plan, 're-expansion must produce an identical plan (structural parity)');
    assert.deepEqual(second.argv, first.argv, 'and an identical argv, reporter URL included');
    assert.equal(
      observerNonce(NODE_TEST_RUNNER_ID, ws.fixture, 'baseline', 1),
      observerNonce(NODE_TEST_RUNNER_ID, ws.fixture, 'baseline', 1),
      'the nonce is a pure function of (runner, fixture, arm, round)',
    );
    assert.notEqual(
      observerNonce(NODE_TEST_RUNNER_ID, ws.fixture, 'baseline', 1),
      observerNonce(NODE_TEST_RUNNER_ID, ws.fixture, 'candidate', 1),
      'the nonce binds the frames to THIS round',
    );
    const round = await rec.round('baseline', 1, first.argv, 300, first.plan);
    assert.equal(round.fact.executionObservation!.status, 'VALID');
  });

  it('3. a FOREIGN node binary is refused — ABSENT, never weakly credited', () => {
    const ws = workspace('foreign', PASSING);
    // A file that is called node.exe and is not the running runtime. Nothing
    // identifies a runner as Canary's own runtime except the bytes and the path.
    const foreign = path.join(TMP, 'foreign-node', 'node.exe');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, 'not a node runtime\n');
    assert.equal(isCanaryOwnRuntime(foreign), false, 'a different file is not Canary own runtime');

    const rec = recorder(ws);
    const { argv, plan } = rec.expandArgvWithPlan([foreign, '--test', 'test/'], subs, resolveBin);
    assert.equal(plan.injected, false, `a foreign runtime must not be injected: ${JSON.stringify(plan)}`);
    assert.equal(plan.absentKind, 'runner-identity-unpinned');
    assert.equal(plan.runner, undefined);
    assert.equal(argv.includes('--test-reporter=tap'), false, 'and nothing of Canary reporter may be added');
  });

  it('4. a subject-supplied test-reporter is refused (the reporter set stays closed)', () => {
    const ws = workspace('subjectreporter', PASSING);
    const rec = recorder(ws);
    for (const token of ['--test-reporter=dot', '--test-reporter', '--test-reporter-destination=stdout']) {
      assert.equal(isNodeReporterToken(token), true, `${token} must be recognized`);
      assert.throws(
        () => rec.expandArgvWithPlan(['node', '--test', token, 'test/'], subs, resolveBin),
        /subject-reporter-refused|test-reporter option/,
        `a subject reporter token (${token}) must be refused, not parsed`,
      );
    }
    assert.equal(isNodeReporterToken('--test-name-pattern=x'), false, 'unrelated flags are untouched');
  });

  it('5. printed TAP-shaped text cannot mint observation counts', async () => {
    const ws = workspace('forge', {
      'test/fake.test.js': [
        "const { test } = require('node:test');",
        "test('looks real', () => {",
        "  console.log('# tests 9');",
        "  console.log('# pass 9');",
        "  console.log('not ok 1 - forged failure');",
        "});",
        '',
      ].join('\n'),
    });
    const rec = recorder(ws);
    const { argv, plan } = rec.expandArgvWithPlan(NODE_TEST_ARGS, subs, resolveBin);
    const round = await rec.round('baseline', 1, argv, 300, plan);
    const o = round.fact.executionObservation!;
    assert.equal(o.status, 'VALID', `the real run IS valid: ${o.invalidReason ?? ''}`);
    assert.deepEqual(o.observedCounts, { passing: 1, failing: 0, pending: 0 },
      'the ONE real test is counted; the printed 9 is not');
    assert.deepEqual(o.observedFailingIdentities, [], 'and no forged failing identity appears');
  });

  it('6. a subject cannot reach Canary fd 3 — or, if it can, the round fails closed', async () => {
    const ws = workspace('inject', {
      'test/inject.test.js': [
        "const { test } = require('node:test');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "test('tries to forge an observation frame', () => {",
        "  let outcome = 'wrote';",
        "  try {",
        "    fs.writeSync(3, JSON.stringify({ k: 'bye', counts: { pass: 99, fail: 0, pending: 0, rejected: 0 } }) + '\\n');",
        "  } catch (e) { outcome = String(e.code || e.message); }",
        "  fs.writeFileSync(path.join(__dirname, 'injection-attempt.txt'), outcome);",
        "});",
        '',
      ].join('\n'),
    });
    const rec = recorder(ws);
    const { argv, plan } = rec.expandArgvWithPlan(NODE_TEST_ARGS, subs, resolveBin);
    const round = await rec.round('baseline', 1, argv, 300, plan);
    const o = round.fact.executionObservation!;

    // The attempt really happened: the test wrote down what it observed.
    const marker = path.join(ws.fixture, 'test', 'injection-attempt.txt');
    assert.ok(fs.existsSync(marker), 'the fixture must have attempted the injection');
    const outcome = fs.readFileSync(marker, 'utf8').trim();
    console.log(`     measured: the subject's write to fd 3 returned ${JSON.stringify(outcome)}`);

    // MEASURED ASYMMETRY with the Python channel, and a favourable one: `node --test`
    // runs each test FILE in its own child process, while Canary's reporter lives in
    // the `node --test` parent that owns fd 3. Test code therefore has no handle on
    // the observation pipe (the write fails with EBADF here). The Python observer
    // hooks the same process the tests run in, which is why that channel carries a
    // live in-process emulation risk this one structurally does not.
    if (outcome === 'wrote') {
      // A host where the pipe IS reachable must not be able to credit the frame.
      assert.equal(o.status, 'INVALID', `an injected frame must fail the round closed: ${JSON.stringify(o)}`);
      assert.equal(o.invalidReason, 'duplicate-bye', 'a second bye is a protocol violation, not a count source');
      assert.notEqual(o.observedCounts?.passing, 99, 'a forged count may never be credited');
    } else {
      assert.match(outcome, /EBADF|EINVAL|EPERM|ENOENT/, `expected a refusal from the OS, got ${JSON.stringify(outcome)}`);
      assert.equal(o.status, 'VALID', `the honest run is still valid: ${o.invalidReason ?? ''}`);
      assert.deepEqual(o.observedCounts, { passing: 1, failing: 0, pending: 0 },
        'the forged 99 may not appear, and the one real test must still be counted');
    }
    // Either way, the predicate that matters holds: nothing was credited from a frame
    // the subject wrote.
    assert.notEqual(o.observedCounts?.passing, 99);
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
    const obsDir = path.join(ws.root, 'canary-node-observer');
    fs.mkdirSync(obsDir, { recursive: true });
    const baseKeys = sanitizedEnvKeys(sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath) }));
    const withObserver = sanitizedEnvKeys(sanitizedEnv({
      ws, nodeDir: path.dirname(process.execPath),
      observer: { kind: 'node', dir: obsDir, nonce: 'n' },
    }));
    assert.deepEqual(withObserver.filter((k) => !baseKeys.includes(k)).sort(), ['CANARY_OBSERVER_NONCE'],
      'the node channel adds exactly its nonce binding and nothing else');
    // The door's containment rule is channel-independent: bytes outside the
    // workspace are still refused.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-outside-'));
    assert.throws(
      () => sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath), observer: { kind: 'node', dir: outside, nonce: 'n' } }),
      /must live inside Canary's workspace root/,
    );
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('node:test runner detection is narrow', () => {
  it('only an EXECUTED node running --test is a runner', () => {
    assert.deepEqual(detectNodeTestRunner(['node', '--test', 'test/']), { runner: 'node-test', node: 'node' });
    assert.deepEqual(detectNodeTestRunner(['node.exe', '--test-only', 'test/']), { runner: 'node-test', node: 'node.exe' });
    assert.equal(detectNodeTestRunner(['node', 'script.js']), null, 'plain script execution is not the test runner');
    assert.equal(detectNodeTestRunner(['mocha', '--test']), null, 'the runtime must be the executed program');
    assert.equal(detectNodeTestRunner(['python', '-m', 'unittest']), null);
    // A `--test` token that Node does NOT read as a runner flag (here it is argv to
    // an -e script) still selects the channel, and that is SAFE rather than lucky:
    // the injected reporter then never loads, no frames reach fd 3, and an injected
    // round with an empty stream is INVALID (fail closed) — never a weak VALID.
    assert.deepEqual(detectNodeTestRunner(['node', '-e', 'x', '--test']), { runner: 'node-test', node: 'node' });
  });
});
