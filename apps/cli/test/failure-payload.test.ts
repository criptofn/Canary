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
  doctorCheckCommand,
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
  it('colored Vitest collection failures lead the details when a required build is missing', () => {
    const text = [
      'Error: expected caught failure from a passing control',
      '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/unit/cli/help-drift.test.ts\x1b[2m [ tests/unit/cli/help-drift.test.ts ]\x1b[22m',
      '\x1b[31m\x1b[1mError\x1b[22m: dist CLI not found. Run npm run build before npm test.\x1b[39m',
      '\x1b[36m \x1b[2m❯\x1b[22m tests/unit/cli/help-drift.test.ts:\x1b[2m37:9\x1b[22m\x1b[39m',
      ' FAIL tests/unit/failure-ids.test.ts > preserves params',
      'AssertionError: expected false to be true',
    ].join('\n');
    assert.deepEqual(extractFailureIdentities(text), ['tests/unit/cli/help-drift.test.ts [ tests/unit/cli/help-drift.test.ts ]', 'tests/unit/failure-ids.test.ts > preserves params']);
    assert.deepEqual(extractDetailLines(text), ['Error: dist CLI not found. Run npm run build before npm test.', '❯ tests/unit/cli/help-drift.test.ts:37:9']);
  });

  it('colored Vitest failures keep file, test identity and source location, without treating passing rows as failures', () => {
    const text = [
      ' \x1b[32m✓\x1b[39m tests/unit/passing.test.ts (1 test)',
      '\x1b[31mError: expected caught error in a passing test\x1b[39m',
      '\x1b[36m ❯ tests/unit/passing.test.ts:7:3\x1b[39m',
      '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/unit/failure-ids.test.ts\x1b[2m > \x1b[22mextractFailureIds\x1b[2m > \x1b[22mpreserves hyphenated params',
      '\x1b[31m\x1b[1mAssertionError\x1b[22m: expected false to be true // Object.is equality\x1b[39m',
      '\x1b[36m \x1b[2m❯\x1b[22m tests/unit/failure-ids.test.ts:\x1b[2m42:9\x1b[22m\x1b[39m',
    ].join('\n');
    assert.deepEqual(extractFailureIdentities(text), ['tests/unit/failure-ids.test.ts > extractFailureIds > preserves hyphenated params']);
    assert.deepEqual(extractDetailLines(text), ['AssertionError: expected false to be true // Object.is equality', '❯ tests/unit/failure-ids.test.ts:42:9']);
    let saved = '';
    const message = buildFailurePayload({ steps: [step({ stderr: text })], writeLog: (_name, raw) => { saved = raw; return '/tmp/failure.log'; } });
    assert.equal(saved, `\n${text}`, 'full runner output must retain its original bytes');
    assert.match(message, /failure-ids\.test\.ts > extractFailureIds > preserves hyphenated params/);
    assert.match(message, /failure-ids\.test\.ts:42:9/);
    assert.equal(message.includes('\x1b'), false, 'presentation must not contain terminal control sequences');
    assert.ok(message.length <= MAX_TOTAL_CHARS);
  });

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
  it('quotes unusual check ids as data for the host shell', () => {
    assert.equal(doctorCheckCommand('web app::test', 'win32'), "canary doctor --check 'web app::test'");
    assert.equal(doctorCheckCommand("web'$name::test", 'win32'), "canary doctor --check 'web''$name::test'");
    assert.equal(doctorCheckCommand("web'$name::test", 'linux'), "canary doctor --check 'web'\\''$name::test'");
    assert.equal(doctorCheckCommand('test', 'win32', 'node "C:\\Program Files\\Canary\\main.js"'), 'node "C:\\Program Files\\Canary\\main.js" doctor --check test');
  });
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

  it('keeps scoped failures distinct and includes the exact repair recheck', () => {
    const logs = new Map<string, string>();
    const steps = ['backend::test', 'frontend::test'].map((id) => ({
      ...step({ stdout: `Error: ${id} needs repair\n` }), id,
    }));
    const message = buildFailurePayload({ steps, writeLog: (name, text) => {
      logs.set(name, text); return `/tmp/${name}.log`;
    } });
    assert.equal(logs.size, 2, 'same-kind checks must not overwrite one another');
    for (const id of ['backend::test', 'frontend::test']) {
      assert.ok(message.includes(`canary doctor --check ${id}`), message);
      assert.ok([...logs.values()].some((text) => text.includes(id)));
    }
  });

  it('uses the hook installation path for repair commands instead of a global canary binary', () => {
    const prefix = 'node "C:\\Program Files\\Canary\\main.js"';
    const message = buildFailurePayload({
      steps: [step({ id: 'test', stderr: 'Error: assertion failed' })],
      doctorCommandPrefix: prefix,
      writeLog: () => 'C:\\repo\\.canary\\evidence\\tests.log',
    });
    assert.ok(message.includes(`${prefix} doctor --check test`), message);
    assert.ok(!message.includes('canary doctor --check test'), message);
  });

  it('never clips a log path or repair command to meet the payload limit', () => {
    const steps = ['tests', 'build', 'typecheck'].map((kind) => ({
      ...step({ kind, display: 'x'.repeat(500), stdout: 'Error: '.repeat(40) }), id: kind,
    }));
    const logPath = `/tmp/${'long-directory/'.repeat(35)}failure.log`;
    const message = buildFailurePayload({ steps, writeLog: () => logPath });
    assert.ok(message.length <= MAX_TOTAL_CHARS, `${message.length} chars`);
    assert.ok(message.includes(`full output: ${logPath}`), 'an intact path must remain available');
    assert.match(message, /canary doctor --check tests/);
    assert.match(message, /additional failing checks: 2/i);
  });

  it('refers to the evidence bundle when even one complete path cannot fit', () => {
    const message = buildFailurePayload({ steps: [step()], writeLog: () => '/tmp/' + 'x'.repeat(2000) });
    assert.ok(message.length <= MAX_TOTAL_CHARS);
    assert.match(message, /exceed the message limit/);
    assert.match(message, /canary result --json/);
    assert.doesNotMatch(message, /full output: \/tmp/);
  });
});
