import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { verifyArtifacts, assertProof, type ProofExpectation } from '../src/prove.js';
import { sha256hex } from '@canary-rn/hashing';
import type { EvidenceBundle, RoundEvidence } from '@canary-rn/evidence-schema';

/** Real files on disk, real hashes — no mocks (audit F3/F4 spirit). */
function harness(): { dir: string; bundle: EvidenceBundle; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-prove-'));
  const write = (name: string, content: string): string => {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
    return sha256hex(content);
  };
  const mkRound = (arm: 'baseline' | 'candidate', n: number): RoundEvidence => {
    const label = `${arm}-${n}`;
    return {
      arm, round: n, exitCode: arm === 'baseline' ? 0 : 3,
      killedByTimeout: false, hasRunnerSummary: true, infraSignal: false,
      ...(arm === 'candidate' ? { reportedFailing: 3, failingTestNames: ['t'] } : {}),
      startedAt: '2026-08-30T00:00:00Z', durationMs: 10,
      rawStdoutSha256: write(`${label}.stdout.log`, `raw-out-${label}`),
      rawStderrSha256: write(`${label}.stderr.log`, `raw-err-${label}`),
      normalizedStdoutSha256: write(`${label}.stdout.norm`, `norm-out-${label}`),
      normalizedStderrSha256: write(`${label}.stderr.norm`, `norm-err-${label}`),
      logPath: `${label}.stdout.log`, argv: ['node', 'x'], envKeys: ['PATH'],
    };
  };
  const bundle = {
    schemaVersion: 1, runId: 'r', createdAt: '2026-08-30T00:00:00Z', canaryVersion: '0.1.0',
    experimentId: 'e', dependency: { package: 'p', baselineVersion: '1', candidateVersion: '2' },
    downstream: { repositoryUrl: 'u', commitSha: 'b'.repeat(40), fetchMethod: 'tarball-by-sha', tarballSha256: 'a'.repeat(64) },
    environment: { nodeVersion: 'v', npmVersion: 'n', packageManagerUsed: 'npm', platform: 'x', arch: 'y', toolchainOverrides: {} },
    commands: { prepare: [['a']], build: [], swap: ['b'], test: ['c'] },
    rounds: [mkRound('baseline', 1), mkRound('candidate', 1)],
    treeComparison: { baselineTreeSha256: 'a'.repeat(64), candidateTreeSha256: 'b'.repeat(64), driftConfinedToDependency: true, resolvedVersions: { baseline: '1', candidate: '2' }, dependencyCopies: { baseline: 1, candidate: 1 } },
    classification: { label: 'CONFIRMED_REGRESSION', rule: 5, reason: 'ok', reproductionCount: 1 },
  } as EvidenceBundle;
  return { dir, bundle, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('verifyArtifacts — audit F4 (proof must rehash the real artifacts)', () => {
  it('accepts a bundle whose every recorded hash matches the file on disk', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      assert.deepEqual(verifyArtifacts(dir, bundle), []);
    } finally { cleanup(); }
  });

  it('rejects a tampered raw stdout (recorded hash kept, content swapped)', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      fs.writeFileSync(path.join(dir, 'baseline-1.stdout.log'), 'forged run output');
      const issues = verifyArtifacts(dir, bundle);
      assert.equal(issues.length, 1);
      assert.match(issues[0]!, /TAMPERED artifact baseline-1\.stdout\.log/);
    } finally { cleanup(); }
  });

  it('rejects a tampered normalized stdout independently of the raw one', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      fs.writeFileSync(path.join(dir, 'candidate-1.stdout.norm'), 'rewritten normalized history');
      const issues = verifyArtifacts(dir, bundle);
      assert.equal(issues.length, 1);
      assert.match(issues[0]!, /TAMPERED artifact candidate-1\.stdout\.norm/);
    } finally { cleanup(); }
  });

  it('rejects quietly deleted stderr artifacts', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      fs.rmSync(path.join(dir, 'candidate-1.stderr.log'));
      const issues = verifyArtifacts(dir, bundle);
      assert.equal(issues.length, 1);
      assert.match(issues[0]!, /artifact missing: candidate-1\.stderr\.log/);
    } finally { cleanup(); }
  });

  it('rejects all four substituted files of one round (raw, raw-err, norm, norm-err)', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      for (const f of ['candidate-1.stdout.log', 'candidate-1.stderr.log', 'candidate-1.stdout.norm', 'candidate-1.stderr.norm']) {
        fs.writeFileSync(path.join(dir, f), 'x');
      }
      assert.equal(verifyArtifacts(dir, bundle).length, 4);
    } finally { cleanup(); }
  });

  it('flags a logPath that breaks the artifact-name contract', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      (bundle.rounds[0] as { logPath: string }).logPath = 'weird-name.txt';
      const issues = verifyArtifacts(dir, bundle);
      assert.equal(issues.length, 1);
      assert.match(issues[0]!, /unexpected logPath/);
    } finally { cleanup(); }
  });
});

