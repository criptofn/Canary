/**
 * POST-GLM PANEL K — THE TEN DEDICATED EXECUTION-AUTHORITY TESTS.
 *
 * The design panel enumerated the attacks a hostile producer can run against
 * the attested-execution channel itself. Each test below locks ONE of them:
 *
 *  (i)  plain-node text stub that reads as a clean run  -> INCONCLUSIVE rule 14
 *  (ii) injected round whose channel carries ZERO frames -> INVALID
 *  (iii) missing / misplaced bye frame                   -> INVALID
 *  (iv) reject frame (adapter caught a forged event live) -> INVALID
 *  (v)  text claims "2 passing" but 1 was watched        -> INVALID
 *  (vi) forged hello.mochaVersion                        -> INVALID
 *  (vii) stray fd-3 bytes from an UNPINNED double        -> ABSENT + anomaly, never credited
 *  (viii) double CLAIMING a pinned version, wrong bytes  -> ABSENT (AM-1 kill test)
 *  (ix)  subject tries its own --require in spec argv    -> refusal (InfraAbort)
 *  (x)  process.exit() mid-round (no bye can be written) -> INVALID, never strong
 *
 * Two layers, deliberately:
 *  - (ii)-(vi) drive the SHARED validator (validateObservation — the same one
 *    capture, the prove floor, and verifyClassificationDerivation all use)
 *    with hand-built frame streams. A real pipeline run cannot produce a
 *    clean pinned double emitting zero frames, so the honest home for
 *    hostile-STREAM tests is the validator itself.
 *  - (i), (vii)-(x) run the REAL pipeline offline: the authority decision
 *    must hold at the end-to-end level, not only in unit isolation.
 *
 * Fail-closed direction for every test: strong labels unreachable; the
 * weaker-or-equal rule means no assertion here may ever be satisfied by a
 * forgery CREDITING anything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runExperiment, InfraAbort } from '../src/pipeline.js';
import { validateObservation, OBSERVER_VERSION, type ValidateInput } from '@canary-rn/executor';
import { KNOWN_RUNNER_RELEASES } from '@canary-rn/support';
import { sha256hex } from '@canary-rn/hashing';
import {
  writeStagedPayload, stageCommands, MOCHA_TEST_ARGV, widgetSpec, swapScript,
  WIDGET_PKGS, STAGING_REL, DOUBLE_VERSION, assertDoubleObservation,
} from './stub-harness.js';
import type { EvidenceBundle } from '@canary-rn/evidence-schema';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-attest-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FAKE_SHA = 'a'.repeat(40);
const FAKE_BYTES = Buffer.from('canary-attest-fake-tarball');
const FAKE_BLOB = { bytes: FAKE_BYTES, sha256: sha256hex(FAKE_BYTES) };
const STRONG = new Set(['PASS', 'CONFIRMED_REGRESSION', 'PRE_EXISTING_FAILURE']);

const DOUBLE_PIN = (KNOWN_RUNNER_RELEASES.mocha ?? []).find((p) => p.origin === 'canary-double');
assert.ok(DOUBLE_PIN, 'the canary-double pin must exist for these tests to mean anything');

// ───────────────────────────────────────────────────────────────────────────
// LAYER 1 — the shared validator under hostile frame streams (ii)-(vi).
// ───────────────────────────────────────────────────────────────────────────

const CHILD_PID = 4242;
const hello = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ k: 'hello', pid: CHILD_PID, mochaVersion: DOUBLE_VERSION, observerVersion: OBSERVER_VERSION, node: 'v26.3.0', ...over });
const pass = (id: string): Record<string, unknown> => ({ k: 'pass', id, file: 'test.js' });
const fail = (id: string, hook?: boolean): Record<string, unknown> => (hook ? { k: 'fail', id, file: 'test.js', hook: true } : { k: 'fail', id, file: 'test.js' });
const bye = (c: { pass: number; fail: number; pending: number }): Record<string, unknown> => ({ k: 'bye', counts: c });
const stream = (frames: readonly Record<string, unknown>[]): string =>
  frames.map((f) => JSON.stringify(f)).join('\n') + '\n';

function baseInput(over: Partial<ValidateInput>): ValidateInput {
  return {
    raw: '', injected: true, absentKind: 'no-injection', truncated: false,
    exitCode: 0, childPid: CHILD_PID,
    expectedMochaVersion: DOUBLE_PIN!.version,
    expectedRunnerTreeSha256: DOUBLE_PIN!.treeSha256,
    observedRunnerTreeSha256: DOUBLE_PIN!.treeSha256,
    textCounts: { passing: 1 }, hasSummary: true, textFailingNames: [],
    ...over,
  };
}

describe('panel K layer 1 — the validator refuses hostile frame streams', () => {
  it('CONTROL: an honest watched lifecycle validates VALID (the battery needs a standing baseline)', () => {
    const obs = validateObservation(baseInput({
      raw: stream([hello(), pass('s > a'), fail('s > b'), bye({ pass: 1, fail: 1, pending: 0 })]),
      exitCode: 1,
      textCounts: { passing: 1, failing: 1 },
      textFailingNames: ['s > b'],
    }));
    assert.equal(obs.status, 'VALID', obs.invalidReason);
    assert.deepEqual(obs.observedCounts, { passing: 1, failing: 1, pending: 0 });
    assert.deepEqual(obs.observedFailingIdentities, ['s > b']);
    assert.equal(obs.frameCount, 4);
  });

  it('(ii) injected round with ZERO frames on the channel is INVALID', () => {
    const obs = validateObservation(baseInput({ raw: '' }));
    assert.equal(obs.status, 'INVALID');
    assert.equal(obs.invalidReason, 'empty-stream');
    assert.equal(obs.frameCount, 0);
  });

  it('(iii) a missing bye — and a misplaced bye — are INVALID boundary violations', () => {
    const missing = validateObservation(baseInput({
      raw: stream([hello(), pass('a'), pass('b'), { k: 'pass', id: 'c', file: 'x' }]),
      textCounts: { passing: 3 },
    }));
    assert.equal(missing.status, 'INVALID');
    assert.equal(missing.invalidReason, 'hello-bye-boundary');
    const misplaced = validateObservation(baseInput({
      raw: stream([hello(), bye({ pass: 1, fail: 0, pending: 0 }), pass('a'), pass('b')]),
      textCounts: { passing: 2 },
    }));
    assert.equal(misplaced.status, 'INVALID');
    assert.equal(misplaced.invalidReason, 'hello-bye-boundary'); // last frame is not bye
    const doubled = validateObservation(baseInput({
      raw: stream([hello(), pass('a'), bye({ pass: 1, fail: 0, pending: 0 }), pass('b'), bye({ pass: 2, fail: 0, pending: 0 })]),
      textCounts: { passing: 2 },
    }));
    assert.equal(doubled.invalidReason, 'duplicate-bye');
  });

  it('(iv) a reject frame (adapter caught a forged/dup event LIVE) condemns the round', () => {
    const obs = validateObservation(baseInput({
      raw: stream([hello(), pass('a'), pass('b'), { k: 'reject', id: 'b', why: 'never-run' }, bye({ pass: 2, fail: 0, pending: 0 })]),
      textCounts: { passing: 2 },
    }));
    assert.equal(obs.status, 'INVALID');
    assert.equal(obs.invalidReason, 'rejected-event');
    // The reject itself may carry perfect counts — evidence of an ATTACK,
    // not of execution. Nothing is credited.
    assert.deepEqual(obs.observedFailingIdentities, []);
  });

  it('(v) text claiming "2 passing" over 1 watched pass is INVALID — and a lying bye cannot fix it', () => {
    const lying = validateObservation(baseInput({
      raw: stream([hello(), pass('a'), bye({ pass: 1, fail: 0, pending: 0 })]),
      textCounts: { passing: 2 },
    }));
    assert.equal(lying.status, 'INVALID');
    assert.equal(lying.invalidReason, 'passing-vs-text');
    const lying2 = validateObservation(baseInput({
      raw: stream([hello(), pass('a'), bye({ pass: 2, fail: 0, pending: 0 })]),
      textCounts: { passing: 2 },
    }));
    assert.equal(lying2.invalidReason, 'bye-vs-recount'); // the producer cannot certify ITSELF via bye either
  });

  it('(vi) a forged hello.mochaVersion is INVALID — vs the pin and vs its own shape', () => {
    const gold = validateObservation(baseInput({
      raw: stream([hello({ mochaVersion: '10.8.2' }), pass('a'), bye({ pass: 1, fail: 0, pending: 0 })]),
      textCounts: { passing: 1 },
    }));
    assert.equal(gold.status, 'INVALID');
    assert.equal(gold.invalidReason, 'mochaVersion-vs-pin'); // names a REAL release; not what we pinned+launched
    const shape = validateObservation(baseInput({
      raw: stream([hello({ mochaVersion: '9' }), pass('a'), bye({ pass: 1, fail: 0, pending: 0 })]),
      textCounts: { passing: 1 },
    }));
    assert.equal(shape.invalidReason, 'hello-mochaVersion');
    // The binding siblings, pinned in the same breath (spawn + observer identity):
    const pid = validateObservation(baseInput({
      raw: stream([hello({ pid: 1 }), pass('a'), bye({ pass: 1, fail: 0, pending: 0 })]),
      textCounts: { passing: 1 },
    }));
    assert.equal(pid.invalidReason, 'pid-mismatch');
    const ov = validateObservation(baseInput({
      raw: stream([hello({ observerVersion: 'not-canary' }), pass('a'), bye({ pass: 1, fail: 0, pending: 0 })]),
      textCounts: { passing: 1 },
    }));
    assert.equal(ov.invalidReason, 'observerVersion-mismatch');
  });

  it('panel 1 extras: flood truncation, duplicate credits, unknown kinds and no-summary all fail closed', () => {
    const good = [hello(), pass('a'), bye({ pass: 1, fail: 0, pending: 0 })];
    assert.equal(validateObservation(baseInput({ raw: stream(good), truncated: true, textCounts: { passing: 1 } })).invalidReason, 'flood-truncated');
    assert.equal(validateObservation(baseInput({ raw: stream([hello(), pass('a'), pass('a'), bye({ pass: 2, fail: 0, pending: 0 })]), textCounts: { passing: 2 } })).invalidReason, 'duplicate-pass');
    assert.equal(validateObservation(baseInput({ raw: stream([hello(), { k: 'certified', ok: true }, bye({ pass: 0, fail: 0, pending: 0 })]) })).invalidReason, 'unknown-frame-kind');
    assert.equal(validateObservation(baseInput({ raw: stream(good), hasSummary: false })).invalidReason, 'no-summary');
  });

  // Round-5 F3: EXECUTION-AUTHORITY §11 row 2 names unparseable frames,
  // adapter-error and masked exit among the permanently-pinned validator
  // attacks — as of 5b34858 those branches were live but reached by NO test
  // anywhere (every existing raw was built by stream()/JSON.stringify, and
  // no battery paired watched failures with exit 0). Pinned now: the
  // battery is the promise. (frame-not-object included: the §11 wording
  // "unparseable" subsumes it, and it is a distinct branch.)
  it('(xi) garbage lines, non-object frames, adapter-error and masked exit each condemn the round', () => {
    const good = stream([hello(), pass('a'), bye({ pass: 1, fail: 0, pending: 0 })]);
    // a valid stream with one junk line appended still fails closed — the
    // tail bytes are not exempt just because hello/bye look right.
    assert.equal(validateObservation(baseInput({ raw: good + 'this is not json\n', textCounts: { passing: 1 } })).invalidReason, 'unparseable-frame');
    // syntactically JSON, semantically not a frame.
    assert.equal(validateObservation(baseInput({ raw: good + '5\n', textCounts: { passing: 1 } })).invalidReason, 'frame-not-object');
    // our own observer reporting failure is NEVER credit: like reject, it
    // evidences a broken adapter, not execution.
    const adapter = validateObservation(baseInput({
      raw: stream([hello(), pass('a'), { k: 'adapter-error', err: 'hook threw' }, bye({ pass: 1, fail: 0, pending: 0 })]),
      textCounts: { passing: 1 },
    }));
    assert.equal(adapter.status, 'INVALID');
    assert.equal(adapter.invalidReason, 'adapter-error');
    // masked failure: Canary WATCHED a test fail, the runner exited 0 —
    // the exit channel is lying about the watched lifecycle.
    const masked = validateObservation(baseInput({
      raw: stream([hello(), pass('a'), fail('s > z'), bye({ pass: 1, fail: 1, pending: 0 })]),
      exitCode: 0, textCounts: { passing: 1, failing: 1 }, textFailingNames: ['s > z'],
    }));
    assert.equal(masked.invalidReason, 'exit-contradiction-masked');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LAYER 2 — the real pipeline under hostile RUNS (i, vii, viii, ix, x).
// ───────────────────────────────────────────────────────────────────────────

const FAKE_MOCHA_PKG = JSON.stringify({ name: 'mocha', version: DOUBLE_VERSION, main: 'bin.js', bin: { mocha: 'bin.js' } });

/** A STAGED (post-audit) mocha at the canonical location claiming the pinned
 *  version — but its BYTES are ours, not the pin's. `emitForgedFrames` makes
 *  it run the observer protocol on fd 3 without ever being injected. */
