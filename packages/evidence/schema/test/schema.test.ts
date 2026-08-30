import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateBundle, EVIDENCE_SCHEMA_VERSION } from '../src/index.js';

const H = 'a'.repeat(64);
const SHA40 = 'b8804442837556a2c7673caeb2925688991b610c';

function goodBundle(): Record<string, unknown> {
  const round = (arm: 'baseline' | 'candidate', n: number) => ({
    arm, round: n, exitCode: arm === 'baseline' ? 0 : 3,
    killedByTimeout: false, hasRunnerSummary: true,
    startedAt: '2026-08-30T00:00:00Z', durationMs: 120,
    rawStdoutSha256: H, rawStderrSha256: H,
    normalizedStdoutSha256: H, normalizedStderrSha256: H,
    logPath: `${arm}-${n}.stdout.log`, argv: ['node', 'x'], envKeys: ['PATH'],
  });
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: 'r1', createdAt: '2026-08-30T00:00:00Z', canaryVersion: '0.1.0', experimentId: 'e1',
    dependency: { package: 'axios', baselineVersion: '0.27.2', candidateVersion: '1.0.0' },
    downstream: { repositoryUrl: 'https://github.com/x/y', commitSha: SHA40, fetchMethod: 'tarball-by-sha', tarballSha256: H },
    environment: { nodeVersion: 'v26', npmVersion: '11', packageManagerUsed: 'npm', platform: 'win32', arch: 'x64', toolchainOverrides: {} },
    commands: { prepare: [['a']], build: [], swap: ['b'], test: ['c'] },
    rounds: [round('baseline', 1), round('baseline', 2), round('candidate', 1)],
    treeComparison: { baselineTreeSha256: H, candidateTreeSha256: H, driftConfinedToDependency: true, resolvedVersions: { baseline: '0.27.2', candidate: '1.0.0' }, dependencyCopies: { baseline: 1, candidate: 2 } },
    classification: { label: 'CONFIRMED_REGRESSION', rule: 5, reason: 'ok', reproductionCount: 1 },
  };
}

describe('validateBundle', () => {
  it('accepts a well-formed bundle', () => {
    assert.deepEqual(validateBundle(goodBundle()), []);
  });

  it('rejects an unknown classification label', () => {
    const b = goodBundle();
    (b.classification as Record<string, unknown>).label = 'LGTM_SHIP_IT';
    assert.ok(validateBundle(b).some((e) => /label/.test(e)));
  });

  it('rejects short/hexless commit SHAs (no branch pins in evidence)', () => {
    const b = goodBundle();
    (b.downstream as Record<string, unknown>).commitSha = 'main';
    assert.ok(validateBundle(b).some((e) => /commitSha/.test(e)));
  });

  it('rejects a bundle missing an arm', () => {
    const b = goodBundle();
    b.rounds = (b.rounds as object[]).filter((r) => (r as Record<string, unknown>).arm !== 'candidate');
    assert.ok(validateBundle(b).some((e) => /candidate rounds/.test(e)));
  });

  it('rejects malformed stream hashes', () => {
    const b = goodBundle();
    const r0 = (b.rounds as Record<string, unknown>[])[0]!;
    r0.normalizedStdoutSha256 = 'not-a-hash';
    assert.ok(validateBundle(b).some((e) => /normalizedStdoutSha256/.test(e)));
  });

  it('rejects a round whose envKeys leak outside the sanitized allowlist (F9)', () => {
    const b = goodBundle();
    ((b.rounds as Record<string, unknown>[])[0]!.envKeys as string[]).push('ANTHROPIC_API_KEY');
    assert.ok(validateBundle(b).some((e) => /non-allowlisted/.test(e)));
  });

  it('rejects reproductionCount < 1', () => {
    const b = goodBundle();
    (b.classification as Record<string, unknown>).reproductionCount = 0;
    assert.ok(validateBundle(b).some((e) => /reproductionCount/.test(e)));
  });
});
