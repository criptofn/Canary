import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { verifyArtifacts, assertProof, proofVerdict, environmentAttestationIssues, type ProofExpectation } from '../src/prove.js';
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
    downstream: { repositoryUrl: 'https://github.com/u', commitSha: 'b'.repeat(40), fetchMethod: 'tarball-by-sha', tarballSha256: 'a'.repeat(64) },
    environment: { nodeVersion: 'v', npmVersion: 'n', packageManagerUsed: 'npm', platform: 'x', arch: 'y', toolchainOverrides: {} },
    commands: { prepare: [['a']], build: [], swap: ['b'], test: ['c'] },
    rounds: [mkRound('baseline', 1), mkRound('candidate', 1)],
    treeComparison: { baselineTreeSha256: 'a'.repeat(64), candidateTreeSha256: 'b'.repeat(64), driftConfinedToDependency: true, observationStatus: { baseline: 'VALID', candidate: 'VALID' }, resolvedVersions: { baseline: '1', candidate: '2' }, dependencyCopies: { baseline: 1, candidate: 1 } },
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

  it('rejects a logPath that breaks the round-ownership contract', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      (bundle.rounds[0] as { logPath: string }).logPath = 'weird-name.txt';
      const issues = verifyArtifacts(dir, bundle);
      assert.equal(issues.length, 1);
      assert.match(issues[0]!, /does not match its own identity/);
    } finally { cleanup(); }
  });
});

