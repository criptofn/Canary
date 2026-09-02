/**
 * Round-3 blocker 6 — permanent adversarial tests for dependency-tree
 * completeness and the INDEPENDENT snapshot verifier.
 *
 * Structure follows the audit's testing rule ("do not assume that using the
 * same parser/classifier in both producer and verifier proves correctness"):
 *   - unit tests drive reflattenNpmLs with hand-crafted npm-ls JSON shapes;
 *   - an OFFLINE FULL PIPELINE run (stubbed fetch/extract, REAL npm ls) feeds
 *     the verifier real bytes produced by the pipeline's own (structurally
 *     different) flatten — agreement is then cross-parser evidence, not a
 *     tautology;
 *   - tamper tests cover naive (unsealed) forgeries, LAZY reseals (some
 *     digests recomputed), and FULLY COHERENT reseals of the tree side —
 *     including an honest boundary documentation: what the tree layer alone
 *     cannot see, and which layer catches it instead.
 *
 * Post-GLM migration (this file's subject is RETAINED BYTES, so it grew with
 * the two shipped hardenings):
 *   - AM-2: the stub no longer SHIPS node_modules (audit refuses that); the
 *     fake tree is staged and materialized by the prepare step.
 *   - Finding A / G: the CONFIRMED_REGRESSION scenarios run through the REAL
 *     observation channel ($bin:mocha + hash-pinned double), and the per-round
 *     artifact tuple is now FIVE files — <arm>-<round>.attest.ndjson binds
 *     each executionObservation to bytes. Tamper/reseal coverage extended to
 *     the observation level: a resealed observation whose bytes do not back it,
 *     or an observation stripped from a sealed bundle, is now REFUSED (the old
 *     "reseal everything ⇒ clean" reach ends exactly at the observation).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { sha256hex } from '@canary-rn/hashing';
import { integrityFor, validateBundle, type EvidenceBundle, type TreeSnapshotRef } from '@canary-rn/evidence-schema';
import { KNOWN_RUNNER_RELEASES } from '@canary-rn/support';
import { runExperiment } from '../src/pipeline.js';
import { verifyArtifacts } from '../src/prove.js';
import { reflattenNpmLs, recountCopies, deriveConfined, verifyTreeSnapshots } from '../src/verify-tree.js';
import { writeStagedPayload, stageCommands, MOCHA_TEST_ARGV, widgetSpec, swapScript, WIDGET_PKGS, assertDoubleObservation } from './stub-harness.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-b6-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const reSeal = (b: EvidenceBundle): EvidenceBundle => {
  b.integrity = integrityFor(b);
  return b;
};

// The canary-double pin: synthetic trustful bundles in section 3 must name a
// REAL pinned runner identity (panel H/AM-1: strong labels without pinned
// runner bytes die at validateBundle, exactly as they should).
const DOUBLE_PIN = (KNOWN_RUNNER_RELEASES.mocha ?? []).find((p) => p.origin === 'canary-double')!;
const validObs = (passing: number, failing: number, ids: readonly string[]): Record<string, unknown> => ({
  status: 'VALID',
  observedFailingIdentities: [...ids],
  framesSha256: sha256hex('synthetic-frame-stream'),
  frameCount: 2,
  observedCounts: { passing, failing, pending: 0 },
  expectedMochaVersion: DOUBLE_PIN.version,
  observedMochaVersion: DOUBLE_PIN.version,
  expectedRunnerTreeSha256: DOUBLE_PIN.treeSha256,
  observedRunnerTreeSha256: DOUBLE_PIN.treeSha256,
});

// ---------------------------------------------------------------------------
// 1. reflatten unit behavior (hand-crafted npm-ls shapes)
// ---------------------------------------------------------------------------
describe('reflattenNpmLs — independent re-derivation of the tree observation', () => {
  it('flattens nested/scoped trees with versions, no anomalies (problems ignored)', () => {
    const nested = JSON.stringify({
      name: 'downstream', version: '1.0.0',
      dependencies: {
        widget: { version: '1.0.0', dependencies: { 'sub-dep': { version: '2.0.0' } } },
        '@scope/thing': { version: '3.0.0' },
        'left-pad': { version: '1.0.0', extraneous: true },
      },
      problems: ['extraneous: left-pad@1.0.0'], // ELSPROBLEMS noise is NOT an anomaly
    });
    // post-sol M-2: the problems array and stderr ELSPROBLEMS must agree
    // (real npm emits both) before the tree is trusted as consistent.
    const r = reflattenNpmLs(nested, 'npm error code ELSPROBLEMS\n');
    assert.ok(r.parsed && r.hasRootDeps);
    assert.deepEqual(r.anomalies, []);
    assert.equal(r.flat['widget'], '1.0.0');
    assert.equal(r.flat['widget/sub-dep'], '2.0.0');
    assert.equal(r.flat['left-pad'], '1.0.0');
    assert.equal(r.flat['@scope%2Fthing'], '3.0.0', 'scoped names escape to %2F');
  });

  it('a missing-version node (npm unmet dependency) is an anomaly, never an "x" sentinel', () => {
    const raw = JSON.stringify({
      name: 'downstream', version: '1.0.0',
      dependencies: { axios: { version: '1.0.0', dependencies: { 'proxy-from-env': { missing: true, required: '^1.0.0' } } } },
    });
    const r = reflattenNpmLs(raw);
    assert.deepEqual(r.anomalies, ['missing-version:axios/proxy-from-env']);
    assert.ok(!('axios/proxy-from-env' in r.flat), 'a hole must not masquerade as a version');
  });

  // npm >= 11.19 renders NOT-INSTALLED OPTIONAL deps (fsevents on win32, ws's
  // native bufferutil/utf-8-validate — the real Axios-drift case of 2026-08-31)
  // as empty `{}` nodes. An honest observation of an intentionally-absent
  // package is COMPLETE, not partial: no anomaly — UNLESS npm's own problems
  // list mentions the package (fail-closed for genuinely unmet deps).
  it('an empty {} node with no problems mention is an expected-absent optional, not a hole', () => {
    const raw = JSON.stringify({
      name: 'r', version: '1.0.0',
      dependencies: {
        mocha: { version: '10.0.0', dependencies: { chokidar: { version: '3.0.0', dependencies: { fsevents: {} } } } },
        ws: { version: '8.0.0', dependencies: { bufferutil: {}, 'utf-8-validate': {} } },
      },
      problems: ['invalid: ajv@6.15.0 C:\\x\\node_modules\\ajv'],
    });
    const r = reflattenNpmLs(raw, 'npm error code ELSPROBLEMS\n');
    assert.deepEqual(r.anomalies, [], JSON.stringify(r.anomalies));
    assert.deepEqual(Object.keys(r.flat).sort(), ['mocha', 'mocha/chokidar', 'ws']);
  });
  it('the same empty {} node IS an anomaly when problems mentions it (unmet-optional-that-matters fails closed)', () => {
    const raw = JSON.stringify({
      name: 'r', version: '1.0.0',
      dependencies: { ws: { version: '8.0.0', dependencies: { bufferutil: {} } } },
      problems: ['missing: bufferutil@2.0.0'],
    });
    const r = reflattenNpmLs(raw, 'npm error code ELSPROBLEMS\n');
    assert.deepEqual(r.anomalies, ['missing-version:ws/bufferutil']);
  });
  it('problems name-matching is token-anchored: "util" is not mentioned by "bufferutil@1.0.0"', () => {
    const raw = JSON.stringify({
      name: 'r', version: '1.0.0',
      dependencies: { pkg: { version: '1.0.0', dependencies: { util: {} } } },
      problems: ['missing: bufferutil@1.0.0'],
    });
    const r = reflattenNpmLs(raw, 'npm error code ELSPROBLEMS\n');
    assert.deepEqual(r.anomalies, [], 'a substring-only coincidence must not force INCOMPLETE');
  });
  it('a {} node WITH a declared subtree is still missing-version + unwalked-subtree', () => {
    const raw = JSON.stringify({
      name: 'r', version: '1.0.0',
      dependencies: { ghost: { dependencies: { child: { version: '1.0.0' } } } },
    });
    const r = reflattenNpmLs(raw);
    assert.ok(r.anomalies.includes('missing-version:ghost'), JSON.stringify(r.anomalies));
  });

  it('a version-less NODE hides a whole subtree: missing-version + unwalked-subtree', () => {
    const raw = JSON.stringify({
      name: 'r', version: '1.0.0',
      dependencies: { broken: { dependencies: { deep: { version: '9.9.9' } } } },
    });
    const r = reflattenNpmLs(raw);
    assert.deepEqual(r.anomalies, ['missing-version:broken', 'unwalked-subtree:broken']);
    assert.ok(!('broken/deep' in r.flat), 'descendants of an unwalkable node are NOT observed');
  });

  it('truncated / malformed JSON => parsed=false (INVALID territory), never a partial success', () => {
    for (const junk of ['{"name":"r","dependencies":{"a":{"version":"1"', '', 'not json at all']) {
      assert.equal(reflattenNpmLs(junk).parsed, false, `must not parse: ${JSON.stringify(junk.slice(0, 20))}`);
    }
    const nullEntry = reflattenNpmLs(JSON.stringify({ name: 'r', version: '1', dependencies: { ghost: null } }));
    assert.ok(nullEntry.anomalies.includes('missing-version:ghost'));
    assert.ok(nullEntry.anomalies.includes('malformed-node:ghost'));
  });

  it('copies are counted by full path segments; subtree containment is segment membership', () => {
    const r = reflattenNpmLs(JSON.stringify({
      name: 'r', version: '1',
      dependencies: {
        axios: { version: '1.0.0' },
        bundlesize: { version: '1', dependencies: { axios: { version: '0.27.2', dependencies: { 'proxy-from-env': { version: '1.1.0' } } } } },
      },
    }));
    assert.equal(recountCopies(r.flat, 'axios'), 2);
    assert.equal(recountCopies(r.flat, 'proxy-from-env'), 1);
    assert.equal(recountCopies(r.flat, '@types/axios'), 0);
    assert.ok(deriveConfined(['bundlesize/axios/proxy-from-env'], 'axios'),
      'descendant of a NESTED copy is inside the subtree (round-3 B6 false-CONFIRMED source)');
    assert.ok(!deriveConfined(['axios-like'], 'axios'), 'prefix lookalike is NOT the dependency');
    assert.ok(!deriveConfined(['lodash'], 'axios'));
    assert.ok(deriveConfined([], 'axios'), 'zero drift is trivially confined');
  });
});

// ---------------------------------------------------------------------------
// 2. offline full pipeline: retained snapshots exist, verify clean, and
//    resist three tiers of forgery
// ---------------------------------------------------------------------------
const FAKE_SHA = 'a'.repeat(40);
const FAKE_BLOB = { bytes: Buffer.alloc(0), sha256: 'b'.repeat(64) };

/**
 * Post-GLM AM-2/Finding A shape (see stub-harness header): the fake
 * node_modules is STAGED outside the reserved name and materialized by the
 * prepare step; test.js runs under the pinned Canary mocha double via
 * $bin:mocha so the CONFIRMED_REGRESSION this suite tampers with is EARNED
 * through the real observation channel, not printed text. The tree therefore
 * carries mocha (extraneous) alongside widget — every hand-forged canonical
 * flatten below re-derives from the tampered raw bytes rather than hardcoding
 * a one-entry list, keeping the "fully coherent tree-side reseal" premise
 * intact over the richer tree.
 */
