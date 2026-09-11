/**
 * The Canary NODE:TEST REPORTER — the exact bytes Canary writes (byte-stable)
 * into its workspace and adds to a `node --test` invocation as a second reporter.
 *
 * WHY: strong observation must stop being functionally Mocha-only. `node --test`
 * is the Node runtime's own runner, so it needs no install, no package, and no
 * pin table — but its default output is TEXT, and text is a claim. This reporter
 * is Canary's own bytes loaded INSIDE the test-runner process, receiving the
 * runner's own lifecycle events, and writing NDJSON frames on fd 3 exactly like
 * the mocha and Python channels.
 *
 * HOW IT IS ADDED, and why that shape matters:
 *   node --test --test-reporter=tap --test-reporter-destination=stdout \
 *              --test-reporter=<this file> --test-reporter-destination=stderr
 * The TAP reporter still writes the ordinary text summary to STDOUT, so the
 * cross-channel agreement check compares Canary's frames against output Canary did
 * NOT produce. This reporter writes nothing to its own stream; its evidence goes
 * to fd 3, a pipe handed only to this child.
 *
 * EVERY RULE BELOW IS A MEASUREMENT, not a reading of the docs
 * (`tooling/probes/node-test-reporter-events.mjs` prints the raw stream; probe
 * results on node 26.7.0, single- AND multi-file):
 *  1. Reporter events carry `data.name` and `data.testId`; **`data.testName` does
 *     not exist**. An id derived from `testName` never matches a `test:start`, so
 *     every pass would be rejected as `no-run` — which is exactly what the first
 *     version of this file did, and why the probe exists.
 *  2. A SKIPPED or TODO test arrives as **`test:pass` carrying `skip:`/`todo:`**,
 *     not as `test:skip`/`test:todo` (those types were never emitted). Counting
 *     such an event as a pass makes the frames disagree with the runner's own
 *     `# pass N` / `# skipped N` and the round fails closed; it is counted as
 *     `pending` instead.
 *  3. `node --test <dir>` reports NO file-level start/pass/fail — only the tests
 *     (measured with 2 files, 4 tests, one failing). So no file-filtering
 *     heuristic is needed and none is invented.
 *  4. A parent suite whose child failed emits its OWN `test:fail`
 *     (`failureType: 'subtestsFailed'`) and the runner counts it in `# fail N`
 *     too, so counting it keeps the two channels in exact agreement.
 *  5. `test:start` precedes its `test:pass`/`test:fail`; `test:complete` arrives
 *     BEFORE `test:start` and is ignored.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT:
 *  1. Lifecycle ground truth is `test:start` + `test:pass`/`test:fail` TOGETHER: a
 *     pass for a test whose start Canary never watched is REJECTED (a `reject`
 *     frame fails the round closed). Printing is not executing.
 *  2. `hello` carries pid, ppid, node version, the observer version and the
 *     per-round nonce; the parent requires the nonce to round-trip and (pid or
 *     ppid) to be the process it spawned.
 *  3. NO secret is injected and the honest ceiling is unchanged: code inside the
 *     observed process can emulate these frames (documented residual). What is
 *     structurally dead is certifying execution from TEXT ALONE.
 *  4. fd 3 is closed exactly once, after `bye`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const NODE_TEST_REPORTER_BASENAME = 'canary-node-test-reporter.cjs';

/** `hello.runner` for this channel. */
export const NODE_TEST_RUNNER_ID = 'node-test';

/** Directory inside the workspace (outside artifacts) holding Canary's bytes. */
export const NODE_TEST_OBSERVER_DIRNAME = 'canary-node-observer';

/** The absolute path of Canary's reporter bytes for this workspace. */
export function nodeTestReporterPath(wsRoot: string): string {
  return path.join(wsRoot, NODE_TEST_OBSERVER_DIRNAME, NODE_TEST_REPORTER_BASENAME);
}

