/**
 * Audit B4 — evidence provenance: controlled forgery matrix.
 *
 * Builds a REAL (offline) confirmed-regression run, then mutates the bundle
 * the way the Codex re-audit described ("rewritten without invalidating
 * check") and runs the FULL check gate in cmdProve's order:
 *   validateBundle (semantic re-derivation + manifest integrity)
 *   -> verifyArtifacts (digest <-> on-disk bytes)
 *   -> verifyArtifactSemantics (recorded round facts <-> artifact bytes)
 *   -> assertProof (identity/repo/runtime/exit-codes vs the committed proof).
 *
 * For each forgery we record which LAYER refuses it. Two variants per case:
 *   naive     — field rewritten, manifest NOT recomputed  (integrity layer)
 *   resealed  — field rewritten AND manifest recomputed by the forger
 *               (must be caught by a layer that checks against BYTES or the
 *               trusted proof, not against the bundle's own say-so).
 * Where resealed genuinely evades (host-absolute argv, non-reproducible
 * tarball bytes) we assert the naive catch and the test file's header records
 * it as an honest limitation — never claim a guarantee we don't have.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runExperiment } from '../src/pipeline.js';
import { validateBundle, integrityFor, type EvidenceBundle } from '@canary-rn/evidence-schema';
import { assertProof, verifyArtifacts, verifyArtifactSemantics, type ProofExpectation } from '../src/prove.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-prov-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const FAKE_SHA = 'a'.repeat(40);

function writeStub(dir: string): void {
  fs.mkdirSync(path.join(dir, 'node_modules', 'widget'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'widget', 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'widget', 'index.js'), 'module.exports={}');
  fs.writeFileSync(path.join(dir, 'test.js'), [
    "const v=require('./node_modules/widget/package.json').version;",
    "if (v !== '2.0.0') { console.log('  2 passing (1ms)'); process.exit(0); }",
    "console.log('  1 passing (1ms)'); console.log('  1 failing'); console.log('');",
    "console.log('  1) widget suite'); console.log('       candidate breaks widget:');",
    "process.exit(1);",
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'swap.js'),
    "const fs=require('fs');const p='./node_modules/widget/package.json';const j=JSON.parse(fs.readFileSync(p));j.version='2.0.0';fs.writeFileSync(p,JSON.stringify(j));");
}

async function realRun(): Promise<{ bundle: EvidenceBundle; artifactsDir: string; proof: ProofExpectation }> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = path.join(repoRoot, 'stub-src');
  writeStub(stub);
  const result = await runExperiment({
    schema: 2, id: 'prov', dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: { prepare: [['node', '-e', "''"]], swap: ['node', 'swap.js', '{candidate}'], test: ['node', 'test.js'] },
    repeats: { baseline: 2, candidate: 2 }, timeoutSecs: { install: 120, test: 120 },
  }, repoRoot, true, {
    fetch: async () => ({ bytes: Buffer.alloc(0), sha256: 'b'.repeat(64) }),
    extract: (_t, ws) => fs.cpSync(stub, path.join(ws, `downstream-${FAKE_SHA}`), { recursive: true }),
  });
  assert.equal(result.bundle.classification.label, 'CONFIRMED_REGRESSION', 'pristine run must confirm');
  const b = result.bundle;
  const hashes = (arm: 'baseline' | 'candidate') => b.rounds.filter((r) => r.arm === arm).map((r) => r.normalizedStdoutSha256);
  const proof: ProofExpectation = {
    schema: 1, experimentId: 'prov', evidenceSchema: 1,
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    environment: { platform: b.environment.platform, arch: b.environment.arch },
    expected: {
      classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
      baseline: { rounds: 2, exitCodes: [0, 0], normalizedStdoutSha256AcrossRounds: hashes('baseline'), summary: { passing: 2 } },
      candidate: { rounds: 2, exitCodes: [1, 1], normalizedStdoutSha256AcrossRounds: hashes('candidate'), summary: { passing: 1, failing: 1 } },
      failingTestNames: ['widget suite > candidate breaks widget'],
    },
  };
  return { bundle: b, artifactsDir: result.artifactsDir, proof };
}

const readLog = (dir: string, arm: string): string => {
  const p = path.join(dir, `${arm}-1.stdout.log`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

/** Mirror cmdProve's gate; return the FIRST layer that refuses, or 'NONE'. */
function gate(bundle: EvidenceBundle, dir: string, proof: ProofExpectation): { layer: string; detail: string } {
  const v = validateBundle(bundle);
  if (v.length) return { layer: 'validateBundle', detail: v.join('; ') };
  const a = verifyArtifacts(dir, bundle);
  if (a.length) return { layer: 'verifyArtifacts', detail: a.join('; ') };
  const s = verifyArtifactSemantics(dir, bundle);
  if (s.length) return { layer: 'verifyArtifactSemantics', detail: s.join('; ') };
  const failed = assertProof(bundle, proof, { candidateStdout: readLog(dir, 'candidate'), baselineStdout: readLog(dir, 'baseline') }).filter((c) => !c.ok);
  if (failed.length) return { layer: 'assertProof', detail: failed.map((f) => f.name).join(', ') };
  return { layer: 'NONE', detail: '' };
}