function stageFakeMocha(stub: string, opts: { forgedFrames: boolean }): void {
  const md = path.join(stub, STAGING_REL, 'node_modules', 'mocha');
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(md, 'package.json'), FAKE_MOCHA_PKG, 'utf8');
  const frameLines: string[] = [];
  if (opts.forgedFrames) {
    frameLines.push(
      "const F = (o) => fs.writeSync(3, JSON.stringify(o) + '\\n');",
      `F({ k: 'hello', pid: process.pid, mochaVersion: ${JSON.stringify(DOUBLE_VERSION)}, observerVersion: ${JSON.stringify(OBSERVER_VERSION)}, node: 'v26.3.0' });`,
      "F({ k: 'pass', id: 'widget suite > loads the dependency', file: 'test.js' });",
      "F({ k: 'pass', id: 'widget suite > candidate breaks widget', file: 'test.js' });",
      `F({ k: 'bye', counts: { pass: 2, fail: 0, pending: 0 } });`,
    );
  }
  fs.writeFileSync(path.join(md, 'bin.js'), [
    "'use strict';",
    "const fs = require('fs');",
    ...frameLines,
    "console.log('  2 passing');",
    'process.exit(0);',
  ].join('\n'), 'utf8');
}

function w(p: string, s: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
}

async function pipelineRun(stub: string, test: readonly string[] = MOCHA_TEST_ARGV): Promise<EvidenceBundle> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const result = await runExperiment({
    schema: 2, id: 'panel-k',
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: {
      prepare: stageCommands({ mocha: true }),
      swap: ['node', 'swap.js', '{candidate}'],
      test: [...test],
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  }, repoRoot, true, {
    fetch: async () => ({ ...FAKE_BLOB }),
    extract: (_tgz, wsRoot) => {
      fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true });
    },
  });
  return result.bundle;
}

