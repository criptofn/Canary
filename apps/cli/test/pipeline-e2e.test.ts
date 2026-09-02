/**
 * Audit M8 — OFFLINE end-to-end pipeline integration test.
 *
 * The 73-test baseline classified and validated pieces but NEVER wired the
 * whole pipeline, which is exactly why rule-9 confinement removal and
 * fabricated-evidence acceptance slipped through. This test runs the REAL
 * runExperiment (classification -> evidence bundle -> validateBundle ->
 * verifyArtifacts -> assertProof) against a local stub repo with NO network:
 * the fetch/extract boundaries are injected (the same seam idiom as
 * ExecutorDeps.run); every command is a local `node` script producing REAL
 * artifacts. It pins the four release-blocking behaviors:
 *   1. a genuine confined regression classifies CONFIRMED_REGRESSION and the
 *      real on-disk artifacts re-hash clean (F4/F13 end to end);
 *   2. unconfined tree drift is downgraded to INCONCLUSIVE rule 9 (F9 e2e);
 *   3. a tampered artifact is caught by the prove path (F4 e2e);
 *   4. a fabricated, self-contradictory bundle is refuted by validateBundle (F3 e2e).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runExperiment, InfraAbort } from '../src/pipeline.js';
import { validateBundle, structuralIssues, type EvidenceBundle } from '@canary-rn/evidence-schema';
import { assertProof, actualHostFingerprint, verifyArtifacts, verifyRunIdentity, verifyClassificationDerivation, type ProofExpectation } from '../src/prove.js';
import { sha256hex } from '@canary-rn/hashing';
import { writeStagedPayload, stageCommands, MOCHA_TEST_ARGV, widgetSpec, swapScript, WIDGET_PKGS, assertDoubleObservation } from './stub-harness.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-e2e-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FAKE_SHA = 'a'.repeat(40);
// Round-3 B4: the fetch seam must declare the ACTUAL digest of the bytes it
// hands over — the pipeline retains fixture.tgz and the prove gate re-hashes
// it (verifyRunIdentity), so a synthetic digest no byte matches dies.
const FAKE_BYTES = Buffer.from('canary-offline-fake-tarball-bytes');
const FAKE_BLOB = { bytes: FAKE_BYTES, sha256: sha256hex(FAKE_BYTES) };

/**
 * A downstream repo whose test.js PASSES under widget@1 and FAILS (a REAL
 * executed failure under the pinned Canary mocha double) under widget@2.
 * `driftSwap` additionally bumps an unrelated dep (left-pad) so the candidate
 * tree drifts OUTSIDE the studied dependency subtree.
 *
 * Post-GLM AM-2: the fake node_modules is STAGED (stub-payload/) and
 * materialized by the prepare step — a fixture that ships node_modules is
 * refused at audit. Post-GLM Finding A: strong labels require attested
 * execution, so the test command runs through $bin:mocha and prepare
 * injects the hash-pinned double (the only offline runner KNOWN_RUNNER_
 * RELEASES accepts) — these bundles carry real VALID observations produced
 * by the actual injection mechanism, not forged text.
 */
function makeStub(dir: string, opts: { driftSwap: boolean }): void {
  const w = (p: string, s: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, 'utf8');
  };
  w(path.join(dir, 'package.json'), JSON.stringify({
    name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' },
  }));
  writeStagedPayload(dir, WIDGET_PKGS);
  w(path.join(dir, 'test.js'), widgetSpec());
  w(path.join(dir, 'swap.js'), swapScript(opts.driftSwap));
}

function specFor(): unknown {
  return {
    schema: 2, id: 'stub-e2e',
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: {
      prepare: stageCommands({ mocha: true }),
      // {candidate} is required by the planner (the swap must name the version
      // it installs); swap.js ignores the arg but the token proves intent.
      swap: ['node', 'swap.js', '{candidate}'],
      test: [...MOCHA_TEST_ARGV],
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  };
}

async function offlineRun(driftSwap: boolean): Promise<
  { repoRoot: string; artifactsDir: string; bundle: EvidenceBundle; issues: string[] }
> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = fs.mkdtempSync(path.join(TMP, 'stub-'));
  makeStub(stub, { driftSwap });
  const proj = 'downstream';
  const result = await runExperiment(specFor(), repoRoot, true, {
    fetch: async () => ({ ...FAKE_BLOB }),
    extract: (_tgz, wsRoot) => {
      const target = path.join(wsRoot, `${proj}-${FAKE_SHA}`);
      fs.cpSync(stub, target, { recursive: true });
    },
  });
  return { repoRoot, artifactsDir: result.artifactsDir, bundle: result.bundle, issues: result.bundleIssues };
}