describe('verifyArtifacts — audit B3 (path confinement + ownership)', () => {
  // Independent harness so each case controls file bytes + claimed paths.
  function art(): { dir: string; outside: string; cleanup: () => void } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-b3-'));
    const dir = path.join(tmp, 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(tmp, 'external');
    fs.mkdirSync(outside, { recursive: true });
    return { dir, outside, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }
  const roundBase = (arm: 'baseline' | 'candidate', n: number): Record<string, unknown> => ({
    arm, round: n, exitCode: arm === 'baseline' ? 0 : 1, killedByTimeout: false,
    hasRunnerSummary: true, infraSignal: false,
    startedAt: 'x', durationMs: 1,
    rawStdoutSha256: '0'.repeat(64), rawStderrSha256: '0'.repeat(64),
    normalizedStdoutSha256: '0'.repeat(64), normalizedStderrSha256: '0'.repeat(64),
    logPath: `${arm}-${n}.stdout.log`, argv: ['x'], envKeys: ['PATH'],
  });
  const bundleOf = (rounds: Record<string, unknown>[]): EvidenceBundle =>
    ({ rounds } as unknown as EvidenceBundle);
  const writeAll = (dir: string, label: string, content: string): Record<string, string> => {
    const h = sha256hex(content);
    for (const suf of ['.stdout.log', '.stderr.log', '.stdout.norm', '.stderr.norm']) {
      fs.writeFileSync(path.join(dir, label + suf), content, 'utf8');
    }
    return { rawStdoutSha256: h, rawStderrSha256: h, normalizedStdoutSha256: h, normalizedStderrSha256: h };
  };

  it('../../ identical external substitution is refused (ownership), not verified against the external bytes', () => {
    const { dir, outside, cleanup } = art();
    try {
      // identical bytes live OUTSIDE the artifacts dir
      const h = writeAll(outside, 'baseline-1', 'same-content');
      const r = { ...roundBase('baseline', 1), ...h, logPath: '../external/baseline-1.stdout.log' };
      const issues = verifyArtifacts(dir, bundleOf([r]));
      assert.equal(issues.length, 1, JSON.stringify(issues));
      assert.match(issues[0]!, /does not match its own identity/);
    } finally { cleanup(); }
  });

  it('absolute external path in logPath is refused', () => {
    const { dir, outside, cleanup } = art();
    try {
      const h = writeAll(outside, 'baseline-1', 'x');
      const abs = path.join(outside, 'baseline-1.stdout.log');
      const r = { ...roundBase('baseline', 1), ...h, logPath: abs };
      const issues = verifyArtifacts(dir, bundleOf([r]));
      assert.ok(issues.some((i) => /does not match its own identity/.test(i)), JSON.stringify(issues));
    } finally { cleanup(); }
  });

  it('cross-round swap (candidate#1 claims candidate#2 log) is refused', () => {
    const { dir, cleanup } = art();
    try {
      const h1 = writeAll(dir, 'candidate-1', 'round one bytes');
      const h2 = writeAll(dir, 'candidate-2', 'round two bytes');
      // swap: round 1 carries round 2's path AND its digests, and vice versa —
      // a naive "hash the file logPath points to" verifier would accept this.
      const r1 = { ...roundBase('candidate', 1), ...h2, logPath: 'candidate-2.stdout.log' };
      const r2 = { ...roundBase('candidate', 2), ...h1, logPath: 'candidate-1.stdout.log' };
      const issues = verifyArtifacts(dir, bundleOf([r1, r2]));
      assert.equal(issues.filter((i) => /does not match its own identity/.test(i)).length, 2,
        JSON.stringify(issues));
    } finally { cleanup(); }
  });

  it('baseline pointing at a candidate artifact is refused', () => {
    const { dir, cleanup } = art();
    try {
      const hc = writeAll(dir, 'candidate-1', 'candidate bytes');
      const r = { ...roundBase('baseline', 1), ...hc, logPath: 'candidate-1.stdout.log' };
      const issues = verifyArtifacts(dir, bundleOf([r]));
      assert.ok(issues.some((i) => /does not match its own identity/.test(i)), JSON.stringify(issues));
    } finally { cleanup(); }
  });

  it('a valid canonical relative artifact path verifies clean', () => {
    const { dir, cleanup } = art();
    try {
      const h = writeAll(dir, 'baseline-1', 'genuine');
      const r = { ...roundBase('baseline', 1), ...h };
      assert.deepEqual(verifyArtifacts(dir, bundleOf([r])), []);
    } finally { cleanup(); }
  });

  it('missing + modified artifacts are refused', () => {
    const { dir, cleanup } = art();
    try {
      const h = writeAll(dir, 'candidate-1', 'orig');
      const present = { ...roundBase('candidate', 1), ...h };
      // delete one of the four -> missing
      fs.rmSync(path.join(dir, 'candidate-1.stderr.norm'));
      assert.ok(verifyArtifacts(dir, bundleOf([present])).some((i) => /missing/.test(i)));
    } finally { cleanup(); }
    const { dir: d2, cleanup: c2 } = art();
    try {
      const h = writeAll(d2, 'candidate-1', 'orig');
      fs.writeFileSync(path.join(d2, 'candidate-1.stdout.norm'), 'tampered');
      const r = { ...roundBase('candidate', 1), ...h };
      assert.ok(verifyArtifacts(d2, bundleOf([r])).some((i) => /TAMPERED/.test(i)));
    } finally { c2(); }
  });

  it('a symlinked artifact resolving outside the dir is refused (symlink escape)', (t) => {
    if (!canSymlink()) { t.skip('symlink privileges unavailable on this host'); return; }
    const { dir, outside, cleanup } = art();
    try {
      const content = 'outside-symlinked';
      const h = sha256hex(content);
      fs.writeFileSync(path.join(outside, 'secret-stdout.log'), content, 'utf8');
      // canonical basename, but the file is a symlink to outside
      fs.symlinkSync(path.join(outside, 'secret-stdout.log'), path.join(dir, 'baseline-1.stdout.log'));
      for (const suf of ['.stderr.log', '.stdout.norm', '.stderr.norm']) {
        fs.writeFileSync(path.join(dir, 'baseline-1' + suf), '', 'utf8');
      }
      const r = {
        ...roundBase('baseline', 1),
        rawStdoutSha256: h, rawStderrSha256: sha256hex(''),
        normalizedStdoutSha256: sha256hex(''), normalizedStderrSha256: sha256hex(''),
      };
      const issues = verifyArtifacts(dir, bundleOf([r]));
      assert.ok(issues.some((i) => /resolves outside the artifacts directory/.test(i)),
        `symlink escape not caught: ${JSON.stringify(issues)}`);
    } finally { cleanup(); }
  });
});

function canSymlink(): boolean {
  try {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-sym-'));
    fs.writeFileSync(path.join(t, 'a'), 'x');
    fs.symlinkSync(path.join(t, 'a'), path.join(t, 'b'));
    fs.rmSync(t, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

const CAND_LOG = [
  '  suite', '    √ ok one', '', '  1 passing (1ms)', '  1 failing', '',
  '  1) suite', '       candidate breaks widget:', '     Error: nope', '',
].join('\n');
const BASE_LOG = '  2 passing (1ms)\n';

describe('assertProof — audit F11 + round-3 B3 (host-exactness from the ACTUAL runtime)', () => {
  function proofFor(bundle: EvidenceBundle, withHost: boolean): ProofExpectation {
    const hashes = (arm: 'baseline' | 'candidate') =>
      bundle.rounds.filter((r) => r.arm === arm).map((r) => r.normalizedStdoutSha256);
    return {
      schema: 1, experimentId: 'e',
      dependency: { package: 'p', baseline: '1', candidate: '2' },
      downstream: { repo: 'u', commit: 'b'.repeat(40) },
      // Round-3 B4: a proof must pin the tarball digest (assertProof refuses
      // one that doesn't); the harness pins the value the bundle records.
      tarballSha256: bundle.downstream.tarballSha256,
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
  // The harness bundle CLAIMS x/y/v/n. `runtimeOnRecordedMachine` simulates a
  // verify process whose ACTUAL identity matches that claim (the only way the
  // pre-B3 code could be satisfied); the fake-host runtime simulates verifying
  // somewhere else. The evidence itself is NEVER consulted for the decision.
  const runtimeOnRecordedMachine = { platform: 'x', arch: 'y', nodeVersion: 'v', npmVersion: 'n' };
  const runtimeElsewhere = { platform: 'linux', arch: 'arm64', nodeVersion: 'v22.0.0', npmVersion: '10.0.0' };
  const run = (bundle: EvidenceBundle, proof: ProofExpectation, runtime = runtimeOnRecordedMachine) =>
    assertProof(bundle, proof, { candidateStdout: CAND_LOG, baselineStdout: BASE_LOG }, runtime);

  it('legacy proof (no proofHost): host-exact hashes assert ONLY when the actual runtime matches the recorded environment', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      const onMachine = run(bundle, proofFor(bundle, false));
      const hash = onMachine.find((c) => c.name === 'candidate normalized stdout hashes')!;
      assert.equal(hash.ok, true);
      assert.equal(hash.skipped, undefined);
      // The old unconditional-strict branch is GONE: a legacy proof verified
      // on a foreign machine must skip (INCOMPLETE), not silently assert.
      const elsewhere = run(bundle, proofFor(bundle, false), runtimeElsewhere);
      const skipped = elsewhere.filter((c) => c.skipped);
      assert.equal(skipped.length, 2, JSON.stringify(skipped.map((s) => s.name)));
      assert.ok(skipped.every((s) => /no committed proofHost and the actual runtime differs/.test(s.name)));
    } finally { cleanup(); }
  });

  it('matching proofHost + actual runtime on it: every assertion including hashes AND the environment binding evaluates', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      const checks = run(bundle, proofFor(bundle, true));
      assert.equal(checks.some((c) => c.skipped), false);
      assert.equal(checks.every((c) => c.ok), true);
      assert.ok(checks.some((c) => c.name === 'evidence environment bound to proof host'),
        'B3 binding must exist as an evaluated check');
    } finally { cleanup(); }
  });

  it('round-3 B3 core: resealing the evidence environment can NO LONGER skip strict checks — it FAILS the binding', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      // proofHost is the recorded (true) host; the actual runtime is ON it.
      const proof = proofFor(bundle, true);
      // Attacker reseals the environment block (say, to dodge a known-bad
      // node-version assertion) — pre-B3 this made `onProofHost` false and
      // every strict check politely skipped to a PASS. Now the binding fires.
      bundle.environment.npmVersion = '9.9.9-fake';
      // proofHost/actual runtime are both x/y/v/n; the resealed 'fake' npm
      // version now CONTRADICTS the committed expectation on the proof host:
      const checks = run(bundle, proof);
      const bound = checks.find((c) => c.name === 'evidence environment bound to proof host')!;
      assert.equal(bound.ok, false);
      assert.equal(bound.skipped, undefined);
      // and no check skipped its way out:
      assert.equal(checks.filter((c) => c.skipped).length, 0);
      const v = proofVerdict(checks);
      assert.equal(v.status, 'FAIL');
      assert.equal(v.exitCode, 1);
    } finally { cleanup(); }
  });

  it('off-proof-host: host-exact comparisons skip (flagged, not silent); portable assertions still evaluate; verdict is INCOMPLETE', () => {
    const { dir, bundle, cleanup } = harness();
    try {
      const proof = proofFor(bundle, true);
      proof.proofHost = { ...proof.proofHost!, nodeVersion: 'v99.0.0' }; // a host the ACTUAL runtime is not
      const checks = run(bundle, proof); // actual runtime == x/y/v/n
      const skipped = checks.filter((c) => c.skipped);
      assert.deepEqual(skipped.map((c) => c.name).sort(), [
        'baseline normalized stdout hashes [SKIPPED: actual runtime is not the committed proof host x/y/node v99.0.0/npm n]',
        'candidate normalized stdout hashes [SKIPPED: actual runtime is not the committed proof host x/y/node v99.0.0/npm n]',
        'evidence environment bound to proof host [SKIPPED: actual runtime is not the committed proof host x/y/node v99.0.0/npm n]',
      ]);
      // determinism-within-arm is host-INDEPENDENT and must NOT skip:
      assert.ok(checks.some((c) => c.name === 'candidate arm internally deterministic' && !c.skipped));
      // B3: skipped host-exactness downgrades the VERDICT — no PASS pretense.
      const v = proofVerdict(checks);
      assert.equal(v.status, 'INCOMPLETE');
      assert.equal(v.exitCode, 2);
      // a real portable violation is still FAIL even while hashes skip:
      proof.expected.rule = 7;
      const diverged = run(bundle, proof);
      const bad = diverged.find((c) => c.name === 'rule')!;
      assert.equal(bad.ok, false);
      assert.equal(bad.skipped, undefined);
      assert.equal(proofVerdict(diverged).status, 'FAIL');
      assert.equal(proofVerdict(diverged).exitCode, 1);
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
      assert.equal(proofVerdict(checks).status, 'INCOMPLETE'); // but never PASS
      assert.equal(verifyArtifacts(dir, bundle).length, 0); // artifacts still self-consistent
    } finally { cleanup(); }
  });
});

