/**
 * Round-3 blocker 3 — PROOF HOST / EVIDENCE TRUST BOUNDARY (permanent e2e).
 *
 * The Round-3 audit demonstrated: copy a valid bundle, coherently reseed the
 * mutable host metadata (node/npm version), and `check` decided it was "not
 * the proof host", politely SKIPPED every strict assertion, and still walked
 * out EXIT 0 claiming PASS; the HTML report rendered the forged bundle as
 * VERIFIED. Root cause: host-exactness was decided FROM THE EVIDENCE.
 *
 * These tests run a REAL offline pipeline experiment, then replay the audit
 * attack through cmdProve's exact gate order (validate -> digests -> bytes ->
 * tree snapshots -> assertProof with the ACTUAL runtime -> verdict) and the
 * report attestation path. The attack must now FAIL or downgrade — never
 * reach a PASS/VERIFIED claim.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runExperiment } from '../src/pipeline.js';
import { validateBundle, integrityFor, type EvidenceBundle } from '@canary-rn/evidence-schema';
import {
  assertProof, actualHostFingerprint, environmentAttestationIssues, proofVerdict,
  verifyArtifacts, verifyArtifactSemantics, verifyRunIdentity,
  verifyClassificationDerivation, hostBoundEvidenceChecks,
  type ProofExpectation, type HostFingerprint, type TrustedRunSpec,
} from '../src/prove.js';
import { verifyTreeSnapshots } from '../src/verify-tree.js';
import { sha256hex } from '@canary-rn/hashing';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-b3-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const FAKE_SHA = 'a'.repeat(40);
const RUNTIME: HostFingerprint = actualHostFingerprint();

function writeStub(dir: string): void {
  const w = (p: string, s: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, 'utf8');
  };
  w(path.join(dir, 'package.json'), JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
  w(path.join(dir, 'node_modules', 'widget', 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0', main: 'index.js' }));
  w(path.join(dir, 'node_modules', 'widget', 'index.js'), 'module.exports={}');
  w(path.join(dir, 'test.js'), [
    "const v=require('./node_modules/widget/package.json').version;",
    "if (v !== '2.0.0') { console.log('  2 passing (1ms)'); process.exit(0); }",
    "console.log('  1 passing (1ms)'); console.log('  1 failing'); console.log('');",
    "console.log('  1) widget suite'); console.log('       candidate breaks widget:');",
    "process.exit(1);",
  ].join('\n'));
  w(path.join(dir, 'swap.js'),
    "const fs=require('fs');const p='./node_modules/widget/package.json';const j=JSON.parse(fs.readFileSync(p));j.version='2.0.0';fs.writeFileSync(p,JSON.stringify(j));");
}

async function realRun(): Promise<{ bundle: EvidenceBundle; artifactsDir: string; proof: ProofExpectation; spec: TrustedRunSpec }> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = path.join(repoRoot, 'stub-src');
  writeStub(stub);
  const spec = {
    schema: 2, id: 'host-b3', dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: { prepare: [['node', '-e', "''"]], swap: ['node', 'swap.js', '{candidate}'], test: ['node', 'test.js'] },
    repeats: { baseline: 2, candidate: 2 }, timeoutSecs: { install: 120, test: 120 },
  } satisfies TrustedRunSpec & Record<string, unknown>;
  // B4: the fetch seam declares the REAL digest of its bytes — the prove gate
  // re-hashes the retained fixture.tgz against it.
  const bytes = Buffer.from('canary-proof-host-stub-tarball');
  const result = await runExperiment(spec, repoRoot, true, {
    fetch: async () => ({ bytes, sha256: sha256hex(bytes) }),
    extract: (_t, ws) => fs.cpSync(stub, path.join(ws, `downstream-${FAKE_SHA}`), { recursive: true }),
  });
  const b = result.bundle;
  const hashes = (arm: 'baseline' | 'candidate') => b.rounds.filter((r) => r.arm === arm).map((r) => r.normalizedStdoutSha256);
  // Golden-style committed proof: the proof host is DECLARED by the proof
  // file (here: the machine the fixture was produced on == this machine).
  const proof: ProofExpectation = {
    schema: 1, experimentId: 'host-b3', evidenceSchema: 1,
    proofHost: { ...RUNTIME },
    tarballSha256: b.downstream.tarballSha256, // B4 pin
    environment: { platform: RUNTIME.platform, arch: RUNTIME.arch, nodeVersion: RUNTIME.nodeVersion, npmVersion: RUNTIME.npmVersion },
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    expected: {
      classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
      baseline: { rounds: 2, exitCodes: [0, 0], normalizedStdoutSha256AcrossRounds: hashes('baseline'), summary: { passing: 2 } },
      candidate: { rounds: 2, exitCodes: [1, 1], normalizedStdoutSha256AcrossRounds: hashes('candidate'), summary: { passing: 1, failing: 1 } },
      failingTestNames: ['widget suite > candidate breaks widget'],
    },
  };
  return { bundle: b, artifactsDir: result.artifactsDir, proof, spec };
}

/** cmdProve's exact gate order (round-3 B4 included), returning the CLI verdict. */
function fullGate(bundle: EvidenceBundle, dir: string, proof: ProofExpectation, runtime: HostFingerprint, spec: TrustedRunSpec) {
  const v = validateBundle(bundle);
  if (v.length) return { at: 'validateBundle' as const, issues: v, verdict: null };
  const a = verifyArtifacts(dir, bundle);
  if (a.length) return { at: 'verifyArtifacts' as const, issues: a, verdict: null };
  const s = verifyArtifactSemantics(dir, bundle);
  if (s.length) return { at: 'verifyArtifactSemantics' as const, issues: s, verdict: null };
  const i = verifyRunIdentity(dir, bundle);
  if (i.length) return { at: 'verifyRunIdentity' as const, issues: i, verdict: null };
  const t = verifyTreeSnapshots(bundle, dir);
  if (t.length) return { at: 'verifyTreeSnapshots' as const, issues: t, verdict: null };
  const d = verifyClassificationDerivation(dir, bundle);
  if (d.length) return { at: 'verifyClassificationDerivation' as const, issues: d, verdict: null };
  const readLog = (arm: 'baseline' | 'candidate'): string => {
    const p = path.join(dir, `${arm}-1.stdout.log`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const checks = assertProof(bundle, proof, {
    candidateStdout: readLog('candidate'), baselineStdout: readLog('baseline'),
  }, runtime);
  checks.push(...hostBoundEvidenceChecks(bundle, proof, spec, dir, runtime));
  return { at: 'assertProof' as const, issues: [], verdict: proofVerdict(checks) };
}

describe('round-3 B3 — the proof host is the ACTUAL runtime, never the evidence', () => {
  it('pristine run + proofHost = this machine: full gate PASSes with ZERO skipped assertions', async () => {
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const g = fullGate(bundle, artifactsDir, proof, RUNTIME, spec);
    assert.equal(g.at, 'assertProof', JSON.stringify(g.issues));
    assert.equal(g.verdict!.status, 'PASS', JSON.stringify(g.verdict!.failed.map((f) => f.name)));
    assert.equal(g.verdict!.skipped.length, 0, 'on the proof host nothing may skip');
    assert.equal(g.verdict!.exitCode, 0);
    // and the report attestation is silent for a truthful bundle here:
    assert.deepEqual(environmentAttestationIssues(bundle, RUNTIME), []);
  });

  it('THE AUDIT ATTACK: reseal host metadata to dodge host checks -> gate FAILS (exit 1), never skip-to-PASS', async () => {
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const forged = structuredClone(bundle) as EvidenceBundle;
    // Coherent reseal: lie about the environment (fake node + npm, plausible
    // platform) AND recompute the manifest. Pre-B3 this made the evidence
    // "not the proof host" -> hashes skipped -> failed=0 -> PASS exit 0.
    forged.environment.nodeVersion = 'v0.0.1';
    forged.environment.npmVersion = '0.0.1';
    forged.integrity = integrityFor(forged);
    const g = fullGate(forged, artifactsDir, proof, RUNTIME, spec);
    assert.equal(g.at, 'assertProof', `forgery must reach the assertions, got ${g.at}: ${g.issues.join('; ')}`);
    assert.ok(g.verdict, 'must produce a verdict');
    assert.equal(g.verdict!.status, 'FAIL', 'resealed host metadata must FAIL, not downgrade quietly');
    assert.equal(g.verdict!.exitCode, 1);
    assert.ok(g.verdict!.failed.some((f) => /environment/i.test(f.name)),
      JSON.stringify(g.verdict!.failed.map((f) => f.name)));
    assert.equal(g.verdict!.skipped.length, 0, 'no check may skip on the proof host');
    // REPORT path: the same copy rendered here must NOT be VERIFIED.
    assert.ok(environmentAttestationIssues(forged, RUNTIME).length === 1,
      'report must carry a host-attestation note (UNVERIFIED banner)');
    assert.match(environmentAttestationIssues(forged, RUNTIME)[0]!, /v0\.0\.1/);
  });

  it('resealing the environment TO MATCH the real machine is not an attack: identity is reality, not paper', async () => {
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const copy = structuredClone(bundle) as EvidenceBundle;
    copy.createdAt = '2020-01-01T00:00:00.000Z'; // a field prove does not pin
    copy.integrity = integrityFor(copy);
    // The four ATTESTED identity fields (platform/arch/nodeVersion/npmVersion)
    // are untouched (== the real machine), so the binding holds and the gate
    // outcome matches pristine. B3 claims nothing about fields it never reads.
    const g = fullGate(copy, artifactsDir, proof, RUNTIME, spec);
    assert.equal(g.at, 'assertProof');
    assert.equal(g.verdict!.status, 'PASS');
  });

  it('off the proof host (simulate a foreign runtime): strict checks SKIP and the verdict INCOMPLETE (exit 2) — PASS is not claimed', async () => {
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const foreign: HostFingerprint = { platform: 'linux', arch: 'x64', nodeVersion: 'v22.99.0', npmVersion: '99.99.99' };
    const g = fullGate(bundle, artifactsDir, proof, foreign, spec);
    assert.equal(g.at, 'assertProof');
    assert.equal(g.verdict!.status, 'INCOMPLETE');
    assert.equal(g.verdict!.exitCode, 2);
    assert.ok(g.verdict!.skipped.length >= 3, `hash + binding assertions must skip: ${JSON.stringify(g.verdict!.skipped.map((s) => s.name))}`);
    // and the report downgrade for foreign evidence: attestation note fires.
    assert.ok(environmentAttestationIssues(bundle, foreign).length === 1);
  });

  it('post-sol F1 — SELF-CONSISTENT is NOT proof-agreement: a bundle fully consistent on this machine can still FAIL check against a diverged committed proof', async () => {
    const { bundle, artifactsDir, proof, spec } = await realRun();
    // The bundle is honest: every report-layer check (digests, bytes, run
    // identity, tree snapshots, classification derivation, host attestation)
    // is silent here, on the recording machine.
    const reportNotes = [
      ...verifyArtifacts(artifactsDir, bundle),
      ...verifyArtifactSemantics(artifactsDir, bundle),
      ...verifyRunIdentity(artifactsDir, bundle),
      ...verifyClassificationDerivation(artifactsDir, bundle),
      ...verifyTreeSnapshots(bundle, artifactsDir),
      ...environmentAttestationIssues(bundle, RUNTIME),
    ];
    assert.deepEqual(reportNotes, [], 'pristine evidence must be self-consistent on this machine');
    // Yet a committed proof that pins a DIFFERENT expected property must FAIL
    // — proof agreement is a separate, stronger check report never performed.
    const divergedProof: ProofExpectation = structuredClone(proof);
    divergedProof.expected.classification = 'PASS';
    const readLog = (arm: 'baseline' | 'candidate'): string => {
      const p = path.join(artifactsDir, `${arm}-1.stdout.log`);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    };
    const checks = assertProof(bundle, divergedProof, {
      candidateStdout: readLog('candidate'), baselineStdout: readLog('baseline'),
    }, RUNTIME);
    checks.push(...hostBoundEvidenceChecks(bundle, divergedProof, spec, artifactsDir, RUNTIME));
    const v = proofVerdict(checks);
    assert.equal(v.status, 'FAIL', 'self-consistency must not imply proof agreement');
    assert.ok(v.failed.some((f) => f.name === 'classification'), JSON.stringify(v.failed.map((f) => f.name)));
  });

  it('a lying proof file cannot flip the verdict either: proofHost=foreign while running here still skips (evidence-agnostic)', async () => {
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const badProof: ProofExpectation = { ...proof, proofHost: { platform: 'os2', arch: 'ppc', nodeVersion: 'v1', npmVersion: '1' } };
    const g = fullGate(bundle, artifactsDir, badProof, RUNTIME, spec);
    assert.equal(g.at, 'assertProof');
    // we are NOT the (committed) proof host -> skip -> INCOMPLETE, never PASS;
    // and the portable platform/arch pin FAILS against the real claim too.
    assert.equal(g.verdict!.status === 'INCOMPLETE' || g.verdict!.status === 'FAIL', true,
      `verdict=${g.verdict!.status}`);
    assert.notEqual(g.verdict!.exitCode, 0, 'off-host must never exit 0');
  });
});
