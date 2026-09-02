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
 * Round-3 B4 closed the fields that previously only had a naive catch (argv
 * and tarball bytes were the documented evasion limits): they are now bound
 * to independent sources too (retained fixture.tgz + proof pin; committed
 * spec + trusted expansion on the proof host). The old loop below keeps the
 * naive assertions; the B4 matrix adds the RESEALED replays.
 *
 * Post-GLM (AM-2 + Finding A) migration: every scenario here depends on a
 * REAL CONFIRMED_REGRESSION base run, so the stub now runs through the
 * genuine observation channel — fake deps are STAGED and materialized by
 * prepare (a fixture that ships node_modules is refused at audit), and the
 * test command executes under the hash-pinned Canary mocha double via
 * $bin:mocha. The bundles therefore carry VALID executionObservations
 * produced by the actual injection mechanism, and the per-round artifact
 * tuple is five files (each round's .attest.ndjson rides along — the
 * observation bytes verifyArtifacts binds and verifyClassificationDerivation
 * replays). No assertion was relaxed: where the new cross-channel mirror
 * (validateBundle panel H) changes WHICH lie the forger must tell to keep a
 * case testing byte re-derivation honest, the mutation is deepened and the
 * case's expected catching layer is unchanged (see the identity-reseal
 * case's comment).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runExperiment } from '../src/pipeline.js';
import { validateBundle, integrityFor, type EvidenceBundle } from '@canary-rn/evidence-schema';
import {
  assertProof, actualHostFingerprint, verifyArtifacts, verifyArtifactSemantics,
  verifyRunIdentity, verifyClassificationDerivation, hostBoundEvidenceChecks,
  type ProofExpectation, type HostFingerprint, type TrustedRunSpec,
} from '../src/prove.js';
import { verifyTreeSnapshots } from '../src/verify-tree.js';
import { sha256hex } from '@canary-rn/hashing';
import {
  writeStagedPayload, stageCommands, MOCHA_TEST_ARGV, widgetSpec, swapScript,
  WIDGET_PKGS, assertDoubleObservation,
} from './stub-harness.js';

// Round-3 B3: the gate mirrors cmdProve — host-exactness is judged by the
// ACTUAL runtime, sampled once (these tests run on the recording machine).
const RUNTIME: HostFingerprint = actualHostFingerprint();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-prov-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const FAKE_SHA = 'a'.repeat(40);

/** Post-GLM shape: the fake deps are STAGED (AM-2 — shipping node_modules is
 *  refused at audit) and the double lands via prepare; test.js is the real
 *  widgetSpec and swap.js REALLY bumps widget to 2.0.0 (the candidate
 *  attestation refuses a tree that never moved). */
function writeStub(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
  writeStagedPayload(dir, WIDGET_PKGS);
  fs.writeFileSync(path.join(dir, 'test.js'), widgetSpec());
  fs.writeFileSync(path.join(dir, 'swap.js'), swapScript(false));
}