/**
 * The specifier Node must receive. MEASURED: Node loads `--test-reporter` as an
 * ES MODULE SPECIFIER, so a bare Windows path dies with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'c:'`. Only a `file://`
 * URL works — and it must be derived the same way at capture and re-derivation.
 */
export function nodeTestReporterUrl(wsRoot: string): string {
  return pathToFileURL(nodeTestReporterPath(wsRoot)).href;
}

/**
 * Write Canary's reporter bytes and prove the loaded bytes are Canary's — the
 * same write-if-different + read-back discipline as `ensureObserverPreload` and
 * `ensurePythonObserver`. Returns the directory (the observation door validates
 * that it lives inside the workspace).
 */
export function ensureNodeTestObserver(wsRoot: string): string {
  const dir = path.join(wsRoot, NODE_TEST_OBSERVER_DIRNAME);
  const p = path.join(dir, NODE_TEST_REPORTER_BASENAME);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.readFileSync(p, 'utf8') === NODE_TEST_REPORTER_SOURCE) return dir;
  } catch { /* absent: write below */ }
  fs.writeFileSync(p, NODE_TEST_REPORTER_SOURCE, 'utf8');
  if (fs.readFileSync(p, 'utf8') !== NODE_TEST_REPORTER_SOURCE) {
    throw new Error(`node:test reporter at ${p} does not match Canary's bytes even after rewrite (workspace is not writable-stable)`);
  }
  return dir;
}

/**
 * The identity of the `node --test` runner Canary is about to spawn.
 *
 * WHY THIS NEEDS NO OPERATOR GRANT, unlike a host Python interpreter (see
 * `pythonRunnerIdentity`): this runner is the Node runtime Canary is ITSELF
 * executing on. The spec names `node`; the sanitized PATH resolves it to
 * `dirname(process.execPath)` — the same binary — and expansion refuses anything
 * whose realpath is not `process.execPath`. There is therefore no "which
 * interpreter did the operator authorize?" question to answer: the observed
 * runner is byte-for-byte the verifying runtime, and a spec that points at a
 * different Node gets `runner-identity-unpinned` instead of a strong label.
 */
export function nodeRunnerIdentity(nodeExe: string): { version: string; identitySha256: string } {
  return {
    version: process.versions.node,
    identitySha256: crypto.createHash('sha256').update(fs.readFileSync(nodeExe)).digest('hex'),
  };
}

/** True iff `program` resolves to the same real file as the running Node. */
export function isCanaryOwnRuntime(program: string): boolean {
  try {
    return fs.realpathSync(program) === fs.realpathSync(process.execPath);
  } catch {
    return false;
  }
}

