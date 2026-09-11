/**
 * Provider-neutral observation validation (v1.1 Phase 2).
 *
 * The mocha channel's guarantees are pinned by attested-channel.test.ts and the
 * golden proof; this file pins the NEUTRAL branch that lets a non-package runner
 * (a stdlib test framework, a toolchain binary) be bound just as tightly — and,
 * just as importantly, pins that the neutral branch is not a softer door.
 *
 * The five properties the adapter contract must prove, each with a test that
 * FAILS if it stops being enforced:
 *   1. the expected runner ran            -> runner-mismatch
 *   2. the expected version ran            -> runnerVersion-vs-seal
 *   3. the expected tests actually executed-> recount vs bye + reject events
 *   4. the observation belongs to THIS spawn-> nonce + (pid or ppid)
 *   5. text alone cannot establish counts   -> *-vs-text, no-summary
 * plus: a neutral round with no stated requirement is REFUSED outright, because
 * "we observed something" is not a requirement.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateObservation, type ValidateInput } from '../src/observation.js';

const NONCE = 'round-nonce-abc';
const ID = 'a'.repeat(64);

/** A clean python-unittest stream: 2 passes, 1 pending. */
function pythonFrames(over: Record<string, unknown> = {}, body: unknown[] = [
  { k: 'pass', id: 't.A.test_one' },
  { k: 'pass', id: 't.A.test_two' },
  { k: 'pending', id: 't.A.test_skip' },
]): string {
  const hello = {
    k: 'hello', runner: 'python-unittest', runnerVersion: '3.11.9', pythonVersion: '3.11.9',
    pid: 4321, ppid: 1234, nonce: NONCE, observerVersion: 'canary-observer-v1', node: 'python-3.11.9',
    ...over,
  };
  const counts = { pass: 0, fail: 0, pending: 0, rejected: 0 };
  for (const f of body) {
    const kind = (f as { k: string }).k;
    if (kind === 'pass') counts.pass += 1;
    else if (kind === 'pending') counts.pending += 1;
    else if (kind === 'fail') counts.fail += 1;
  }
  return [hello, ...body, { k: 'bye', counts }].map((f) => JSON.stringify(f)).join('\n') + '\n';
}

function input(over: Partial<ValidateInput> = {}): ValidateInput {
  return {
    raw: pythonFrames(),
    injected: true,
    absentKind: 'no-injection',
    truncated: false,
    exitCode: 0,
    childPid: 1234,
    runner: 'python-unittest',
    expectedRunner: { id: 'python-unittest', version: '3.11.9', identitySha256: ID },
    expectedNonce: NONCE,
    observedRunnerIdentitySha256: ID,
    textCounts: { passing: 2, failing: 0, pending: 1 },
    hasSummary: true,
    textFailingNames: [],
    ...over,
  };
}

describe('neutral channel: a well-formed round is VALID and carries the identity', () => {
  it('binds runner, version and identity, and re-counts from the frames', () => {
    const o = validateObservation(input());
    assert.equal(o.status, 'VALID', `expected VALID, got ${o.status}: ${o.invalidReason ?? ''}`);
    assert.equal(o.runner, 'python-unittest');
    assert.equal(o.observedRunnerVersion, '3.11.9');
    assert.equal(o.expectedRunnerVersion, '3.11.9');
    assert.equal(o.observedRunnerIdentitySha256, ID);
    assert.deepEqual(o.observedCounts, { passing: 2, failing: 0, pending: 1 });
    assert.equal(o.runner === undefined ? 'mocha-fields' : 'neutral-fields', 'neutral-fields',
      'a neutral round must not masquerade as the mocha channel');
  });

  it('accepts a child process (Windows virtualenv re-exec) via ppid', () => {
    // pid is the re-executed interpreter; ppid is what Canary spawned.
    const o = validateObservation(input({ raw: pythonFrames({ pid: 9999, ppid: 1234 }) }));
    assert.equal(o.status, 'VALID', `ppid binding must be accepted: ${o.invalidReason ?? ''}`);
  });
});