function makeStub(dir: string): void {
  const w = (p: string, s: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, 'utf8');
  };
  w(path.join(dir, 'package.json'), JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
  writeStagedPayload(dir, WIDGET_PKGS);
  w(path.join(dir, 'test.js'), widgetSpec());
  w(path.join(dir, 'swap.js'), swapScript(false));
}

async function offlineRun(): Promise<{ artifactsDir: string; bundle: EvidenceBundle }> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = fs.mkdtempSync(path.join(TMP, 'stub-'));
  makeStub(stub);
  const result = await runExperiment({
    schema: 2, id: 'stub-b6',
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: {
      prepare: stageCommands({ mocha: true }),
      swap: ['node', 'swap.js', '{candidate}'],
      test: [...MOCHA_TEST_ARGV],
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  }, repoRoot, true, {
    fetch: async () => ({ ...FAKE_BLOB }),
    extract: (_tgz, wsRoot) => {
      fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true });
    },
  });
  assert.deepEqual(result.bundleIssues, [],
    `pipeline bundle must validate cleanly: ${result.bundleIssues.join('; ')}`);
  return { artifactsDir: result.artifactsDir, bundle: result.bundle };
}

describe('retained tree snapshots — real pipeline bytes, independent verifier', () => {
  it('a fresh confined CONFIRMED run retains arm-named artifacts that verify clean', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    assert.equal(bundle.classification.label, 'CONFIRMED_REGRESSION');
    const tc = bundle.treeComparison;
    const snaps = tc.snapshots;
    assert.ok(snaps, 'trustful bundle must carry snapshot refs');
    assert.deepEqual(tc.observationAnomalies, { baseline: { json: [] }, candidate: { json: [] } },
      'stub tree is fully observed — any anomaly here means npm emitted a hole we now distrust');
    assert.equal(tc.resolvedVersions.baseline, '1.0.0');
    assert.equal(tc.resolvedVersions.candidate, '2.0.0');
    for (const arm of ['baseline', 'candidate'] as const) {
      const s: TreeSnapshotRef = snaps![arm];
      assert.equal(s.rawStdoutLog, `tree-${arm}.treels.raw.log`);
      for (const f of [s.rawStdoutLog, s.rawStderrLog, s.canonicalLog]) {
        assert.ok(fs.existsSync(path.join(artifactsDir, f)), `artifact ${f} must be retained on disk`);
      }
      const re = reflattenNpmLs(fs.readFileSync(path.join(artifactsDir, s.rawStdoutLog), 'utf8'));
      assert.ok(re.parsed && Object.keys(re.flat).some((k) => k.split('/').includes('widget')),
        'retained bytes must be real npm-ls JSON containing the studied dep');
    }
    // THE cross-parser agreement: pipeline recursive flatten vs verifier
    // iterative re-flatten, on the SAME retained bytes.
    assert.deepEqual(verifyTreeSnapshots(bundle, artifactsDir), []);
    // and the canonical artifact binds the tree hash the bundle reports.
    const canonC = fs.readFileSync(path.join(artifactsDir, snaps!.candidate.canonicalLog), 'utf8');
    assert.equal(sha256hex(canonC), tc.candidateTreeSha256);
    // Post-GLM G: the round tuple is FIVE files — every round's execution
    // observation is bound to retained <arm>-<round>.attest.ndjson bytes,
    // and verifyArtifacts (which now hashes that fifth file too) re-hashes
    // the whole tuple clean.
    for (const r of bundle.rounds) {
      assert.ok(fs.existsSync(path.join(artifactsDir, `${r.arm}-${r.round}.attest.ndjson`)),
        `${r.arm}-${r.round}.attest.ndjson must be retained (5-file tuple)`);
    }
    assert.deepEqual(verifyArtifacts(artifactsDir, bundle), [],
      'the 5-file tuple (raw, raw-err, norm, norm-err, attest) must re-hash clean');
    assertDoubleObservation(bundle.rounds);
  });

  it('naive tamper of retained raw bytes (no reseal) is caught', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const rawC = path.join(artifactsDir, bundle.treeComparison.snapshots!.candidate.rawStdoutLog);
    fs.appendFileSync(rawC, ' ');
    const issues = verifyTreeSnapshots(bundle, artifactsDir);
    assert.ok(issues.some((i) => /do not match the recorded digest/.test(i)), JSON.stringify(issues));
    assert.ok(issues.some((i) => /drift:.*do not match recorded digests/.test(i)),
      'drift recomputation must also refuse to vouch for tampered bytes');
  });

  it('LAZY reseal (raw digest fixed, canonical/tree-hash left stale) is caught by the chain', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    const rawPath = path.join(artifactsDir, forged.treeComparison.snapshots!.candidate.rawStdoutLog);
    const bytes = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as { dependencies: Record<string, { version: string }> };
    bytes.dependencies.widget!.version = '9.9.9';
    const newRaw = JSON.stringify(bytes);
    fs.writeFileSync(rawPath, newRaw);
    forged.treeComparison.snapshots!.candidate.rawStdoutSha256 = sha256hex(newRaw);
    reSeal(forged); // attacker fixes the manifest + raw digest but not canonical/tree hash
    const issues = verifyTreeSnapshots(forged, artifactsDir);
    // The stale canonical FILE still matches its own recorded digest — the
    // independent re-flatten of the (re-sealed) raw bytes is what breaks:
    assert.ok(issues.some((i) => /does not match the independent re-flatten/.test(i)), JSON.stringify(issues));
    assert.ok(issues.some((i) => /TreeSha256 does not match sha256 of the re-derived canonical/.test(i)), JSON.stringify(issues));
    assert.ok(issues.some((i) => /resolvedVersions\.candidate/.test(i)),
      'the attested version claim must contradict the tampered root entry');
  });

  it('reseal that rewrites bytes+digests but keeps the old attestation claim is caught by verify-tree', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    const s = forged.treeComparison.snapshots!.candidate;
    const rawPath = path.join(artifactsDir, s.rawStdoutLog);
    const bytes = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as { dependencies: Record<string, { version: string }> };
    bytes.dependencies.widget!.version = '9.9.9';
    const newRaw = JSON.stringify(bytes);
    fs.writeFileSync(rawPath, newRaw);
    // Post-GLM: the tree carries the injected double + staged extras, so a
    // coherent attacker re-derives canonical from the tampered bytes instead
    // of hardcoding a one-entry list (same premise, honest over the fuller tree).
    const re = reflattenNpmLs(newRaw);
    const canonical = JSON.stringify(Object.entries(re.flat).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    fs.writeFileSync(path.join(artifactsDir, s.canonicalLog), canonical);
    s.rawStdoutSha256 = sha256hex(newRaw);
    s.canonicalSha256 = sha256hex(canonical);
    forged.treeComparison.candidateTreeSha256 = sha256hex(canonical);
    // resolvedVersions.candidate LEFT at '2.0.0' — everything else resealed:
    reSeal(forged);
    const issues = verifyTreeSnapshots(forged, artifactsDir);
    assert.ok(issues.some((i) => /resolvedVersions\.candidate='2\.0\.0' contradicts the root-level 'widget' entry '9\.9\.9'/.test(i)),
      JSON.stringify(issues));
    assert.ok(validateBundle(forged).length === 0,
      'this forgery is internally consistent at bundle level — only the BYTES binding catches it');
  });

  it('COHERENT full tree-side reseal: bundle layer catches the version lie (attestation invariant)', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    const s = forged.treeComparison.snapshots!.candidate;
    const rawPath = path.join(artifactsDir, s.rawStdoutLog);
    const bytes = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as { dependencies: Record<string, { version: string }> };
    bytes.dependencies.widget!.version = '9.9.9';
    const newRaw = JSON.stringify(bytes);
    fs.writeFileSync(rawPath, newRaw);
    // (as above) re-derive canonical honestly from the tampered bytes so the
    // tree layer sees a fully coherent side — the lie survives only as the
    // version VALUE, which the attestation invariant then kills:
    const re = reflattenNpmLs(newRaw);
    const canonical = JSON.stringify(Object.entries(re.flat).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    fs.writeFileSync(path.join(artifactsDir, s.canonicalLog), canonical);
    s.rawStdoutSha256 = sha256hex(newRaw);
    s.canonicalSha256 = sha256hex(canonical);
    forged.treeComparison.candidateTreeSha256 = sha256hex(canonical);
    forged.treeComparison.resolvedVersions.candidate = '9.9.9'; // keep bytes+claim aligned...
    reSeal(forged);
    // ...but the bundle's OWN dependency block still says the run was
    // spec.candidate=2.0.0, and an honest pipeline aborts when attestation
    // disagrees with spec — so this mismatch is by construction a forgery:
    assert.ok(validateBundle(forged).some((i) => /contradicts dependency\.candidateVersion/.test(i)),
      `sealed bundle must die on the attestation invariant: ${validateBundle(forged).join('; ')}`);
    // Honest boundary: the tree verifier alone says "bytes support every tree
    // claim" (the bytes ARE the tree's trust anchor). What finally pins this
    // forgery externally is the COMMITTED proof (assertProof pins the
    // dependency block + tree hashes) — Round-3 blocker 4's territory.
    assert.deepEqual(verifyTreeSnapshots(forged, artifactsDir), []);
  });

  it('a coherent reseal claiming VALID over bytes with a missing-version hole is caught (status + anomaly re-derivation)', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    const s = forged.treeComparison.snapshots!.candidate;
    const rawPath = path.join(artifactsDir, s.rawStdoutLog);
    const bytes = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as Record<string, unknown>;
    const deps = (bytes.dependencies ?? {}) as Record<string, unknown>;
    deps.widget = { version: '2.0.0', dependencies: { 'unmet-child': { missing: true } } };
    const newRaw = JSON.stringify(bytes);
    fs.writeFileSync(rawPath, newRaw);
    // re-seal EVERY digest honestly derivable (canonical from the hole-free
    // subset) — the strongest attacker that still keeps the LIE:
    // status VALID and anomalies [].
    const re = reflattenNpmLs(newRaw);
    const canonical = JSON.stringify(Object.entries(re.flat).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    fs.writeFileSync(path.join(artifactsDir, s.canonicalLog), canonical);
    s.rawStdoutSha256 = sha256hex(newRaw);
    s.canonicalSha256 = sha256hex(canonical);
    forged.treeComparison.candidateTreeSha256 = sha256hex(canonical);
    forged.treeComparison.observationStatus.candidate = 'VALID';
    forged.treeComparison.observationAnomalies!.candidate.json = [];
    reSeal(forged);
    const issues = verifyTreeSnapshots(forged, artifactsDir);
    assert.ok(issues.some((i) => /observationStatus 'VALID' disagrees with re-derivation from bytes \('INCOMPLETE'\)/.test(i)), JSON.stringify(issues));
    assert.ok(issues.some((i) => /recorded anomalies \[\] differ from re-derived \["missing-version:widget\/unmet-child"\]/.test(i)), JSON.stringify(issues));
  });

  it('pointing one arm at the other arm bytes is caught by BOTH layers', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.treeComparison.snapshots!.candidate.rawStdoutLog = 'tree-baseline.treels.raw.log';
    reSeal(forged);
    assert.ok(verifyTreeSnapshots(forged, artifactsDir).some((i) => /arm-derived artifact name/.test(i)));
    assert.ok(validateBundle(forged).some((i) => /not this arm's canonical artifact name/.test(i)));
  });

  it('flipping driftConfinedToDependency against the retained snapshots is caught', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.treeComparison.driftConfinedToDependency = false;
    reSeal(forged);
    assert.ok(verifyTreeSnapshots(forged, artifactsDir).some((i) => /tree drift: claim driftConfinedToDependency=false contradicts/.test(i)));
  });

  it('stripping snapshot refs from a trustful bundle: verifier says unverifiable, schema refuses to seal trust on it', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    delete forged.treeComparison.snapshots;
    delete forged.treeComparison.observationAnomalies;
    reSeal(forged);
    const issues = verifyTreeSnapshots(forged, artifactsDir);
    assert.ok(issues.some((i) => /no retained snapshot recorded/.test(i)), JSON.stringify(issues));
    assert.ok(issues.some((i) => /drift: snapshots not retained for both arms — confinement claim is unverifiable/.test(i)));
    assert.ok(validateBundle(forged).some((i) => /requires a retained treeComparison/.test(i)));
  });

  // -------------------------------------------------------------------------
  // Post-GLM G — the SAME adversarial tiers, aimed at the OBSERVATION bytes:
  // the 5th file of the per-round tuple and the executionObservation it binds.
  // -------------------------------------------------------------------------
  it('post-GLM G: naive tamper/deletion of the retained attest bytes is caught by verifyArtifacts', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    assert.deepEqual(verifyArtifacts(artifactsDir, bundle), [], 'untouched tuple must verify clean first');
    fs.appendFileSync(path.join(artifactsDir, 'baseline-1.attest.ndjson'), ' ');
    fs.rmSync(path.join(artifactsDir, 'candidate-1.attest.ndjson'));
    const issues = verifyArtifacts(artifactsDir, bundle);
    assert.equal(issues.length, 2, JSON.stringify(issues));
    assert.ok(issues.some((i) => /TAMPERED artifact baseline-1\.attest\.ndjson/.test(i)),
      'observation bytes must be digest-bound like the other four files');
    assert.ok(issues.some((i) => /artifact missing: candidate-1\.attest\.ndjson/.test(i)),
      'quietly deleting the observation bytes is a refusal, not a pass');
  });

  it('post-GLM G: a resealed framesSha256 the retained bytes do not back is caught ONLY by the bytes binding', async () => {
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    const r = forged.rounds.find((x) => x.arm === 'candidate' && x.round === 1)!;
    (r.executionObservation as unknown as { framesSha256: string }).framesSha256 =
      sha256hex('frames no attacker ever captured');
    reSeal(forged);
    // The lie is internally coherent (valid hex64, frameCount agrees, counts
    // still match the text channel) — bundle-level layers cannot see bytes.
    assert.deepEqual(validateBundle(forged), [],
      `the resealed observation must be self-consistent: ${validateBundle(forged).join('; ')}`);
    const issues = verifyArtifacts(artifactsDir, forged);
    assert.ok(issues.some((i) => /TAMPERED artifact candidate-1\.attest\.ndjson/.test(i)),
      `framesSha256 must answer to the retained frame bytes: ${JSON.stringify(issues)}`);
  });

  it('post-GLM G: reseal-everything-but-the-observation is REFUSED (the pre-G "clean 4-file resealed tuple" premise is forbidden by design)', async () => {
    // Pre-post-GLM-G, an attacker who recomputed every digest could at worst
    // be caught by the layers that read the four round files. Stripping the
    // observations and resealing used to yield an (observation-blind) clean
    // verify — now EVERY round must carry its observation and its retained
    // attest bytes, so this forgery dies at two independent layers.
    const { artifactsDir, bundle } = await offlineRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    for (const r of forged.rounds) delete (r as unknown as Record<string, unknown>).executionObservation;
    reSeal(forged);
    const v = validateBundle(forged);
    assert.ok(v.some((i) => /executionObservation/.test(i)),
      `schema floor + panel H mirror must refuse the stripped tuple: ${v.join('; ')}`);
    const a = verifyArtifacts(artifactsDir, forged);
    assert.equal(a.length, forged.rounds.length, JSON.stringify(a));
    assert.ok(a.every((i) => /executionObservation absent — every round must carry its observation and retain \S+-\d+\.attest\.ndjson \(post-GLM G\)/.test(i)),
      `every round must name its own observation-level refusal: ${JSON.stringify(a)}`);
  });
});

