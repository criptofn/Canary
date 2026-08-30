import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attachSummary, noOpProvider } from '../src/index.js';
import type { EvidenceBundle } from '@canary-rn/evidence-schema';

const base = {
  schemaVersion: 1, runId: 'r', createdAt: 'c', canaryVersion: 'v', experimentId: 'e',
  dependency: { package: 'axios', baselineVersion: 'a', candidateVersion: 'b' },
  downstream: { repositoryUrl: 'u', commitSha: 's', fetchMethod: 'tarball-by-sha', tarballSha256: 't' },
  environment: { nodeVersion: 'n', npmVersion: 'm', packageManagerUsed: 'npm', platform: 'p', arch: 'x', toolchainOverrides: {} },
  commands: { prepare: [], build: [], swap: [], test: [] },
  rounds: [],
  treeComparison: { baselineTreeSha256: 'h1', candidateTreeSha256: 'h2', driftConfinedToDependency: true },
  classification: { label: 'PASS', rule: 3, reason: 'clean', reproductionCount: 2 },
} as unknown as EvidenceBundle;

describe('AI adapter boundary', () => {
  it('noop provider attaches nothing', async () => {
    assert.equal(await noOpProvider.summarize({ bundle: base, logs: [] }), null);
    assert.equal(attachSummary(base, null), base);
  });

  it('attachSummary cannot alter any pre-existing field, including classification', async () => {
    const withAi = attachSummary(base, { provider: 'qwen', summary: 'looks risky', attachedAt: 'now' });
    assert.equal(withAi.classification.label, 'PASS');
    assert.equal(withAi.classification.rule, 3);
    for (const key of Object.keys(base)) {
      assert.deepEqual((withAi as never)[key], (base as never)[key], `field ${key} mutated by AI path`);
    }
    assert.equal(withAi.ai?.provider, 'qwen');
  });
});
