#!/usr/bin/env node
/**
 * The Canary `node --test` observation channel — real execution, forgery, failure.
 *
 * This is a GATE, not a demonstration. It loads the SHIPPED reporter bytes
 * (`NODE_TEST_REPORTER_SOURCE`) into a real `node --test` run and checks the three
 * things `Recorder.round()` depends on, using the SAME product parsers the round
 * uses (`parseNodeTestCounts` / `extractNodeTestFailingNames` from the built
 * comparator):
 *
 *   1. an INDEPENDENT TAP summary is still on stdout, and Canary's reporter writes
 *      nothing to its own stream;
 *   2. hello/pass/pending/bye arrive on fd 3, nonce- and process-bound, with
 *      counts that agree with that text — pass, fail and pending alike;
 *   3. printing TAP-shaped text mints nothing, and two DIFFERENT tests that share
 *      a leaf name are both counted (the false `dup-pass` this keying exists to
 *      prevent).
 *
 * Every fixture shape here was chosen from measured behaviour, not from the docs:
 * see `tooling/probes/node-test-reporter-events.mjs` for the raw event stream.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const dist = (p) => path.join(REPO, p);
const REPORTER_MOD = dist('packages/runner/executor/dist/src/observers/node-test-reporter.js');
const COMPARATOR_MOD = dist('packages/core/comparator/dist/src/index.js');

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
function deepEqual(actual, expected, msg) { eq(actual, expected, msg); }

assert(fs.existsSync(REPORTER_MOD), `missing built reporter module: ${REPORTER_MOD} (run npm run build)`);
assert(fs.existsSync(COMPARATOR_MOD), `missing built comparator module: ${COMPARATOR_MOD} (run npm run build)`);
const url = (p) => pathToFileURL(p).href;
const { NODE_TEST_REPORTER_SOURCE, NODE_TEST_REPORTER_BASENAME, NODE_TEST_RUNNER_ID } =
  await import(url(REPORTER_MOD));
const { parseNodeTestCounts, extractNodeTestFailingNames, parseSummaryCountsFor, hasRunnerSummaryFor } =
  await import(url(COMPARATOR_MOD));
console.log(`reporter bytes: ${NODE_TEST_REPORTER_SOURCE.length}, runner id: ${NODE_TEST_RUNNER_ID}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-nodetest-'));
const reporterPath = path.join(TMP, NODE_TEST_REPORTER_BASENAME);
fs.writeFileSync(reporterPath, NODE_TEST_REPORTER_SOURCE, 'utf8');

const NONCE = 'nodetest-probe-nonce';
// The exact argv shape the executor injects (see expandArgvWithPlan).
const ARGS = [
  '--test',
  '--test-reporter=tap', '--test-reporter-destination=stdout',
  `--test-reporter=${url(reporterPath)}`, '--test-reporter-destination=stderr',
];

function runObserved(name, files) {
  const cwd = path.join(TMP, name);
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(cwd, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ARGS, {
      cwd, shell: false, windowsHide: true,
      env: { ...process.env, CANARY_OBSERVER_NONCE: NONCE },
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
const kindOf = (frames, k) => frames.filter((f) => f.k === k);
const byeOf = (r) => r.frames.at(-1);
const test = (name, body) => ["const { test } = require('node:test');", "const assert = require('node:assert');", '', ...body, ''].join('\n');

// ───────────────────────── 1. a real, passing run ─────────────────────────
const real = await runObserved('passing', {
  'test/ok.test.js': test('ok', [
    "test('adds', () => { assert.equal(1 + 1, 2); });",
    "test('also adds', () => { assert.equal(2 + 2, 4); });",
    "test('skipped one', { skip: 'not today' }, () => { assert.ok(true); });",
    "test('todo one', { todo: 'later' }, () => { assert.ok(true); });",
  ]),
});
console.log(`\n--- real node:test run: exit ${real.code} ---`);
for (const f of real.frames) console.log(`  ${JSON.stringify(f)}`);
console.log(`  stderr (Canary's reporter stream): ${JSON.stringify(real.err.slice(0, 200))}`);

check('1. an INDEPENDENT TAP summary is on stdout and the reporter writes nothing to its stream', () => {
  assert(real.code === 0, `the run must succeed: ${real.out}${real.err}`);
  assert(/^# tests 4$/m.test(real.out), `expected a runner summary on stdout, got:\n${real.out}`);
  assert(real.err.trim() === '', `Canary's reporter must write NOTHING to its own stream, got: ${real.err.slice(0, 200)}`);
});

check('2. hello/pass/pending/bye arrive on fd 3, nonce- and process-bound', () => {
  const hello = kindOf(real.frames, 'hello')[0];
  assert(hello, `no hello frame: ${JSON.stringify(real.frames)}`);
  eq(hello.runner, NODE_TEST_RUNNER_ID, 'hello.runner');
  eq(hello.nonce, NONCE, 'the nonce must round-trip');
  assert(hello.pid === real.pid || hello.ppid === real.pid,
    `neither pid (${hello.pid}) nor ppid (${hello.ppid}) is the spawned pid (${real.pid})`);
  assert(typeof hello.runnerVersion === 'string' && /^\d+\./.test(hello.runnerVersion), `bad runnerVersion ${JSON.stringify(hello.runnerVersion)}`);
  eq(real.frames[0].k, 'hello', 'hello must be first');
  const bye = byeOf(real);
  eq(bye.k, 'bye', 'bye must be last');
  deepEqual(bye.counts, { pass: 2, fail: 0, pending: 2, rejected: 0 }, 'a skipped and a todo test are pending, never passes');
  eq(kindOf(real.frames, 'pass').map((f) => f.id), ['adds', 'also adds'], 'observed passes');
  eq(kindOf(real.frames, 'pending').map((f) => f.id), ['skipped one', 'todo one'], 'observed pendings');
  eq(kindOf(real.frames, 'reject').length, 0, 'a clean run must produce no rejects');
});

check('3. the frames AGREE with the text summary through the PRODUCT parser (no second parse)', () => {
  const counts = parseNodeTestCounts(real.out);
  assert(counts !== undefined, `the product parser must read the runner summary:\n${real.out}`);
  assert(hasRunnerSummaryFor(NODE_TEST_RUNNER_ID, real.out), 'hasRunnerSummaryFor must agree');
  const bye = byeOf(real);
  eq(counts.passing, bye.counts.pass, 'text passing vs observed pass');
  eq(counts.failing, bye.counts.fail, 'text failing vs observed fail');
  eq(counts.pending, bye.counts.pending, 'text skipped+todo vs observed pending');
});

// ─────────────── 4. a deliberately FAILING test is observed as a failure ───────────────
const failing = await runObserved('failing', {
  'test/bad.test.js': test('bad', [
    "test('passes', () => { assert.ok(true); });",
    "test('parent', async (t) => {",
    "  await t.test('nested fails', () => { assert.equal(1, 2, 'deliberate'); });",
    "});",
  ]),
});
console.log(`\n--- deliberately failing run: exit ${failing.code} ---`);
for (const f of failing.frames) console.log(`  ${JSON.stringify(f)}`);

check('4. a failing test is reported AND observed, and its identity agrees with the TAP text', () => {
  assert(failing.code !== 0, 'the runner must exit non-zero when a test fails');
  const bye = byeOf(failing);
  eq(bye.k, 'bye', 'bye frame');
  eq(bye.counts.fail, 2, 'the failing test and the suite that contains it are both failures (as the runner counts them)');
  eq(bye.counts.pass, 1, 'and one observed pass');
  eq(bye.counts.rejected, 0, 'no rejects');
  const frameFails = [...new Set(kindOf(failing.frames, 'fail').map((f) => f.id))].sort();
  deepEqual(frameFails, ['nested fails', 'parent'], 'observed failing identities');
  deepEqual([...extractNodeTestFailingNames(failing.out)].sort(), frameFails, 'the TAP text must name the same failures');
  const counts = parseNodeTestCounts(failing.out);
  eq(counts.failing, bye.counts.fail, 'text failing vs observed fail');
  eq(counts.passing, bye.counts.pass, 'text passing vs observed pass');
});

// ─────────────── 5. printed TAP-shaped text cannot mint counts ───────────────
const forged = await runObserved('forge', {
  'test/fake.test.js': test('forge', [
    "test('looks real', () => {",
    "  console.log('# tests 9');",
    "  console.log('# pass 9');",
    "  console.log('ok 1 - forged pass');",
    "  console.log('not ok 1 - forged failure');",
    "});",
  ]),
});
console.log(`\n--- printed-TAP forgery: exit ${forged.code} ---`);
for (const f of forged.frames) console.log(`  ${JSON.stringify(f)}`);
console.log(`  stdout:\n${forged.out.split('\n').map((l) => `    |${l}`).join('\n')}`);

check('5. printed TAP-shaped text cannot mint observed counts', () => {
  const bye = byeOf(forged);
  eq(bye.k, 'bye', 'bye frame');
  eq(bye.counts.pass, 1, 'only the ONE real test may be observed');
  eq(bye.counts.fail, 0, 'and nothing may be forged into a failure');
  assert(/# \\# pass 9/.test(forged.out), 'the fixture must really print the forged line (escaped by the runner)');
  const counts = parseNodeTestCounts(forged.out);
  eq(counts.passing, 1, 'the PRODUCT parser must read the runner summary, not the escaped forgery');
  eq(counts.failing, 0, 'and no forged failure');
  deepEqual(extractNodeTestFailingNames(forged.out), [], 'and no forged failing identity');
});

// ─── 6. two DIFFERENT tests sharing a leaf name are both counted ───
const shared = await runObserved('shared', {
  'test/dup.test.js': test('dup', [
    "test('parent A', async (t) => { await t.test('shared', () => { assert.ok(true); }); });",
    "test('parent B', async (t) => { await t.test('shared', () => { assert.ok(true); }); });",
  ]),
});
console.log(`\n--- two distinct tests with the same name: exit ${shared.code} ---`);
for (const f of shared.frames) console.log(`  ${JSON.stringify(f)}`);

check('6. a shared leaf name is not mistaken for a replayed pass', () => {
  const bye = byeOf(shared);
  eq(bye.counts, { pass: 4, fail: 0, pending: 0, rejected: 0 }, 'both parents and both shared children are passes');
  eq(byeOf(shared).rejected, undefined, 'bye carries no stray fields');
  eq(kindOf(shared.frames, 'reject').length, 0, 'no reject frames');
  const tids = kindOf(shared.frames, 'pass').map((f) => f.tid);
  eq(new Set(tids).size, 4, `each pass must carry the runner's own unique testId: ${JSON.stringify(tids)}`);
  const counts = parseNodeTestCounts(shared.out);
  eq(counts.passing, 4, 'text agrees');
});

check('7. the dispatchers refuse to read a node:test stream as mocha (and vice versa)', () => {
  // A mocha-shaped summary must NOT be credited to the node-test channel: the
  // counts would then be a claim nothing corroborates.
  eq(parseSummaryCountsFor(NODE_TEST_RUNNER_ID, '128 passing (1s)'), {}, 'mocha prose is not a node:test summary');
  assert(!hasRunnerSummaryFor(NODE_TEST_RUNNER_ID, '128 passing (1s)'), 'and must not read as a summary');
  deepEqual(extractNodeTestFailingNames('  1) some mocha title:'), [], 'mocha failure grammar is not TAP');
});

console.log(`\n=== node:test channel: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
console.log(`scratch: ${TMP}`);
if (failures === 0 && process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