describe('neutral channel: every required property is enforced', () => {
  it('1. the required runner must be the runner that reported', () => {
    const o = validateObservation(input({ raw: pythonFrames({ runner: 'jest' }) }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'runner-mismatch');
  });

  it('1b. a round that states NO requirement is refused (not merely weak)', () => {
    const o = validateObservation(input({ expectedRunner: undefined }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'runner-requirement-missing');
  });

  it('2. the required version must match what the observer reported', () => {
    const o = validateObservation(input({ raw: pythonFrames({ runnerVersion: '3.10.0' }) }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'runnerVersion-vs-seal');
  });

  it('3. bye.counts may not replace what Canary re-counted', () => {
    const raw = pythonFrames({}, [{ k: 'pass', id: 't.A.test_one' }])
      // bye claims 3 passes for one watched pass
      .replace(/"counts":\{[^}]*\}/, '"counts":{"pass":3,"fail":0,"pending":0,"rejected":0}');
    const o = validateObservation(input({ raw, textCounts: { passing: 1, failing: 0, pending: 0 } }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'bye-vs-recount');
  });

  it('3b. a live reject (a result for a test never watched run) fails the round closed', () => {
    const body = [{ k: 'pass', id: 't.A.test_one' }, { k: 'reject', ev: 'pass', id: 't.A.forged', reason: 'no-run' }];
    const o = validateObservation(input({ raw: pythonFrames({}, body), textCounts: { passing: 1, failing: 0, pending: 0 } }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'rejected-event');
  });

  it('4. the per-round nonce must round-trip', () => {
    const o = validateObservation(input({ raw: pythonFrames({ nonce: 'another-round' }) }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'nonce-mismatch');
  });

  it('4b. neither pid nor ppid belonging to this spawn is refused', () => {
    const o = validateObservation(input({ raw: pythonFrames({ pid: 9999, ppid: 8888 }) }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'pid-mismatch');
  });

  it('5. printed text alone cannot establish counts', () => {
    // The frames watched execute nothing; the text claims a green run.
    const raw = pythonFrames({}, []);
    const o = validateObservation(input({ raw, textCounts: { passing: 3, failing: 0, pending: 0 } }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'passing-vs-text');
  });

  it('5b. no summary text at all is refused, even with a clean frame stream', () => {
    const o = validateObservation(input({ hasSummary: false }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'no-summary');
  });

  it('identity drift between what Canary hashed and what is required is refused', () => {
    const o = validateObservation(input({ observedRunnerIdentitySha256: 'b'.repeat(64) }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'runner-identity-drift');
  });

  it('an exit code contradicting the watched lifecycle is refused in both directions', () => {
    assert.equal(validateObservation(input({ exitCode: 3 })).invalidReason, 'exit-contradiction-nonzero');
    const failing = validateObservation(input({
      raw: pythonFrames({}, [{ k: 'fail', id: 't.A.test_one', hook: false }]),
      exitCode: 0, textCounts: { passing: 0, failing: 1, pending: 0 }, textFailingNames: ['t.A.test_one'],
    }));
    assert.equal(failing.invalidReason, 'exit-contradiction-masked');
  });

  it('a killed round claims nothing about tests, so it is not an exit contradiction', () => {
    const o = validateObservation(input({ exitCode: -1 }));
    assert.equal(o.status, 'VALID', `-1 (killed) must be exempt by design: ${o.invalidReason ?? ''}`);
  });
});

describe('neutral channel: an un-attempted round is ABSENT, never a weak VALID', () => {
  it('ABSENT carries the absence reason and no counts', () => {
    const o = validateObservation(input({ injected: false, raw: '', absentKind: 'runner-identity-unpinned' }));
    assert.equal(o.status, 'ABSENT');
    assert.equal(o.absentKind, 'runner-identity-unpinned');
    assert.equal(o.observedCounts, undefined);
    assert.equal(o.runner, 'python-unittest', 'the channel identity is still recorded honestly');
  });

  it('stray bytes on an un-injected pipe are forensics, not an observation', () => {
    const o = validateObservation(input({ injected: false, raw: pythonFrames(), absentKind: 'no-injection' }));
    assert.equal(o.status, 'ABSENT');
    assert.equal(o.strayFd3Bytes, true);
    assert.equal(o.observedCounts, undefined);
  });
});

describe('the mocha channel keeps its own rules (no silent generalization)', () => {
  const mochaInput = (over: Partial<ValidateInput> = {}): ValidateInput => ({
    raw: [
      JSON.stringify({ k: 'hello', operatorVersion: 'x', mochaVersion: '10.8.2', node: 'v26.0.0', observerVersion: 'canary-observer-v1', pid: 42 }),
      JSON.stringify({ k: 'pass', id: 'a', file: 'a.js' }),
      JSON.stringify({ k: 'bye', counts: { pass: 1, fail: 0, pending: 0 } }),
    ].join('\n') + '\n',
    injected: true, absentKind: 'no-injection', truncated: false, exitCode: 0, childPid: 42,
    expectedMochaVersion: '10.8.2',
    textCounts: { passing: 1, failing: 0, pending: 0 }, hasSummary: true, textFailingNames: [],
    ...over,
  });

  it('a mocha round with no `runner` field validates on mocha\'s rules', () => {
    const o = validateObservation(mochaInput());
    assert.equal(o.status, 'VALID', `${o.invalidReason ?? ''}`);
    assert.equal(o.observedMochaVersion, '10.8.2');
    assert.equal(o.runner, undefined, 'the mocha channel must not gain neutral fields');
  });

  it('a broken mocha hello still reports the mocha-specific reason', () => {
    const raw = mochaInput().raw.replace('"mochaVersion":"10.8.2"', '"mochaVersion":""');
    const o = validateObservation(mochaInput({ raw }));
    assert.equal(o.status, 'INVALID');
    assert.equal(o.invalidReason, 'hello-mochaVersion');
  });
});