/** Deep-clone, mutate, optionally re-seal, gate. */
async function forge(mutate: (b: EvidenceBundle) => void, recompute: boolean): Promise<{ layer: string; detail: string }> {
  const { bundle, artifactsDir, proof } = await realRun();
  const clone = structuredClone(bundle) as EvidenceBundle;
  mutate(clone);
  if (recompute) clone.integrity = integrityFor(clone);
  return gate(clone, artifactsDir, proof);
}

describe('audit B4 — provenance forgery matrix (which layer refuses)', () => {
  it('pristine run passes the whole gate', async () => {
    const { bundle, artifactsDir, proof } = await realRun();
    assert.equal(gate(bundle, artifactsDir, proof).layer, 'NONE');
  });

  // ---- byte-derivable facts: caught by verifyArtifactSemantics even RESEALED.
  // We forge INTERNALLY-CONSISTENTLY (same wrong value on every candidate round)
  // so validateBundle's own re-derivation still agrees with the forged record —
  // the ONLY thing that can catch it is re-reading the actual artifact bytes. ----
  it('rewriting failure counts is caught by byte re-derivation (resealed, internally consistent)', async () => {
    const g = await forge((b) => { for (const c of b.rounds) if (c.arm === 'candidate') c.reportedFailing = 2; }, true);
    assert.equal(g.layer, 'verifyArtifactSemantics', JSON.stringify(g));
    assert.match(g.detail, /reportedFailing/);
  });
  it('rewriting failing-test identities is caught by byte re-derivation (resealed)', async () => {
    const g = await forge((b) => { for (const c of b.rounds) if (c.arm === 'candidate') c.failingTestNames = ['a consistent wrong name']; }, true);
    assert.equal(g.layer, 'verifyArtifactSemantics', JSON.stringify(g));
    assert.match(g.detail, /failingTestNames/, JSON.stringify(g));
  });
  it('NEW: per-round name/value disagreement with bytes is caught (one round forged)', async () => {
    const g = await forge((b) => {
      const cands = b.rounds.filter((r) => r.arm === 'candidate');
      if (cands[1]) cands[1].failingTestNames = ['not in this round'];
    }, true);
    // internally inconsistent (profiles differ) so validateBundle's re-derivation
    // catches it first; either way it must NOT reach the bytes-blind NONE state.
    assert.notEqual(g.layer, 'NONE', JSON.stringify(g));
    assert.doesNotMatch(g.detail, /manifestSha256/, 'a resealed forgery must not slip past');
  });
  it('rewriting digests away from bytes is caught by verifyArtifacts (resealed)', async () => {
    const g = await forge((b) => { b.rounds[0]!.rawStdoutSha256 = 'f'.repeat(64); }, true);
    assert.equal(g.layer, 'verifyArtifacts', JSON.stringify(g));
  });

  // ---- proof-pinned identity: caught by assertProof even resealed ----
  it('rewriting the repo URL is caught by the committed proof (resealed)', async () => {
    const g = await forge((b) => { b.downstream.repositoryUrl = 'https://github.com/evil/repo'; }, true);
    assert.equal(g.layer, 'assertProof', JSON.stringify(g));
    assert.match(g.detail, /repository pinned/);
  });
  it('rewriting experimentId is caught by the committed proof (resealed)', async () => {
    const g = await forge((b) => { b.experimentId = 'other'; }, true);
    assert.equal(g.layer, 'assertProof');
    assert.match(g.detail, /experiment identity/);
  });
  it('rewriting the pinned commit is caught by the committed proof (resealed)', async () => {
    const g = await forge((b) => { b.downstream.commitSha = 'c'.repeat(40); }, true);
    assert.equal(g.layer, 'assertProof');
    assert.match(g.detail, /commit pinned/);
  });
  it('rewriting runtime platform is caught by the committed proof (resealed)', async () => {
    const g = await forge((b) => { b.environment.platform = 'plan9'; }, true);
    assert.equal(g.layer, 'assertProof');
    assert.match(g.detail, /platform\/arch|environment/);
  });

  // ---- tree facts: caught even resealed by semantics/proof ----
  it('flipping drift-confined to false is caught (resealed) — trustful+unconfined', async () => {
    const g = await forge((b) => { b.treeComparison.driftConfinedToDependency = false; }, true);
    assert.ok(g.layer !== 'NONE', 'must be refused');
  });
  it('downgrading a tree observation to INCOMPLETE cannot support a trustful label (resealed)', async () => {
    const g = await forge((b) => { b.treeComparison.observationStatus.candidate = 'INCOMPLETE'; }, true);
    assert.equal(g.layer, 'validateBundle', JSON.stringify(g));
    assert.match(g.detail, /non-VALID tree observation/);
  });

  // ---- NEW: classification forge ----
  it('NEW: relabeling a real regression PASS is caught by re-derivation (resealed)', async () => {
    const g = await forge((b) => { b.classification = { label: 'PASS', rule: 3, reason: 'made up', reproductionCount: b.classification.reproductionCount }; }, true);
    assert.equal(g.layer, 'validateBundle', JSON.stringify(g));
    assert.match(g.detail, /contradicts its own round facts/);
  });

  // ---- envKeys: a smuggled credential is structurally refused (resealed) ----
  it('adding a non-allowlisted env key is refused (resealed)', async () => {
    const g = await forge((b) => { b.rounds[0]!.envKeys = [...b.rounds[0]!.envKeys, 'GITHUB_TOKEN']; }, true);
    assert.equal(g.layer, 'validateBundle', JSON.stringify(g));
    assert.match(g.detail, /non-allowlisted/);
  });

  // ---- the honest limits: naive rewrite IS caught; resealed evades (documented) ----
  for (const [name, mutate] of [
    ['argv', (b: EvidenceBundle) => { b.rounds[0]!.argv = ['node', 'evil']; }],
    ['tarball digest', (b: EvidenceBundle) => { b.downstream.tarballSha256 = 'd'.repeat(64); }],
    ['runId', (b: EvidenceBundle) => { b.runId = 'tampered-run'; }],
  ] as const) {
    it(`naive (${name}) rewrite without recomputing the manifest is caught by integrity`, async () => {
      const g = await forge(mutate as (b: EvidenceBundle) => void, false);
      assert.equal(g.layer, 'validateBundle', JSON.stringify(g));
      assert.match(g.detail, /manifestSha256 mismatch/);
    });
  }

  it('manifest integrity catches ANY single-field rewrite done without recompute', async () => {
    const g = await forge((b) => { (b.dependency as Record<string, unknown>).candidateVersion = '9.9.9'; }, false);
    assert.match(g.detail, /manifestSha256 mismatch/);
  });
});