describe('round-3 B3 — environment attestation + verdict helpers', () => {
  it('environmentAttestationIssues: silent only when claim == ACTUAL runtime', () => {
    const { bundle, cleanup } = harness();
    try {
      assert.deepEqual(environmentAttestationIssues(bundle, { platform: 'x', arch: 'y', nodeVersion: 'v', npmVersion: 'n' }), []);
      const lies = environmentAttestationIssues(bundle, { platform: 'x', arch: 'y', nodeVersion: 'v0.0.1', npmVersion: 'n' });
      assert.equal(lies.length, 1);
      assert.match(lies[0]!, /ACTUAL verifying runtime/);
      assert.match(lies[0]!, /v0\.0\.1/);
    } finally { cleanup(); }
  });
  it('proofVerdict: PASS requires zero failures AND zero skips', () => {
    assert.equal(proofVerdict([{ name: 'a', ok: true }]).status, 'PASS');
    assert.equal(proofVerdict([{ name: 'a', ok: true }, { name: 'b', ok: true, skipped: true }]).status, 'INCOMPLETE');
    assert.equal(proofVerdict([{ name: 'b', ok: true, skipped: true }]).exitCode, 2);
    assert.equal(proofVerdict([{ name: 'a', ok: false }]).status, 'FAIL');
    assert.equal(proofVerdict([]).status, 'PASS');
  });
});