const CAND_LOG = [
  '  suite', '    √ ok one', '', '  1 passing (1ms)', '  1 failing', '',
  '  1) suite', '       candidate breaks widget:', '     Error: nope', '',
].join('\n');
const BASE_LOG = '  2 passing (1ms)\n';

describe('assertProof — audit F11 (portable vs host-exact assertions)', () => {
  function proofFor(bundle: EvidenceBundle, withHost: boolean): ProofExpectation {
    const hashes = (arm: 'baseline' | 'candidate') =>
      bundle.rounds.filter((r) => r.arm === arm).map((r) => r.normalizedStdoutSha256);
    return {
      schema: 1, experimentId: 'e',
      dependency: { package: 'p', baseline: '1', candidate: '2' },
      downstream: { repo: 'u', commit: 'b'.repeat(40) },
      ...(withHost
        ? { proofHost: { platform: bundle.environment.platform, arch: bundle.environment.arch, nodeVersion: bundle.environment.nodeVersion, npmVersion: bundle.environment.npmVersion } }
        : {}),
      expected: {
        classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
        baseline: { rounds: 1, exitCodes: [0], normalizedStdoutSha256AcrossRounds: hashes('baseline'), summary: { passing: 2 } },
        candidate: { rounds: 1, exitCodes: [3], normalizedStdoutSha256AcrossRounds: hashes('candidate'), summary: { passing: 1, failing: 1 } },
        failingTestNames: ['suite > candidate breaks widget'],
      },
    };
  }
  const run = (bundle: EvidenceBundle, proof: ProofExpectation) =>
    assertProof(bundle, proof, { candidateStdout: CAND_LOG, baselineStdout: BASE_LOG });

  it('no proofHost (legacy proof file): hash assertions run unconditionally (strict)', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      const checks = run(bundle, proofFor(bundle, false));
      const hash = checks.find((c) => c.name === 'candidate normalized stdout hashes')!;
      assert.equal(hash.ok, true);
      assert.equal(hash.skipped, undefined);
    } finally { cleanup(); }
  });

  it('matching proofHost: every assertion including hashes evaluates', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      const checks = run(bundle, proofFor(bundle, true));
      assert.equal(checks.some((c) => c.skipped), false);
      assert.equal(checks.every((c) => c.ok), true);
    } finally { cleanup(); }
  });

  it('off-proof-host: ONLY the two hash comparisons skip (flagged, not silent); every portable assertion still evaluates', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      const proof = proofFor(bundle, true);
      proof.proofHost = { ...proof.proofHost!, nodeVersion: 'v99.0.0' }; // a host that is NOT this one
      const checks = run(bundle, proof);
      const skipped = checks.filter((c) => c.skipped);
      assert.deepEqual(skipped.map((c) => c.name).sort(), [
        'baseline normalized stdout hashes [SKIPPED: not proof host x/y/node v99.0.0]',
        'candidate normalized stdout hashes [SKIPPED: not proof host x/y/node v99.0.0]',
      ]);
      // determinism-within-arm is host-INDEPENDENT and must NOT skip:
      assert.ok(checks.some((c) => c.name === 'candidate arm internally deterministic' && !c.skipped));
      // a real portable violation is still FAIL even while hashes skip:
      proof.expected.rule = 7;
      const diverged = run(bundle, proof);
      const bad = diverged.find((c) => c.name === 'rule')!;
      assert.equal(bad.ok, false);
      assert.equal(bad.skipped, undefined);
    } finally { cleanup(); }
  });

  it('off-proof-host with tampered committed hashes still passes portable checks (and this is exactly why verifyArtifacts exists)', () => {
    // Documents the F11/F4 complementarity: when hashes skip, proof integrity
    // comes from re-hashing the on-disk artifacts, not from the proof file.
    const { dir, bundle, cleanup } = harness();
    try {
      const proof = proofFor(bundle, true);
      proof.proofHost = { ...proof.proofHost!, npmVersion: '99' };
      proof.expected.candidate.normalizedStdoutSha256AcrossRounds = ['0'.repeat(64)]; // wrong on purpose
      const checks = run(bundle, proof);
      assert.equal(checks.filter((c) => !c.ok).length, 0); // skipped, not failed
      assert.equal(verifyArtifacts(dir, bundle).length, 0); // artifacts still self-consistent
    } finally { cleanup(); }
  });
});
