import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateBundle, integrityFor, EVIDENCE_SCHEMA_VERSION } from '../src/index.js';

const H = 'a'.repeat(64);
const SHA40 = 'b8804442837556a2c7673caeb2925688991b610c';

/** Round-3 B6: a structurally complete retained-snapshot ref for one arm. */
function snapshotRef(arm: 'baseline' | 'candidate'): Record<string, unknown> {
  return {
    rawStdoutLog: `tree-${arm}.treels.raw.log`, rawStdoutSha256: H,
    rawStderrLog: `tree-${arm}.treels.stderr.log`, rawStderrSha256: H,
    canonicalLog: `tree-${arm}.treels.canonical.json`, canonicalSha256: H,
  };
}

function goodBundle(): Record<string, unknown> {
  const round = (arm: 'baseline' | 'candidate', n: number) => ({
    arm, round: n, exitCode: arm === 'baseline' ? 0 : 3,
    killedByTimeout: false, hasRunnerSummary: true, infraSignal: false,
    // Round-3 blocker 2: a healthy run must carry machine-readable EXECUTED
    // counts (passing/failing — pending never counts). A round with no counts
    // at all can no longer support any verdict.
    reportedPassing: 5,
    // Round-3 blocker 1: identities must FULLY account for the failing
    // count — 3 names for "3 failing" (the pre-fix fixture shipped 2, which
    // the classifier/validator now correctly refuse to trust).
    ...(arm === 'candidate' ? { reportedFailing: 3, failingTestNames: ['a test', 'b test', 'c test'] } : {}),
    startedAt: '2026-08-30T00:00:00Z', durationMs: 120,
    rawStdoutSha256: H, rawStderrSha256: H,
    normalizedStdoutSha256: H, normalizedStderrSha256: H,
    logPath: `${arm}-${n}.stdout.log`, argv: ['node', 'x'], envKeys: ['PATH'],
  });
  const b: Record<string, unknown> = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: 'r1', createdAt: '2026-08-30T00:00:00Z', canaryVersion: '0.1.0', experimentId: 'e1',
    dependency: { package: 'axios', baselineVersion: '0.27.2', candidateVersion: '1.0.0' },
    downstream: { repositoryUrl: 'https://github.com/x/y', commitSha: SHA40, fetchMethod: 'tarball-by-sha', tarballSha256: H },
    environment: { nodeVersion: 'v26', npmVersion: '11', packageManagerUsed: 'npm', platform: 'win32', arch: 'x64', toolchainOverrides: {} },
    commands: { prepare: [['a']], build: [], swap: ['b'], test: ['c'] },
    rounds: [round('baseline', 1), round('baseline', 2), round('candidate', 1)],
    treeComparison: {
      baselineTreeSha256: H, candidateTreeSha256: H, driftConfinedToDependency: true,
      observationStatus: { baseline: 'VALID', candidate: 'VALID' },
      resolvedVersions: { baseline: '0.27.2', candidate: '1.0.0' },
      dependencyCopies: { baseline: 1, candidate: 2 },
      // Round-3 B6: trustful verdicts must carry retained snapshot refs +
      // present/empty anomaly arrays (bytes live under arm-derived names).
      snapshots: { baseline: snapshotRef('baseline'), candidate: snapshotRef('candidate') },
      observationAnomalies: { baseline: { json: [] }, candidate: { json: [] } },
    },
    classification: { label: 'CONFIRMED_REGRESSION', rule: 5, reason: 'ok', reproductionCount: 1 },
  };
  b.integrity = integrityFor(b);
  return b;
}

/** Re-seal the manifest after a mutation (tests that legitimately rewrite a
 *  field then expect a clean validation, e.g. the rule-9/10 overrides). */
const seal = (b: Record<string, unknown>): Record<string, unknown> => {
  b.integrity = integrityFor(b);
  return b;
};

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