// ---------------------------------------------------------------------------
// 3. schema-layer B6 gates (synthetic bundles, no pipeline)
// ---------------------------------------------------------------------------
describe('validateBundle — round-3 B6 snapshot/anomaly/version gates', () => {
  function baseTrustfulBundle(): Record<string, unknown> {
    const H = 'a'.repeat(64);
    // Post-sol RB-2: executed totals (passing+failing) must match across
    // arms for a trustful label: baseline 5+0 vs candidate 4+1 = 5.
    const round = (arm: 'baseline' | 'candidate', n: number): Record<string, unknown> => ({
      arm, round: n, exitCode: arm === 'baseline' ? 0 : 1,
      killedByTimeout: false, hasRunnerSummary: true, infraSignal: false,
      reportedPassing: arm === 'candidate' ? 4 : 5,
      ...(arm === 'candidate' ? { reportedFailing: 1, failingTestNames: ['t'] } : {}),
      startedAt: '2026-08-31T00:00:00Z', durationMs: 10,
      rawStdoutSha256: H, rawStderrSha256: H, normalizedStdoutSha256: H, normalizedStderrSha256: H,
      logPath: `${arm}-${n}.stdout.log`, argv: ['node', 'x'], envKeys: ['PATH'],
      // Post-GLM Finding A: executionObservation is REQUIRED on every round
      // (contract floor) and a strong label additionally requires it VALID,
      // count/identity-matched to the text, pinned by runner bytes (panel H).
      executionObservation: arm === 'candidate' ? validObs(4, 1, ['t']) : validObs(5, 0, []),
    });
    const snap = (arm: string): Record<string, unknown> => ({
      rawStdoutLog: `tree-${arm}.treels.raw.log`, rawStdoutSha256: H,
      rawStderrLog: `tree-${arm}.treels.stderr.log`, rawStderrSha256: H,
      canonicalLog: `tree-${arm}.treels.canonical.json`, canonicalSha256: H,
    });
    const b: Record<string, unknown> = {
      schemaVersion: 1, runId: 'r', createdAt: '2026-08-31T00:00:00Z', canaryVersion: '0.1.0', experimentId: 'e',
      dependency: { package: 'widget', baselineVersion: '1.0.0', candidateVersion: '2.0.0' },
      downstream: { repositoryUrl: 'https://github.com/s/d', commitSha: 'b'.repeat(40), fetchMethod: 'tarball-by-sha', tarballSha256: H },
      environment: { nodeVersion: 'v22', npmVersion: '11', packageManagerUsed: 'npm', platform: 'win32', arch: 'x64', toolchainOverrides: {} },
      commands: { prepare: [], build: [], swap: ['node', 'swap.js'], test: ['node', 'test.js'] },
      rounds: [round('baseline', 1), round('baseline', 2), round('candidate', 1), round('candidate', 2)],
      treeComparison: {
        baselineTreeSha256: H, candidateTreeSha256: H, driftConfinedToDependency: true,
        observationStatus: { baseline: 'VALID', candidate: 'VALID' },
        resolvedVersions: { baseline: '1.0.0', candidate: '2.0.0' }, dependencyCopies: { baseline: 1, candidate: 1 },
        snapshots: { baseline: snap('baseline'), candidate: snap('candidate') },
        observationAnomalies: { baseline: { json: [] }, candidate: { json: [] } },
      },
      classification: { label: 'CONFIRMED_REGRESSION', rule: 5, reason: 'ok', reproductionCount: 2 },
    };
    b.integrity = integrityFor(b as never);
    return b;
  }
  const seal = (b: Record<string, unknown>): Record<string, unknown> => {
    b.integrity = integrityFor(b as never);
    return b;
  };

  it('trustful WITH snapshots + empty anomalies + consistent versions validates clean', () => {
    assert.deepEqual(validateBundle(baseTrustfulBundle()), []);
  });

  it('trustful WITHOUT retained snapshots is rejected (resealed)', () => {
    const b = baseTrustfulBundle();
    delete (b.treeComparison as Record<string, unknown>).snapshots;
    b.integrity = integrityFor(b as never);
    assert.ok(validateBundle(b).some((e) => /requires a retained treeComparison/.test(e)));
  });

  it('trustful with a MISSING anomaly array is rejected ("did not look" != "nothing found")', () => {
    const b = baseTrustfulBundle();
    delete (b.treeComparison as Record<string, unknown>).observationAnomalies;
    b.integrity = integrityFor(b as never);
    assert.ok(validateBundle(b).some((e) => /observationAnomalies/.test(e)));
  });

  it('trustful with NON-EMPTY recorded anomalies is rejected (partial observation cannot anchor trust)', () => {
    const b = baseTrustfulBundle();
    (b.treeComparison as { observationAnomalies: { candidate: { json: string[] } } }).observationAnomalies.candidate.json = ['missing-version:widget'];
    b.integrity = integrityFor(b as never);
    assert.ok(validateBundle(b).some((e) => /tree-observation anomalies/.test(e)));
  });

  it('resolvedVersions contradicting the dependency block is rejected (resealed attestation forgery)', () => {
    const b = baseTrustfulBundle();
    (b.treeComparison as { resolvedVersions: Record<string, string> }).resolvedVersions.candidate = '9.9.9';
    b.integrity = integrityFor(b as never);
    assert.ok(validateBundle(b).some((e) => /contradicts dependency\.candidateVersion/.test(e)));
  });

  it('snapshot artifact names must be arm-derived (candidate pointing at baseline bytes dies sealed)', () => {
    const b = baseTrustfulBundle();
    (b.treeComparison as { snapshots: { candidate: { rawStdoutLog: string } } }).snapshots.candidate.rawStdoutLog = 'tree-baseline.treels.raw.log';
    b.integrity = integrityFor(b as never);
    assert.ok(validateBundle(b).some((e) => /not this arm's canonical artifact name/.test(e)));
  });

  it('NON-trustful bundles may legitimately carry no snapshots (honest INCONCLUSIVE rule 10)', () => {
    const b = baseTrustfulBundle();
    (b.classification as Record<string, unknown>).label = 'INCONCLUSIVE';
    (b.classification as Record<string, unknown>).rule = 10;
    (b.treeComparison as { observationStatus: Record<string, string> }).observationStatus.candidate = 'INCOMPLETE';
    delete (b.treeComparison as Record<string, unknown>).snapshots;
    delete (b.treeComparison as Record<string, unknown>).observationAnomalies;
    assert.deepEqual(validateBundle(seal(b)), [],
      `honest rule-10 downgrade without snapshots must validate: ${validateBundle(seal(b)).join('; ')}`);
  });

  // Post-GLM Finding A floor — the observation tier is INDEPENDENT of the
  // tree tier: a strong label dies without VALID pinned observations even
  // when the whole tree side is perfect, and an honest non-strong bundle may
  // carry an ABSENT observation (the run attempted nothing).
  it('trustful label with rounds observation-ABSENT is rejected (rule-14 mirror, panel H)', () => {
    const b = baseTrustfulBundle();
    for (const r of b.rounds as Record<string, unknown>[]) {
      r.executionObservation = {
        status: 'ABSENT', absentKind: 'not-mocha-bin',
        observedFailingIdentities: [], framesSha256: sha256hex(''), frameCount: 0,
      };
    }
    const issues = validateBundle(seal(b));
    assert.ok(issues.some((i) => /strong labels require a VALID Canary observation on EVERY round \(panel H mirror\)/.test(i)),
      JSON.stringify(issues));
    assert.ok(issues.some((i) => /yields INCONCLUSIVE rule 14/.test(i)),
      `the re-derivation must route the label down too: ${issues.join('; ')}`);
  });

  it('trustful label with a VALID observation naming an UNPINNED runner is rejected (panel H/AM-1)', () => {
    const b = baseTrustfulBundle();
    for (const r of b.rounds as Record<string, unknown>[]) {
      const o = r.executionObservation as Record<string, unknown>;
      o.expectedMochaVersion = '99.99.99';
      o.observedMochaVersion = '99.99.99';
    }
    const issues = validateBundle(seal(b));
    assert.ok(issues.some((i) => /not a Canary-pinned release/.test(i)), JSON.stringify(issues));
  });

  it('trustful label whose observed counts DISAGREE with the text channel is rejected (cross-channel gate cannot be bypassed)', () => {
    const b = baseTrustfulBundle();
    for (const r of b.rounds as Record<string, unknown>[]) {
      const o = r.executionObservation as { observedCounts: { passing: number } };
      o.observedCounts.passing = 99;
    }
    const issues = validateBundle(seal(b));
    assert.ok(issues.some((i) => /observed counts disagree with text counts/.test(i)), JSON.stringify(issues));
  });
});