export const NODE_TEST_REPORTER_SOURCE = `'use strict';
// Canary node:test reporter. See packages/runner/executor/src/observers/node-test-reporter.ts
const { Transform } = require('node:stream');
const fs = require('node:fs');
const OBSERVER_VERSION = 'canary-observer-v1';
const RUNNER_ID = 'node-test';

const FD = 3;
let open = true;
function frame(o) {
  if (!open) return;
  try { fs.writeSync(FD, JSON.stringify(o) + '\\n'); }
  catch (e) { open = false; }
}
process.on('exit', function () {
  if (open) { try { fs.closeSync(FD); } catch (e) {} open = false; }
});

const counts = { pass: 0, fail: 0, pending: 0, rejected: 0 };
const started = new Set();
const passed = new Set();
const pended = new Set();
let helloed = false;

// idOf: MEASURED — reporter events carry data.name (and data.testId); data.testName
// does not exist on node 26. Prefer testName if a version ever supplies it, since
// then the leaf name is explicit, and fall back to name.
function idOf(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.testName === 'string' && data.testName !== '') return data.testName;
  if (typeof data.name === 'string' && data.name !== '') return data.name;
  return null;
}

// keyOf is the PAIRING key, and it is deliberately not the frame's id field: the
// id must be the test's name because that is what the runner's TAP text names, but
// two DIFFERENT tests in one file may legitimately share a leaf name (measured:
// t.test('shared') under two parents). Keying start/pass tracking on the name
// would report the second one as dup-pass and fail an honest round closed, so
// tracking uses the runner's own unique testId where it exists, with the name as
// the fallback for a version that omits it.
function keyOf(data, id) {
  if (data && typeof data === 'object' && (typeof data.testId === 'number' || typeof data.testId === 'string')) {
    return 'tid:' + String(data.testId);
  }
  return 'id:' + String(id);
}

// A pending (skipped/todo) test is reported through BOTH test:pass+flag and
// (historically) test:skip/test:todo, so counting is idempotent per identity:
// whichever event form a Node version uses, pending is counted once.
function markPending(id, key) {
  if (id === null) { counts.pending += 1; return; }
  if (pended.has(key)) return;
  pended.add(key);
  counts.pending += 1;
  frame({ k: 'pending', id: id });
}

module.exports = class CanaryNodeTestReporter extends Transform {
  constructor(options) {
    super(Object.assign({}, options, { writableObjectMode: true }));
    try {
      frame({
        k: 'hello',
        runner: RUNNER_ID,
        runnerVersion: process.versions.node,
        node: 'v' + process.versions.node,
        pid: process.pid,
        ppid: process.ppid,
        nonce: process.env.CANARY_OBSERVER_NONCE || '',
        observerVersion: OBSERVER_VERSION,
      });
      helloed = true;
    } catch (e) { frame({ k: 'adapter-error', err: String((e && e.message) || e) }); }
  }

  _transform(event, _enc, cb) {
    try {
      const type = event && event.type;
      const data = (event && event.data) || {};
      const id = idOf(data);
      const key = keyOf(data, id);
      // Only real TESTS are counted. A file's own scheduling events
      // (enqueue/dequeue/complete) and the plan/summary/diagnostic events carry no
      // test identity, and no file-level start/pass/fail is emitted at all
      // (measured, single- and multi-file).
      if (type === 'test:start') {
        if (id !== null) started.add(key);
      } else if (type === 'test:pass') {
        // MEASURED: a skipped or todo test arrives as a PASS carrying the flag.
        if (data.skip !== undefined || data.todo !== undefined) {
          markPending(id, key);
        } else if (id === null) {
          frame({ k: 'adapter-error', err: 'test:pass without an identity' });
        } else if (!started.has(key)) {
          counts.rejected += 1;
          frame({ k: 'reject', ev: 'pass', id: id, reason: 'no-run' });
        } else if (passed.has(key)) {
          counts.rejected += 1;
          frame({ k: 'reject', ev: 'pass', id: id, reason: 'dup-pass' });
        } else {
          passed.add(key);
          counts.pass += 1;
          frame({ k: 'pass', id: id, tid: data.testId, file: data.file });
        }
      } else if (type === 'test:fail') {
        if (id === null) {
          frame({ k: 'adapter-error', err: 'test:fail without an identity' });
        } else if (!started.has(key)) {
          counts.rejected += 1;
          frame({ k: 'reject', ev: 'fail', id: id, reason: 'no-run' });
        } else {
          counts.fail += 1;
          frame({ k: 'fail', id: id, hook: false, tid: data.testId, file: data.file });
        }
      } else if (type === 'test:skip' || type === 'test:todo') {
        markPending(id, key);
      }
    } catch (e) {
      frame({ k: 'adapter-error', err: String((e && e.message) || e) });
    }
    // Emit NOTHING: this reporter's destination is a discard, and its evidence is
    // fd 3. The ordinary TAP summary on stdout stays Canary-independent.
    cb();
  }

  _flush(cb) {
    try {
      if (helloed) frame({ k: 'bye', counts: counts });
    } catch (e) { /* exit handler closes */ }
    cb();
  }
};
`;