// Audit F3: the validator must REFUTE contradictory evidence, not just
// pretty-print its shape. Every case below is a fabricated bundle that the
// structural validator used to accept.
describe('validateBundle — semantic integrity (audit F3)', () => {
  const setCls = (b: Record<string, unknown>, patch: Record<string, unknown>) =>
    Object.assign(b.classification as Record<string, unknown>, patch);

  it('rejects a CONFIRMED_REGRESSION label whose own rounds say PASS', () => {
    const b = goodBundle();
    for (const r of b.rounds as Record<string, unknown>[]) {
      if (r.arm === 'candidate') { r.exitCode = 0; delete r.reportedFailing; delete r.failingTestNames; }
    }
    assert.ok(validateBundle(b).some((e) => /re-derivation from these rounds yields PASS/.test(e)),
      String(validateBundle(b)));
  });

  it('rejects a CONFIRMED_REGRESSION built from rounds whose failure identities differ (must re-derive FLAKY rule 8)', () => {
    const b = goodBundle();
    b.rounds = [
      ...(b.rounds as object[]),
      {
        ...(b.rounds as Record<string, unknown>[])[2]!,
        round: 2, exitCode: 3, reportedFailing: 3, failingTestNames: ['other test', 'b test', 'c test'],
      },
    ];
    setCls(b, { reproductionCount: 2 });
    assert.ok(validateBundle(b).some((e) => /yields FLAKY rule 8/.test(e)), String(validateBundle(b)));
  });

  it('rejects masked-failure rounds (exit 0 with reported failures) under a PASS label', () => {
    const b = goodBundle();
    setCls(b, { label: 'PASS', rule: 3, reproductionCount: 1 });
    for (const r of b.rounds as Record<string, unknown>[]) {
      if (r.arm === 'candidate') { r.exitCode = 0; r.reportedFailing = 3; }
      else { delete r.reportedFailing; delete r.failingTestNames; }
    }
    assert.ok(validateBundle(b).some((e) => /re-derivation .* yields INFRASTRUCTURE_FAILURE/.test(e)),
      String(validateBundle(b)));
  });

  it('rejects killedByTimeout=true alongside a normal exit code', () => {
    const b = goodBundle();
    ((b.rounds as Record<string, unknown>[])[0]!).killedByTimeout = true;
    assert.ok(validateBundle(b).some((e) => /killed round exits -1/.test(e)));
  });

  it('rejects an inflated reproductionCount not backed by candidate rounds', () => {
    const b = goodBundle();
    setCls(b, { reproductionCount: 100 });
    assert.ok(validateBundle(b).some((e) => /reproductionCount=100 but bundle has 1 candidate/.test(e)));
  });

  it('rejects a trustful verdict while drift says NOT confined (rule-9 guard bypassed)', () => {
    const b = goodBundle();
    (b.treeComparison as Record<string, unknown>).driftConfinedToDependency = false;
    assert.ok(validateBundle(b).some((e) => /rule-9 guard bypassed/.test(e)));
  });

  it('accepts the legitimate rule-9 override: unconfined drift + INCONCLUSIVE rule 9', () => {
    const b = goodBundle();
    (b.treeComparison as Record<string, unknown>).driftConfinedToDependency = false;
    setCls(b, { label: 'INCONCLUSIVE', rule: 9 });
    assert.deepEqual(validateBundle(seal(b)), []);
  });

  it('audit B6: rejects a trustful verdict built on a non-VALID tree observation', () => {
    const b = goodBundle();
    (b.treeComparison as { observationStatus: Record<string, unknown> }).observationStatus.candidate = 'INCOMPLETE';
    assert.ok(validateBundle(b).some((e) => /non-VALID tree observation/.test(e)), 'label CONFIRMED w/ INCOMPLETE tree must die');
    (b.treeComparison as { observationStatus: Record<string, unknown> }).observationStatus.candidate = 'INVALID';
    assert.ok(validateBundle(b).some((e) => /non-VALID tree observation/.test(e)));
  });

  it('audit B6: accepts the legitimate rule-10 override (confined drift but weak observation)', () => {
    const b = goodBundle();
    (b.treeComparison as { observationStatus: Record<string, unknown> }).observationStatus.baseline = 'INCOMPLETE';
    setCls(b, { label: 'INCONCLUSIVE', rule: 10 });
    assert.deepEqual(validateBundle(seal(b)), []);
  });

  it('audit B6: rejects a FABRICATED rule-10 downgrade even with a valid manifest (semantic layer alone catches it)', () => {
    const b = goodBundle(); // trees VALID, rounds give CONFIRMED rule 5
    setCls(b, { label: 'INCONCLUSIVE', rule: 10 });
    const issues = validateBundle(seal(b)); // sealed → integrity is NOT the reason
    assert.ok(issues.some((e) => /contradicts its own round facts/.test(e)),
      `fabricated rule 10 with VALID tree must be rejected by re-derivation: ${issues.join('; ')}`);
  });

  it('audit B6: observationStatus is mandatory', () => {
    const b = goodBundle();
    delete (b.treeComparison as Record<string, unknown>).observationStatus;
    assert.ok(validateBundle(b).some((e) => /observationStatus/.test(e)));
  });

  it('refuses to treat a CONFIRMED_REGRESSION as trustworthy when round facts are too sparse to re-derive', () => {
    const b = goodBundle();
    for (const r of b.rounds as Record<string, unknown>[]) delete r.infraSignal;
    assert.ok(validateBundle(b).some((e) => /cannot be independently re-derived/.test(e)));
  });

  it('self-review N3: the sparse-facts refusal covers a PASS claim too (was: CONFIRMED/PRE_EXISTING only)', () => {
    // Pre-fix attack: a fabricated PASS deleted infraSignal from every round —
    // the re-derivation clause named only CONFIRMED_REGRESSION/PRE_EXISTING_-
    // FAILURE, so the validator SKIPPED its own check for PASS and validated
    // the lie clean (isTrustworthy() said true from JSON alone).
    const b = goodBundle();
    setCls(b, { label: 'PASS', rule: 3, reproductionCount: 1 });
    for (const r of b.rounds as Record<string, unknown>[]) {
      r.exitCode = 0;
      delete r.reportedFailing;
      delete r.failingTestNames;
      delete r.infraSignal; // "did not look" must not be PASS-compatible
    }
    const issues = validateBundle(seal(b)); // sealed: integrity is NOT the reason
    assert.ok(issues.some((e) => /cannot be independently re-derived/.test(e)),
      `PASS over un-re-derivable rounds must die: ${issues.join('; ')}`);
  });

  it('robustness H1: rejects duplicate (arm,round) indices (resealed)', () => {
    const b = goodBundle();
    const rounds = b.rounds as Record<string, unknown>[];
    rounds[1] = structuredClone(rounds[0]!); // two baseline #1
    b.integrity = integrityFor(b);          // resealed -> must be a structural/semantic reject
    assert.ok(validateBundle(b).some((e) => /duplicate round/.test(e)));
  });

  it('round-3 B1: a RESEALED CONFIRMED whose failing identities under-account the count dies twice over', () => {
    const b = goodBundle();
    for (const r of b.rounds as Record<string, unknown>[]) {
      if (r.arm === 'candidate') { r.failingTestNames = ['only one identity']; }
    }
    const issues = validateBundle(seal(b)); // coherent reseal: integrity is NOT the reason
    assert.ok(issues.some((e) => /coverage guard bypassed/.test(e)),
      `explicit identity-coverage gate must fire: ${issues.join('; ')}`);
    assert.ok(issues.some((e) => /re-derivation .* yields INCONCLUSIVE rule 11/.test(e)),
      `classifier re-derivation must independently refuse: ${issues.join('; ')}`);
  });

  it('round-3 B2: a PASS label over zero-assertion (pending-only) rounds is rejected', () => {
    const b = goodBundle();
    (b.classification as Record<string, unknown>).label = 'PASS';
    (b.classification as Record<string, unknown>).rule = 3;
    for (const r of b.rounds as Record<string, unknown>[]) {
      r.exitCode = 0;
      r.reportedPassing = 0;
      r.reportedFailing = 0;
      r.reportedPending = 42;
      delete r.failingTestNames;
    }
    const issues = validateBundle(seal(b));
    assert.ok(issues.some((e) => /re-derivation .* yields INFRASTRUCTURE_FAILURE/.test(e)),
      `pending-only rounds execute nothing — PASS must not survive: ${issues.join('; ')}`);
  });
});