describe('round-3 B4-D — exact failing-identity set equality (proof vs candidate bytes)', () => {
  // The pre-B4 check was membership-only: a proof pinning a SUBSET of the
  // real failures passed while hiding nothing was asserted about EXTRA ones.
  // Now the extracted set must equal the expected set exactly.
  const { bundle, cleanup } = harness();
  after(cleanup); // assertProof never reads the dir — only the bundle + logs
  const proof = {
    schema: 1, experimentId: 'e',
    dependency: { package: 'p', baseline: '1', candidate: '2' },
    downstream: { repo: 'u', commit: 'b'.repeat(40) },
    tarballSha256: bundle.downstream.tarballSha256,
    expected: {
      classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
      baseline: { rounds: 1, exitCodes: [0], normalizedStdoutSha256AcrossRounds: [bundle.rounds[0]!.normalizedStdoutSha256], summary: { passing: 2 } },
      candidate: { rounds: 1, exitCodes: [3], normalizedStdoutSha256AcrossRounds: [bundle.rounds[1]!.normalizedStdoutSha256], summary: { passing: 1, failing: 1 } },
      failingTestNames: ['suite > candidate breaks widget'],
    },
  } as ProofExpectation;
  const run = (p: ProofExpectation) =>
    assertProof(bundle, p, { candidateStdout: CAND_LOG, baselineStdout: BASE_LOG }, { platform: 'x', arch: 'y', nodeVersion: 'v', npmVersion: 'n' });
  const exactName = 'failing test identities (exact set from candidate bytes)';

  it('faithful expectation: exact set holds', () => {
    const c = run(proof).find((x) => x.name === exactName)!;
    assert.equal(c.ok, true);
  });
  it('proof pinning a SUBSET (hiding a real failure) FAILS', () => {
    const p = structuredClone(proof);
    p.expected.failingTestNames = [];
    const c = run(p).find((x) => x.name === exactName)!;
    assert.equal(c.ok, false);
  });
  it('proof pinning an EXTRA (non-existent) identity FAILS', () => {
    const p = structuredClone(proof);
    p.expected.failingTestNames = ['suite > candidate breaks widget', 'suite > a name that never failed'];
    const c = run(p).find((x) => x.name === exactName)!;
    assert.equal(c.ok, false);
  });
  it('the exact-set check is portable — it evaluates (never skips) off-host', () => {
    const p = structuredClone(proof);
    p.proofHost = { platform: 'os2', arch: 'ppc', nodeVersion: 'v0', npmVersion: '0' }; // we are NOT it
    const c = run(p).find((x) => x.name === exactName)!;
    assert.equal(c.skipped, undefined);
    assert.equal(c.ok, true); // bytes vs proof, host-independent
  });
  it('a proof that does not pin the tarball digest FAILS the pin requirement', () => {
    const p = structuredClone(proof);
    delete p.tarballSha256;
    const checks = run(p);
    const c = checks.find((x) => x.name === 'proof pins tarball digest')!;
    assert.equal(c.ok, false);
    assert.equal(c.skipped, undefined, 'the pin requirement itself is portable');
  });

  // Self-review N10 (found by mutation testing): deleting the experiment-
  // identity eq from assertProof left EVERY suite green — the CLI flow catches
  // experimentId rewrites EARLIER (verifyRunIdentity's runId↔directory and
  // exp-<id>- prefix binding), so nothing exercised this pin directly. It is
  // load-bearing for the standalone API: an attacker who copies a run
  // directory, renames it, and coherently reseals runId+experimentId+manifest
  // satisfies every other layer — only the proof's own identity anchor refuses
  // that bundle as the wrong experiment. assertProof does NOT consult the
  // manifest, so re-sealing integrity is irrelevant to this check.
  it('assertProof alone refuses a resealed experimentId the proof does not name (mutation N10)', () => {
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.experimentId = 'some-other-experiment';
    const c = assertProof(
      forged, proof, { candidateStdout: CAND_LOG, baselineStdout: BASE_LOG },
      { platform: 'x', arch: 'y', nodeVersion: 'v', npmVersion: 'n' },
    ).find((x) => x.name === 'experiment identity')!;
    assert.equal(c.ok, false, 'the proof-identity pin must be the refuser at the assertProof layer');
    assert.equal(c.skipped, undefined, 'identity pinning is host-independent');
  });

  // Self-review N9 (proof-version confusion): assertProof consumed
  // proof.schema without ever reading it — a proof authored for another
  // expectation layout would be silently interpreted under v1 semantics.
  it('a proof declaring a schema version the reader does not implement FAILS (portable)', () => {
    for (const bad of [2, 0, undefined]) {
      const p = structuredClone(proof) as ProofExpectation & { schema?: number };
      if (bad === undefined) delete (p as { schema?: unknown }).schema; else p.schema = bad;
      const checks = run(p);
      const c = checks.find((x) => x.name === 'proof schema')!;
      assert.equal(c.ok, false, `schema=${String(bad)} must not certify`);
      assert.equal(c.skipped, undefined, 'the version pin is host-independent');
    }
  });
});
