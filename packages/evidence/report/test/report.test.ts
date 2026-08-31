import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderHtml } from '../src/index.js';
import type { EvidenceBundle } from '@canary-rn/evidence-schema';

const H = 'a'.repeat(64);

const bundle = {
  schemaVersion: 1, runId: 'r1', createdAt: '2026-08-30T00:00:00Z', canaryVersion: '0.1.0',
  experimentId: 'e1',
  dependency: { package: 'axios', baselineVersion: '0.27.2', candidateVersion: '1.0.0' },
  downstream: { repositoryUrl: 'https://github.com/x/y', commitSha: 'b'.repeat(40), fetchMethod: 'tarball-by-sha', tarballSha256: H },
  environment: { nodeVersion: 'v26', npmVersion: '11', packageManagerUsed: 'npm', platform: 'win32', arch: 'x64', toolchainOverrides: { yargs: '16.2.2' } },
  commands: { prepare: [], build: [], swap: [], test: [] },
  rounds: [{
    arm: 'candidate', round: 1, exitCode: 3, killedByTimeout: false, hasRunnerSummary: true,
    startedAt: 'x', durationMs: 9, rawStdoutSha256: H, rawStderrSha256: H,
    normalizedStdoutSha256: '5e538c0b36ed83bc'.padEnd(64, '0'),
    normalizedStderrSha256: H, logPath: 'candidate-1.stdout.log', argv: ['node', 'mocha'], envKeys: ['PATH'],
  }],
  treeComparison: { baselineTreeSha256: H, candidateTreeSha256: H, driftConfinedToDependency: true, observationStatus: { baseline: 'VALID', candidate: 'VALID' }, resolvedVersions: { baseline: '0.27.2', candidate: '1.0.0' }, dependencyCopies: { baseline: 1, candidate: 1 } },
  classification: { label: 'CONFIRMED_REGRESSION', rule: 5, reason: 'all rounds failed', reproductionCount: 1 },
} as unknown as EvidenceBundle;

describe('renderHtml', () => {
  const html = renderHtml(bundle, { failingTestNames: ['handles baseURL correctly'] });

  it('renders the deterministic verdict verbatim', () => {
    assert.ok(html.includes('CONFIRMED_REGRESSION — rule 5'));
    assert.ok(html.includes('reproduced 1×'));
  });

  it('shows hash prefixes and log paths for audit', () => {
    assert.ok(html.includes('5e538c0b36ed83bc'));
    assert.ok(html.includes('candidate-1.stdout.log'));
  });

  it('states the drift-confinement result', () => {
    assert.ok(html.includes('arms differ only by the studied dependency'));
  });

  it('escapes hostile content from downstream logs/names (no HTML injection)', () => {
    const evil = renderHtml({
      ...bundle,
      classification: { ...bundle.classification, reason: '<script>alert(1)</script>' },
    }, { failingTestNames: ['<img src=x onerror=alert(2)>'] });
    assert.ok(!evil.includes('<script>alert'));
    assert.ok(evil.includes('&lt;script&gt;'));
  });

  it('audit F12: renders failing-test identities derived from the BUNDLE (no extras)', () => {
    const withNames = {
      ...bundle,
      rounds: [{ ...bundle.rounds[0], failingTestNames: ['handles baseURL correctly', 'can pass headers'] }],
    } as unknown as EvidenceBundle;
    const h = renderHtml(withNames); // NO extras argument — must derive from rounds
    assert.match(h, /Failing downstream tests \(candidate\)/);
    assert.match(h, /handles baseURL correctly/);
    assert.match(h, /can pass headers/);
  });

  it('audit F12: a bundle with no failing identities omits the section', () => {
    // The base `bundle` round has no failingTestNames; renderHtml without
    // extras must not fabricate an empty section.
    const h = renderHtml(bundle);
    assert.ok(!/Failing downstream tests/.test(h));
  });
});