async function realRun(): Promise<{ bundle: EvidenceBundle; artifactsDir: string; proof: ProofExpectation; spec: TrustedRunSpec }> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = path.join(repoRoot, 'stub-src');
  writeStub(stub);
  // Round-3 B4: the committed spec is the argv re-derivation anchor — the
  // tests hand the gate the SAME object the pipeline executed with.
  const spec = {
    schema: 2, id: 'prov', dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: { prepare: stageCommands({ mocha: true }), swap: ['node', 'swap.js', '{candidate}'], test: [...MOCHA_TEST_ARGV] },
    repeats: { baseline: 2, candidate: 2 }, timeoutSecs: { install: 120, test: 120 },
  } satisfies TrustedRunSpec & Record<string, unknown>;
  // The fetch stub must declare the REAL digest of its bytes: the pipeline
  // retains fixture.tgz and verifyRunIdentity re-hashes it (round-3 B4-A).
  const bytes = Buffer.from('canary-provenance-stub-tarball');
  const result = await runExperiment(spec, repoRoot, true, {
    fetch: async () => ({ bytes, sha256: sha256hex(bytes) }),
    extract: (_t, ws) => fs.cpSync(stub, path.join(ws, `downstream-${FAKE_SHA}`), { recursive: true }),
  });
  assert.equal(result.bundle.classification.label, 'CONFIRMED_REGRESSION', 'pristine run must confirm');
  const b = result.bundle;
  // Post-GLM Finding A: the rule-5 was EARNED — every round carries a VALID
  // Canary observation of the pinned double agreeing with the text channel.
  // Every forgery below reseals a bundle that legitimately holds these.
  assertDoubleObservation(b.rounds);
  const hashes = (arm: 'baseline' | 'candidate') => b.rounds.filter((r) => r.arm === arm).map((r) => r.normalizedStdoutSha256);
  const proof: ProofExpectation = {
    schema: 1, experimentId: 'prov', evidenceSchema: 1,
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    tarballSha256: b.downstream.tarballSha256, // B4: release-critical pin is mandatory
    environment: { platform: b.environment.platform, arch: b.environment.arch },
    expected: {
      classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
      baseline: { rounds: 2, exitCodes: [0, 0], normalizedStdoutSha256AcrossRounds: hashes('baseline'), summary: { passing: 2 } },
      candidate: { rounds: 2, exitCodes: [1, 1], normalizedStdoutSha256AcrossRounds: hashes('candidate'), summary: { passing: 1, failing: 1 } },
      failingTestNames: ['widget suite > candidate breaks widget'],
    },
  };
  return { bundle: b, artifactsDir: result.artifactsDir, proof, spec };
}

