/**
 * The failure payload's tests.
 *
 * The payload is a TOKEN-COST control, so "it is shorter" is not enough: it must still name the
 * failing check, still carry an actionable identity and detail line where the runner prints one,
 * and always point at the full log. Each of those is asserted here, plus the hard caps that stop
 * a pathological log from becoming a 40k-token message.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_TOTAL_CHARS,
  buildFailurePayload,
  extractDetailLines,
  extractFailureIdentities,
} from '../src/failure-payload.js';

const step = (over: Partial<Parameters<typeof buildFailurePayload>[0]['steps'][number]> = {}) => ({
  kind: 'tests',
  display: 'node run-tests.js',
  exitCode: 1,
  stdout: '',
  stderr: '',
  ...over,
});

describe('failure identities are read from the runners Canary supports', () => {
  it('TAP (node:test), mocha, pytest and a plain "file :: test" report', () => {
    assert.deepEqual(extractFailureIdentities('    not ok 1 - adds numbers\nok 2 - fine'), ['adds numbers']);
    assert.deepEqual(extractFailureIdentities('  1) suite\n     a failing title\n'), ['suite']);
    assert.deepEqual(extractFailureIdentities('FAILED tests/test_x.py::test_y - assert 1 == 2'), ['tests/test_x.py::test_y']);
    assert.deepEqual(extractFailureIdentities('numbers.test.js :: total includes negatives'), ['total includes negatives']);
  });

  it('caps the identities and does not repeat one', () => {
    const text = ['a.test.js :: one', 'a.test.js :: one', 'a.test.js :: two', 'a.test.js :: three', 'a.test.js :: four'].join('\n');
    assert.deepEqual(extractFailureIdentities(text), ['one', 'two', 'three']);
  });

  it('reads assertion-shaped detail lines and ignores stack frames', () => {
    const text = [
      'Expected values to be strictly equal:',
      '5 !== 0',
      '    at Object.<anonymous> (C:\\x\\y.js:3:1)',
      'Error: boom',
    ].join('\n');
    const lines = extractDetailLines(text);
    assert.ok(lines.some((l) => /5 !== 0/.test(l)), JSON.stringify(lines));
    assert.equal(lines.some((l) => /^\s*at /.test(l)), false, 'stack frames are not repair material');
  });
});

describe('the payload is compact, actionable and points at the full log', () => {
  it('names the check, the identity, the detail and the log path', () => {
    const message = buildFailurePayload({
      steps: [step({ stdout: 'Failures:\n  numbers.test.js :: total includes negative values\n    5 !== 0\n' })],
      writeLog: () => 'C:\\ws\\.canary\\evidence\\2026-checkpoint\\tests.log',
    });
    assert.match(message, /Canary verification failed: tests \(node run-tests\.js, exit 1\)/,
      'the phrase the existing contract test asserts on must survive');
    assert.match(message, /total includes negative values/);
    assert.match(message, /5 !== 0/);
    assert.match(message, /full output: C:\\ws\\\.canary/);
  });

  it('stays far below the payload it replaced (4000 chars of raw output)', () => {
    const noisy = `${'x'.repeat(200_000)}\n`;
    const message = buildFailurePayload({ steps: [step({ stdout: noisy, stderr: noisy })], writeLog: () => '/tmp/log' });
    assert.ok(message.length <= MAX_TOTAL_CHARS, `payload was ${message.length} chars`);
    assert.ok(message.length < 400, `a noisy failure should stay tiny, got ${message.length}`);
  });

  it('caps the number of checks it describes', () => {
    const steps = ['tests', 'build', 'lint', 'typecheck'].map((kind) => step({ kind, display: kind }));
    const message = buildFailurePayload({ steps, writeLog: () => '/tmp/log' });
    assert.match(message, /tests/);
    assert.doesNotMatch(message, /typecheck/, 'beyond the cap, later checks are not described');
  });

  it('says so honestly when the full log could not be stored', () => {
    const message = buildFailurePayload({ steps: [step()], writeLog: () => null });
    assert.match(message, /full output: unavailable \(evidence storage failed\)/);
  });

  it('is deterministic', () => {
    const input = { steps: [step({ stdout: 'Failures:\n  a.test.js :: one\n' })], writeLog: () => '/tmp/log' };
    assert.equal(buildFailurePayload(input), buildFailurePayload(input));
  });
});