describe('audit M8 — offline pipeline end-to-end', () => {
  it('confined regression: CONFIRMED_REGRESSION, real artifacts re-hash clean', async () => {
    const { bundle, artifactsDir, issues } = await offlineRun(false);
    assert.deepEqual(issues, [], `bundle must self-validate: ${issues.join('; ')}`);
    // post-sol M-1: REAL generated evidence satisfies the published
    // structural contract (same source of truth that generates
    // schemas/evidence.schema.json — drift between producer output and the
    // published contract fails here, not in an audit).
    assert.deepEqual(structuralIssues(bundle as unknown as Record<string, unknown>), [],
      'real pipeline evidence must satisfy the published contract');
    assert.equal(bundle.classification.label, 'CONFIRMED_REGRESSION', bundle.classification.reason);
    assert.equal(bundle.classification.rule, 5);
    assert.equal(bundle.treeComparison.driftConfinedToDependency, true);
    // F4 e2e: real on-disk artifacts must match the recorded digests.
    assert.deepEqual(verifyArtifacts(artifactsDir, bundle), []);
    // F13 e2e: failing-test identities are persisted in the bundle itself.
    const cand = bundle.rounds.find((r) => r.arm === 'candidate')!;
    assert.ok(cand.failingTestNames && cand.failingTestNames.length >= 1,
      'candidate round must persist failing-test identities');
    assert.equal(cand.reportedFailing, 1);
    // Post-GLM Finding A: this rule-5 was EARNED, not printed — every round
    // carries a VALID Canary observation of the pinned double executing the
    // very counts and identities the text claims.
    assertDoubleObservation(bundle.rounds);
    // And a well-formed proof expectation passes assertProof against the logs.
    const baseHashes = bundle.rounds.filter((r) => r.arm === 'baseline').map((r) => r.normalizedStdoutSha256);
    const candHashes = bundle.rounds.filter((r) => r.arm === 'candidate').map((r) => r.normalizedStdoutSha256);
    // Round-3 B4: on a faithful OFFLINE run the workspace-level bindings hold
    // too — run identity names the real directory and the recorded tarball
    // digest equals fixture.tgz's bytes; the classification is reproducible
    // from the bytes + retained trees.
    assert.deepEqual(verifyRunIdentity(artifactsDir, bundle), []);
    assert.deepEqual(verifyClassificationDerivation(artifactsDir, bundle), []);
    const proof: ProofExpectation = {
      schema: 1, experimentId: 'stub-e2e',
      dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
      downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
      tarballSha256: bundle.downstream.tarballSha256,
      expected: {
        classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
        baseline: { rounds: baseHashes.length, exitCodes: [0, 0], normalizedStdoutSha256AcrossRounds: baseHashes, summary: { passing: 2 } },
        candidate: { rounds: candHashes.length, exitCodes: [1, 1], normalizedStdoutSha256AcrossRounds: candHashes, summary: { passing: 1, failing: 1 } },
        failingTestNames: ['widget suite > candidate breaks widget'],
      },
    };
    const readLog = (arm: 'baseline' | 'candidate'): string => {
      const p = path.join(artifactsDir, `${arm}-1.stdout.log`);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    };
    // Round-3 B3: assertions run against the ACTUAL runtime (this machine,
    // which really is the recording machine here — the legacy-proof branch
    // only asserts host-exact hashes when reality matches the evidence).
    const checks = assertProof(bundle, proof, { candidateStdout: readLog('candidate'), baselineStdout: readLog('baseline') }, actualHostFingerprint());
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name), [], 'a faithful proof must pass');
    assert.deepEqual(checks.filter((c) => c.skipped).map((c) => c.name), [], 'nothing host-exact may skip when reality matches');
  });

  it('unconfined tree drift is downgraded to INCONCLUSIVE rule 9 (F9 e2e)', async () => {
    const { bundle, artifactsDir, issues } = await offlineRun(true);
    assert.deepEqual(issues, [], `guard-produced bundle must still validate: ${issues.join('; ')}`);
    assert.equal(bundle.treeComparison.driftConfinedToDependency, false);
    assert.equal(bundle.classification.label, 'INCONCLUSIVE');
    assert.equal(bundle.classification.rule, 9);
    assert.match(bundle.classification.reason, /left-pad/);
    // Round-3 B4: the rule-9 downgrade reproduces from bytes + retained
    // snapshots — including the guard's reason string, so the confinement
    // re-derivation matches the pipeline's exactly.
    assert.deepEqual(verifyClassificationDerivation(artifactsDir, bundle), []);
  });

  it('a tampered artifact is caught end-to-end by the prove path (F4 e2e)', async () => {
    const { bundle, artifactsDir } = await offlineRun(false);
    const logFile = path.join(artifactsDir, 'candidate-1.stdout.log');
    fs.appendFileSync(logFile, 'FORGED LINE injected after hashing\n');
    const issues = verifyArtifacts(artifactsDir, bundle);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.match(issues[0]!, /TAMPERED artifact candidate-1\.stdout\.log/);
  });

  it('a fabricated self-contradictory bundle is refuted by validateBundle (F3 e2e)', async () => {
    // Take a REAL confirmed bundle and lie: claim PASS with all candidate
    // rounds that actually failed. Re-derivation must refuse it.
    const { bundle } = await offlineRun(false);
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.classification = { label: 'PASS', rule: 3, reason: 'made up', reproductionCount: 2 };
    const issues = validateBundle(forged);
    assert.ok(issues.some((i) => /contradicts its own round facts/.test(i)),
      `expected a re-derivation refusal, got: ${issues.join('; ')}`);
  });

  it('round-3 secondary: a fetch failure is INFRASTRUCTURE (InfraAbort -> CLI exit 2), not generic error', async () => {
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
    let caught: unknown;
    try {
      await runExperiment(specFor(), repoRoot, true, {
        fetch: async () => { throw new Error('codeload HTTP 502 for stub/downstream'); },
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof InfraAbort, `expected InfraAbort, got ${String(caught)}`);
    assert.match((caught as Error).message, /INFRASTRUCTURE_FAILURE: content fetch failed/);
  });

  it('round-3 secondary: an extraction failure is INFRASTRUCTURE too', async () => {
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
    let caught: unknown;
    try {
      await runExperiment(specFor(), repoRoot, true, {
        fetch: async () => FAKE_BLOB,
        extract: () => { throw new Error('tar: This does not look like a tar archive'); },
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof InfraAbort, `expected InfraAbort, got ${String(caught)}`);
    assert.match((caught as Error).message, /INFRASTRUCTURE_FAILURE: tarball extraction failed/);
  });
});