const readLog = (dir: string, arm: string): string => {
  const p = path.join(dir, `${arm}-1.stdout.log`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

/** Mirror cmdProve's gate (round-3 B4 order); return the FIRST layer that
 *  refuses, or 'NONE'. */
function gate(
  bundle: EvidenceBundle, dir: string, proof: ProofExpectation, spec: TrustedRunSpec,
): { layer: string; detail: string } {
  const v = validateBundle(bundle);
  if (v.length) return { layer: 'validateBundle', detail: v.join('; ') };
  const a = verifyArtifacts(dir, bundle);
  if (a.length) return { layer: 'verifyArtifacts', detail: a.join('; ') };
  const s = verifyArtifactSemantics(dir, bundle);
  if (s.length) return { layer: 'verifyArtifactSemantics', detail: s.join('; ') };
  const id = verifyRunIdentity(dir, bundle);
  if (id.length) return { layer: 'verifyRunIdentity', detail: id.join('; ') };
  const t = verifyTreeSnapshots(bundle, dir);
  if (t.length) return { layer: 'verifyTreeSnapshots', detail: t.join('; ') };
  const d = verifyClassificationDerivation(dir, bundle);
  if (d.length) return { layer: 'verifyClassificationDerivation', detail: d.join('; ') };
  const failed = assertProof(bundle, proof, { candidateStdout: readLog(dir, 'candidate'), baselineStdout: readLog(dir, 'baseline') }, RUNTIME).filter((c) => !c.ok);
  if (failed.length) return { layer: 'assertProof', detail: failed.map((f) => f.name).join(', ') };
  const hc = hostBoundEvidenceChecks(bundle, proof, spec, dir, RUNTIME).filter((c) => !c.ok);
  if (hc.length) return { layer: 'hostBoundEvidenceChecks', detail: hc.map((f) => f.name).join(', ') };
  return { layer: 'NONE', detail: '' };
}

/** Deep-clone, mutate, optionally re-seal, gate. */
async function forge(mutate: (b: EvidenceBundle) => void, recompute: boolean): Promise<{ layer: string; detail: string }> {
  const { bundle, artifactsDir, proof, spec } = await realRun();
  const clone = structuredClone(bundle) as EvidenceBundle;
  mutate(clone);
  if (recompute) clone.integrity = integrityFor(clone);
  return gate(clone, artifactsDir, proof, spec);
}

/** Same, but against a mutated PROOF file (the committed expectation is also
 *  an attack surface for a subset-hiding adversary). */
async function forgeProof(mutateProof: (p: ProofExpectation) => void, mutateBundle?: (b: EvidenceBundle) => void): Promise<{ layer: string; detail: string }> {
  const { bundle, artifactsDir, proof, spec } = await realRun();
  const p = structuredClone(proof) as ProofExpectation;
  mutateProof(p);
  const b = structuredClone(bundle) as EvidenceBundle;
  mutateBundle?.(b);
  b.integrity = integrityFor(b);
  return gate(b, artifactsDir, p, spec);
}

describe('audit B4 — provenance forgery matrix (which layer refuses)', () => {
  it('pristine run passes the whole gate', async () => {
    const { bundle, artifactsDir, proof, spec } = await realRun();
    assert.equal(gate(bundle, artifactsDir, proof, spec).layer, 'NONE');
  });

  // ---- byte-derivable facts: caught by verifyArtifactSemantics even RESEALED.
  // We forge INTERNALLY-CONSISTENTLY (same wrong value on every candidate round)
  // so validateBundle's own re-derivation still agrees with the forged record —
  // the ONLY thing that can catch it is re-reading the actual artifact bytes. ----
  it('rewriting failure counts is caught — round-3 B1 coverage gate fires even earlier (at validateBundle)', async () => {
    // Pre-round-3 this internally-consistent count-only forgery slipped past
    // validateBundle (profiles matched across rounds) and was caught only by
    // byte re-derivation. Now the bundle refutes ITSELF: 2 reported failures
    // with 1 recorded identity violates identity coverage regardless of any
    // bytes. (Byte re-derivation still stands behind it.)
    const g = await forge((b) => { for (const c of b.rounds) if (c.arm === 'candidate') c.reportedFailing = 2; }, true);
    assert.equal(g.layer, 'validateBundle', JSON.stringify(g));
    assert.match(g.detail, /coverage guard/);
  });
  it('rewriting failing-test identities is caught by byte re-derivation (resealed)', async () => {
    // Post-GLM deepening: the forger must now lie on BOTH bundle channels —
    // rewrite the text identities AND launder the recorded observation's
    // identities to match — or validateBundle's panel-H cross-channel mirror
    // refuses the bundle itself (a weaker resealed lie dies even earlier;
    // the 'one round forged' case below shows that). With the laundered pair
    // the bundle is fully self-consistent, so only the retained BYTES — the
    // stdout/stderr artifact (and the frame stream behind framesSha256) —
    // can refute it. Same premise, same catching layer, same assertion.
    const g = await forge((b) => {
      for (const c of b.rounds) if (c.arm === 'candidate') {
        c.failingTestNames = ['a consistent wrong name'];
        (c.executionObservation as unknown as { observedFailingIdentities: string[] }).observedFailingIdentities = ['a consistent wrong name'];
      }
    }, true);
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
  it('rewriting experimentId is caught by the workspace binding (resealed) — B4-A fires before the proof', async () => {
    // Round-3 B4: runId must carry the run-directory convention, so an
    // experimentId rewrite breaks at verifyRunIdentity (independent of the
    // proof file); assertProof's pin stays as the second line of defense.
    const g = await forge((b) => { b.experimentId = 'other'; }, true);
    assert.equal(g.layer, 'verifyRunIdentity', JSON.stringify(g));
    assert.match(g.detail, /run-directory convention/);
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

  // ---- naive rewrite of the once-hard fields IS caught at integrity; the
  // resealed replays live in the round-3 B4 matrix below. ----
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

describe('round-3 B4 — coherent-reseal matrix on release-critical fields', () => {
  // Every case recomputes the manifest: naive integrity checks prove nothing
  // here. The refusal must come from a layer that consults an INDEPENDENT
  // source (workspace bytes, retained trees, committed spec/proof, sanitizer
  // policy) — never from the bundle agreeing with itself.

  it('resealed runId alone is contradicted by the workspace directory', async () => {
    const g = await forge((b) => { b.runId = 'exp-prov-2020-01-01T00-00-00-000Z'; }, true);
    assert.equal(g.layer, 'verifyRunIdentity', JSON.stringify(g));
    assert.match(g.detail, /not the workspace directory/);
  });
  it('resealed runId AND experimentId (coherent prefix) still contradicts the directory', async () => {
    const g = await forge((b) => {
      b.experimentId = 'other';
      b.runId = 'exp-other-2020-01-01T00-00-00-000Z';
    }, true);
    assert.equal(g.layer, 'verifyRunIdentity', JSON.stringify(g));
    assert.match(g.detail, /not the workspace directory/);
  });
  it('resealed tarball digest is contradicted by the retained fixture.tgz bytes', async () => {
    const g = await forge((b) => { b.downstream.tarballSha256 = 'd'.repeat(64); }, true);
    assert.equal(g.layer, 'verifyRunIdentity', JSON.stringify(g));
    assert.match(g.detail, /TAMPERED fixture tarball/);
  });
  it('attacker who swaps the TARBALL BYTES too is stopped by the committed proof pin', async () => {
    // Deepest tarball attack: rewrite fixture.tgz on disk AND re-seal the
    // digest to the new bytes — verifyRunIdentity then AGREES (self-
    // consistent), so only the externally pinned digest (round-3 B4-E) can
    // refuse. Without a proof pin, a PASS could never be claimed anyway
    // ('proof pins tarball digest'); with one, the swap diverges.
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const wsDir = path.dirname(artifactsDir);
    const evil = Buffer.from('a different tarball entirely');
    fs.writeFileSync(path.join(wsDir, 'fixture.tgz'), evil);
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.downstream.tarballSha256 = sha256hex(evil);
    forged.integrity = integrityFor(forged);
    const g = gate(forged, artifactsDir, proof, spec);
    assert.equal(g.layer, 'assertProof', JSON.stringify(g));
    assert.match(g.detail, /tarball digest pinned/);
  });
  it('resealed argv is contradicted by the committed spec re-expansion (proof host)', async () => {
    const g = await forge((b) => { b.rounds[0]!.argv = ['node', 'evil.js']; }, true);
    assert.equal(g.layer, 'hostBoundEvidenceChecks', JSON.stringify(g));
    assert.match(g.detail, /argv re-derived from committed spec/);
  });
  it('weakened envKeys (valid allowlist subset) is contradicted by the policy re-derivation', async () => {
    const g = await forge((b) => {
      const r = b.rounds[0]!;
      r.envKeys = r.envKeys.filter((_k, i) => i !== 0); // drop one key, still allowlisted
    }, true);
    assert.equal(g.layer, 'hostBoundEvidenceChecks', JSON.stringify(g));
    assert.match(g.detail, /envKeys re-derived from sanitizer policy/);
  });
  it('classification REASON tampering (label/rule/count coherent) is caught by byte re-derivation', async () => {
    const g = await forge((b) => {
      b.classification.reason = 'all candidate rounds failed while baseline passed — regression confirmed (slightly edited)';
    }, true);
    assert.equal(g.layer, 'verifyClassificationDerivation', JSON.stringify(g));
    assert.match(g.detail, /reason/);
  });
  it('coherent INCONCLUSIVE-rule9 relabel is refused (no unconfined drift to justify it)', async () => {
    const g = await forge((b) => {
      b.classification = {
        label: 'INCONCLUSIVE', rule: 9, reproductionCount: b.classification.reproductionCount,
        reason: 'tree drift outside widget subtree (left-pad) — arms not comparable',
      };
    }, true);
    // The bundle contradicts itself on the drift claim FIRST (validateBundle's
    // override justification needs driftConfinedToDependency=false)...
    assert.equal(g.layer, 'validateBundle', JSON.stringify(g));
    // ...and even a drift-flipping variant must still survive the byte layer.
    const g2 = await forge((b) => {
      b.classification = {
        label: 'INCONCLUSIVE', rule: 9, reproductionCount: b.classification.reproductionCount,
        reason: 'tree drift outside widget subtree (left-pad) — arms not comparable',
      };
      b.treeComparison.driftConfinedToDependency = false;
    }, true);
    assert.notEqual(g2.layer, 'NONE', JSON.stringify(g2));
  });
  it('resealed dependency-copy count is contradicted by the retained snapshot recount', async () => {
    const g = await forge((b) => { b.treeComparison.dependencyCopies.candidate += 1; }, true);
    assert.equal(g.layer, 'verifyTreeSnapshots', JSON.stringify(g));
    assert.match(g.detail, /dependencyCopies\.candidate/);
  });
  it('a crash hidden from the record (crash line IN the bytes, resealed) is caught by byte re-derivation', async () => {
    // Deepest variant: forger appends a V8 heap-OOM banner to a round's
    // stderr, re-hashes the raw artifact (verifyArtifacts stays clean) and
    // re-seals everything, leaving crashSignal UNrecorded and the label
    // CONFIRMED. validateBundle agrees with the bundle's own (lying) facts —
    // only re-reading the bytes for the recorded-fact check can refute it:
    // a crashed round can never support a trustful verdict (rule 1).
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const t = path.join(artifactsDir, 'candidate-1.stderr.log');
    fs.appendFileSync(t, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.rounds[2]!.rawStderrSha256 = sha256hex(fs.readFileSync(t));
    forged.integrity = integrityFor(forged);
    const g = gate(forged, artifactsDir, proof, spec);
    assert.equal(g.layer, 'verifyArtifactSemantics', JSON.stringify(g));
    assert.match(g.detail, /crashSignal/);
  });
  it('an invented crashSignal on clean bytes is caught too (bidirectional binding, resealed)', async () => {
    // The inverse lie (crashSignal=true on benign bytes) self-contradicts the
    // bundle at validateBundle first — the re-derived label (INFRA) disagrees
    // with the recorded one (CONFIRMED). Layer order documented, both refuse.
    const g = await forge((b) => { for (const r of b.rounds) r.crashSignal = true; }, true);
    assert.equal(g.layer, 'validateBundle', JSON.stringify(g));
    assert.match(g.detail, /contradicts its own round facts/);
  });
  it('a tampered infraSignal (false where bytes carry an infra line) is caught by bytes', async () => {
    // The stub candidate bytes are clean, so first append a real infra line to
    // one stderr artifact, re-hash it (the forger controls bytes+digests),
    // re-seal — and the recorded infraSignal=false must still be refuted by
    // the re-derivation reading the (now tampered) bytes. This is the same
    // trust boundary as the tarball-bytes case: within-byte coherence is
    // integrity, external pinning is what makes it a PROOF.
    const { bundle, artifactsDir, proof, spec } = await realRun();
    const t = path.join(artifactsDir, 'candidate-1.stderr.log');
    fs.appendFileSync(t, 'npm ERR! code ERESOLVE\n');
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.rounds[2]!.rawStderrSha256 = sha256hex(fs.readFileSync(t));
    // (rounds order: baseline1,baseline2,candidate1,candidate2 — index 2 is candidate#1)
    forged.integrity = integrityFor(forged);
    const g = gate(forged, artifactsDir, proof, spec);
    assert.notEqual(g.layer, 'NONE', JSON.stringify(g));
    assert.ok(['verifyArtifactSemantics', 'verifyClassificationDerivation', 'assertProof'].includes(g.layer),
      `must be refused at a byte/proof layer, got ${g.layer}: ${g.detail}`);
    // (verifyArtifacts itself can't see it — the forger re-hashed; the byte-
    // DERIVED fact re-checkers do: the round now says non-infra while its own
    // tampered bytes scream ERESOLVE.)
  });
  it('a proof pinning a SUBSET of the failing identities is refused (exact-set equality, B4-D)', async () => {
    const g = await forgeProof((p) => { p.expected.failingTestNames = []; });
    assert.equal(g.layer, 'assertProof', JSON.stringify(g));
    assert.match(g.detail, /exact set/);
  });
  it('a proof pinning a WRONG extra identity is refused too (exact-set equality, B4-D)', async () => {
    const g = await forgeProof((p) => {
      p.expected.failingTestNames = ['widget suite > candidate breaks widget', 'nonexistent > extra name'];
    });
    assert.equal(g.layer, 'assertProof', JSON.stringify(g));
    assert.match(g.detail, /exact set/);
  });
  it('a proof that forgot to pin the tarball digest cannot support PASS (B4)', async () => {
    const g = await forgeProof((p) => { delete p.tarballSha256; });
    assert.equal(g.layer, 'assertProof', JSON.stringify(g));
    assert.match(g.detail, /proof pins tarball digest/);
  });
});