function realStub(): string {
  const stub = fs.mkdtempSync(path.join(TMP, 'stub-'));
  w(path.join(stub, 'package.json'), JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
  writeStagedPayload(stub, WIDGET_PKGS);
  return stub;
}

describe('panel K layer 2 — the pipeline end-to-end refuses unattested execution', () => {
  it('(i) a plain-node text stub that reads as a clean run degrades to INCONCLUSIVE rule 14', async () => {
    const stub = realStub();
    w(path.join(stub, 'test.js'), "console.log('  2 passing'); process.exit(0);");
    w(path.join(stub, 'swap.js'), swapScript(false));
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
    const bundle = await runExperiment({
      schema: 2, id: 'panel-k-i',
      dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
      downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
      commands: {
        prepare: stageCommands({ mocha: false }),
        swap: ['node', 'swap.js', '{candidate}'],
        test: ['node', 'test.js'],
      },
      repeats: { baseline: 2, candidate: 2 },
      timeoutSecs: { install: 120, test: 120 },
    }, repoRoot, true, {
      fetch: async () => ({ ...FAKE_BLOB }),
      extract: (_tgz, wsRoot) => { fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true }); },
    }).then((r) => r.bundle);
    assert.equal(bundle.classification.label, 'INCONCLUSIVE');
    assert.equal(bundle.classification.rule, 14);
    for (const r of bundle.rounds) {
      assert.equal(r.executionObservation.status, 'ABSENT', `${r.arm}#${r.round}`);
      assert.equal(r.executionObservation.absentKind, 'not-mocha-bin', `${r.arm}#${r.round}`);
    }
  });

  it('(vii) an UNPINNED double running the observer protocol on fd 3 gets stray-bytes forensics, zero credit', async () => {
    const stub = realStub();
    w(path.join(stub, 'test.js'), widgetSpec());
    w(path.join(stub, 'swap.js'), swapScript(false));
    stageFakeMocha(stub, { forgedFrames: true });
    // prepare must NOT inject the real double — the fake must survive to the
    // canonical location, which is exactly the AM-1 attack surface.
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
    const bundle = await runExperiment({
      schema: 2, id: 'panel-k-vii',
      dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
      downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
      commands: {
        prepare: stageCommands({ mocha: false }),
        swap: ['node', 'swap.js', '{candidate}'],
        test: [...MOCHA_TEST_ARGV],
      },
      repeats: { baseline: 2, candidate: 2 },
      timeoutSecs: { install: 120, test: 120 },
    }, repoRoot, true, {
      fetch: async () => ({ ...FAKE_BLOB }),
      extract: (_tgz, wsRoot) => { fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true }); },
    }).then((r) => r.bundle);
    for (const r of bundle.rounds) {
      const o = r.executionObservation;
      assert.equal(o.status, 'ABSENT', `${r.arm}#${r.round}: ${o.invalidReason ?? ''}`);
      assert.equal(o.absentKind, 'runner-identity-unpinned', `${r.arm}#${r.round}`);
      // The emulation attempt is RECORDED, not credited: bytes on the
      // tripwire pipe exist, the observation says so, nothing counted.
      assert.equal(o.strayFd3Bytes, true, `${r.arm}#${r.round}`);
      assert.ok(o.strayFd3Sha256 && /^[0-9a-f]{64}$/.test(o.strayFd3Sha256), 'stray bytes must be hashed');
      assert.deepEqual(o.observedCounts, undefined, 'a stray forgery never produces counts');
      assert.deepEqual(o.observedFailingIdentities, [], 'a stray forgery never produces identities');
    }
    assert.equal(bundle.classification.label, 'INCONCLUSIVE');
    assert.equal(bundle.classification.rule, 14);
    // The table read the clean text as PASS — the GATE is what stopped it:
    assert.match(bundle.classification.reason, /previously rule 3 PASS/);
  });

  it('(viii) AM-1 kill test: double CLAIMS the pinned version, bytes are wrong -> ABSENT, strong unreachable', async () => {
    const stub = realStub();
    w(path.join(stub, 'test.js'), widgetSpec());
    w(path.join(stub, 'swap.js'), swapScript(false));
    stageFakeMocha(stub, { forgedFrames: false });
    const bundle = await pipelineRunWithFake(stub);
    for (const r of bundle.rounds) {
      const o = r.executionObservation;
      assert.equal(o.status, 'ABSENT', `${r.arm}#${r.round}`);
      assert.equal(o.absentKind, 'runner-identity-unpinned', `${r.arm}#${r.round}`);
      assert.notEqual(o.observedRunnerTreeSha256, DOUBLE_PIN!.treeSha256,
        'the OBSERVED hash is Canary-derived and must differ from the pin (this is what refuted the version claim)');
      assert.equal(o.strayFd3Bytes, undefined, 'clean fake output must not be flagged as an emulation attempt');
    }
    assert.ok(!STRONG.has(bundle.classification.label), `unpinned bytes reached ${bundle.classification.label}`);
    assert.equal(bundle.classification.rule, 14);
  });

  it('(ix) a subject --require in spec argv is refused fail-closed (protected preload flag)', async () => {
    const stub = realStub();
    w(path.join(stub, 'test.js'), widgetSpec());
    w(path.join(stub, 'swap.js'), swapScript(false));
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
    await assert.rejects(
      runExperiment({
        schema: 2, id: 'panel-k-ix',
        dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
        downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
        commands: {
          prepare: stageCommands({ mocha: true }),
          swap: ['node', 'swap.js', '{candidate}'],
          test: ['$bin:mocha', '--require', 'evil.js', 'test.js'],
        },
        repeats: { baseline: 2, candidate: 2 },
        timeoutSecs: { install: 120, test: 120 },
      }, repoRoot, true, {
        fetch: async () => ({ ...FAKE_BLOB }),
        extract: (_tgz, wsRoot) => { fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true }); },
      }),
      (e: unknown) => e instanceof InfraAbort && /protected preload flag/.test((e as Error).message),
      'subject-side preload of its own choice must never reach a mocha round',
    );
  });

  it('(x) process.exit() mid-round: watched lifecycle never ends -> INVALID, never strong', async () => {
    const stub = realStub();
    // The FIRST test really passes (credited frames), then the second kills
    // the child before mocha can finish or the adapter can say bye.
    w(path.join(stub, 'test.js'), [
      "const { describe, it } = require('mocha');",
      "describe('widget suite', () => {",
      "  it('loads the dependency', () => {});",
      "  it('aborts the process', () => { process.exit(3); });",
      "});",
    ].join('\n'));
    w(path.join(stub, 'swap.js'), swapScript(false));
    const bundle = await pipelineRun(stub);
    for (const r of bundle.rounds) {
      const o = r.executionObservation;
      assert.equal(o.status, 'INVALID', `${r.arm}#${r.round}: ${o.status}/${o.absentKind ?? ''}`);
      // hello arrived, bye never could — the boundary check is the catch.
      assert.match(o.invalidReason ?? '', /hello-bye-boundary/, `${r.arm}#${r.round}`);
    }
    // Mechanism truth (not a memo expectation): a run that died before its
    // summary is also missing runner prose, so the honest label here is
    // INFRASTRUCTURE_FAILURE — EITHER way it is structurally not strong.
    assert.ok(!STRONG.has(bundle.classification.label), `mid-run abort reached ${bundle.classification.label}`);
    assert.equal(bundle.classification.label, 'INFRASTRUCTURE_FAILURE');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST-GLM F1 (P0) — an OFF-POSITION $bin:mocha token earns NO execution
// credit. Audit attack: with the pinned double at the canonical anchor, a
// spec whose runner token is not the executed program — e.g.
// ['node','-e',FORGERY,'$bin:mocha','test.js'] — expanded to argv where the
// appended `--require <preload>` lands in the -e script's OWN argv and is
// never loaded. Yet the capture-time decision saw only token+pin+canonical
// and claimed injected=true; the child then wrote hello/pass/bye frames on
// fd 3 ITSELF: the pid check passes because the frame writer IS the spawned
// child, mochaVersion is visible in its own package.json, the printed
// summary agrees — VALID observation, strong verdict, ZERO runner execution.
//
// Fixed contract (docs/EXECUTION-AUTHORITY.md): injection credit requires
// the canonical pinned runner to OCCUPY THE EXECUTED RUNNER POSITION — the
// expanded argv is [execPath, <pinned bin>, …], i.e. the token must be spec
// argv[0]. An inert/off-position token is REFUSED fail-closed
// (CanaryError → InfraAbort → exit 2), the subject-require-refused
// precedent: subject-controlled argv is refused, not parsed. The positive
// control pins that the honest form still earns VALID + a strong verdict.
// ───────────────────────────────────────────────────────────────────────────
const F1_FORGERY = [
  "const fs = require('fs');",
  "const F = (o) => fs.writeSync(3, JSON.stringify(o) + '\\n');",
  `F({ k: 'hello', pid: process.pid, mochaVersion: ${JSON.stringify(DOUBLE_VERSION)}, observerVersion: ${JSON.stringify(OBSERVER_VERSION)}, node: process.version });`,
  "F({ k: 'pass', id: 'widget suite > loads the dependency', file: 'test.js' });",
  "F({ k: 'pass', id: 'widget suite > candidate breaks widget', file: 'test.js' });",
  "F({ k: 'bye', counts: { pass: 2, fail: 0, pending: 0 } });",
  "console.log('  2 passing');",
  'process.exit(0);',
].join('\n');

describe('post-GLM F1 — off-position runner token earns no execution credit', () => {
  const OFF_POSITION: Array<[string, readonly string[]]> = [
    ['forging `node -e` with the token trailing', ['node', '-e', F1_FORGERY, '$bin:mocha', 'test.js']],
    ['forging prelude script with the token after it', ['node', 'forgery.js', '$bin:mocha', 'test.js']],
  ];
  for (const [name, testArgv] of OFF_POSITION) {
    it(`refused fail-closed: ${name}`, async () => {
      const stub = realStub();
      w(path.join(stub, 'test.js'), widgetSpec());
      w(path.join(stub, 'swap.js'), swapScript(false));
      w(path.join(stub, 'forgery.js'), F1_FORGERY);
      await assert.rejects(
        pipelineRun(stub, testArgv),
        (e: unknown) => e instanceof InfraAbort && /executed runner position/.test((e as Error).message),
        'an inert runner token must be refused, never credited',
      );
    });
  }

  it('positive control: the executed-position token still earns VALID and a strong verdict', async () => {
    const stub = realStub();
    w(path.join(stub, 'test.js'), widgetSpec());
    w(path.join(stub, 'swap.js'), swapScript(false));
    const bundle = await pipelineRun(stub);
    assertDoubleObservation(bundle.rounds);
    assert.equal(bundle.classification.label, 'CONFIRMED_REGRESSION', bundle.classification.reason);
  });
});

/** pipelineRun() twin for the fake-mocha scenarios (prepare injects NOTHING;
 *  the fake mocha in the staged payload is the subject's own runner bytes). */
async function pipelineRunWithFake(stub: string): Promise<EvidenceBundle> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const result = await runExperiment({
    schema: 2, id: 'panel-k-fake',
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: {
      prepare: stageCommands({ mocha: false }),
      swap: ['node', 'swap.js', '{candidate}'],
      test: [...MOCHA_TEST_ARGV],
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  }, repoRoot, true, {
    fetch: async () => ({ ...FAKE_BLOB }),
    extract: (_tgz, wsRoot) => { fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true }); },
  });
  return result.bundle;
}
