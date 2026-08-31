import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  validateBundle, integrityFor, EVIDENCE_SCHEMA_VERSION,
  buildPublishedSchema, structuralIssues, BUNDLE_CONTRACT,
} from '../src/index.js';

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
    // Post-sol RB-2: EXECUTED totals (passing+failing) must match across
    // arms for a trustful label — baseline 5+0 vs candidate 2+3 = 5 — so the
    // independent coverage-parity gate accepts this shape (an incomparable
    // one is tested below).
    ...(arm === 'candidate'
      ? { reportedPassing: 2, reportedFailing: 3, failingTestNames: ['a test', 'b test', 'c test'] }
      : { reportedPassing: 5 }),
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
    // Post-sol RB-2: a trustful label also requires REPEATED execution —
    // >= 2 rounds per arm (the planner enforces repeats >= 2; the validator
    // independently refuses a "confirmed"/"pass" claim built on one round).
    rounds: [round('baseline', 1), round('baseline', 2), round('candidate', 1), round('candidate', 2)],
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
    classification: { label: 'CONFIRMED_REGRESSION', rule: 5, reason: 'ok', reproductionCount: 2 },
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
      // reportedPassing 5 keeps the arms comparable (post-sol RB-2) so the
      // refusal tested here is the label/round contradiction, not coverage.
      if (r.arm === 'candidate') { r.exitCode = 0; r.reportedPassing = 5; delete r.reportedFailing; delete r.failingTestNames; }
    }
    assert.ok(validateBundle(b).some((e) => /re-derivation from these rounds yields PASS rule 3/.test(e)),
      String(validateBundle(b)));
  });

  it('rejects a CONFIRMED_REGRESSION built from rounds whose failure identities differ (must re-derive FLAKY rule 8)', () => {
    const b = goodBundle();
    // goodBundle carries two candidate rounds; diverging #2's identities
    // makes the failing profiles disagree across repetitions.
    ((b.rounds as Record<string, unknown>[])[3]!).failingTestNames = ['other test', 'b test', 'c test'];
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
    assert.ok(validateBundle(b).some((e) => /reproductionCount=100 but bundle has 2 candidate/.test(e)));
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

  // POST-SOL RB-2: a trustful label must be anchored to comparable, stable,
  // repeated test execution. The classifier re-derivation catches these via
  // rules 12/13; the validator ALSO refuses them through an INDEPENDENT
  // parity gate (the bundle must refute the lie even if the decision table
  // changes — same posture as the round-3 B1 identity-coverage gate).
  it('post-sol RB-2: a resealed trustful bundle over incomparable arm coverage dies twice over', () => {
    const b = goodBundle();
    // candidate executes 2+8 = 10 where baseline executes 5 (collapse/
    // disappearance shaped as a 'regression'): re-seal so integrity is NOT
    // the reason.
    for (const r of b.rounds as Record<string, unknown>[]) {
      if (r.arm === 'candidate') r.reportedFailing = 8;
    }
    (b.rounds as Record<string, unknown>[]).forEach((r) => {
      if (r.arm === 'candidate' && Array.isArray(r.failingTestNames)) {
        r.failingTestNames = ['a test', 'b test', 'c test', 'd test', 'e test', 'f test', 'g test', 'h test'];
      }
    });
    const issues = validateBundle(seal(b));
    assert.ok(issues.some((e) => /coverage-parity gate bypassed/i.test(e)),
      `independent parity gate must fire: ${issues.join('; ')}`);
    assert.ok(issues.some((e) => /re-derivation .* yields INCONCLUSIVE rule 13/.test(e)),
      `classifier re-derivation must independently refuse: ${issues.join('; ')}`);
  });

  it('post-sol RB-2: a trustful label with only ONE round per arm is refused', () => {
    const b = goodBundle();
    b.rounds = (b.rounds as Record<string, unknown>[]).filter((r) => !(r.arm === 'candidate' && r.round === 2));
    (b.classification as Record<string, unknown>).reproductionCount = 1;
    const issues = validateBundle(seal(b)); // classify over 1+2 rounds still says CR 5
    assert.ok(issues.some((e) => /requires >= 2 .* rounds/.test(e)),
      `single-round-per-arm trustful claim must die: ${issues.join('; ')}`);
  });

  it('post-sol RB-2: unstable repetition coverage under a trustful label is refused (baseline 5 vs 4 passing)', () => {
    const b = goodBundle();
    const rounds = b.rounds as Record<string, unknown>[];
    rounds[1]!.reportedPassing = 4; // baseline #2 lost a test
    const issues = validateBundle(seal(b));
    assert.ok(issues.some((e) => /coverage-parity/i.test(e)), issues.join('; '));
  });

  it('post-sol RB-2: weak labels carry no parity requirement (honest INCONCLUSIVE rule 13 validates)', () => {
    const b = goodBundle();
    const EIGHT = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    for (const r of b.rounds as Record<string, unknown>[]) {
      if (r.arm === 'candidate') { r.reportedFailing = 8; r.failingTestNames = [...EIGHT]; }
    }
    setCls(b, { label: 'INCONCLUSIVE', rule: 13 });
    // classify over these facts yields INCONCLUSIVE rule 13 — an honest
    // downgrade of a coverage-incomparable run must validate clean.
    assert.deepEqual(validateBundle(seal(b)), [], validateBundle(seal(b)).join('; '));
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

// ---------------------------------------------------------------------------
// POST-SOL M-1 — ONE DELIBERATE CONTRACT. The runtime floor and the
// published JSON schema are two VIEWS of contract.ts; this suite pins:
//   (a) the committed schema FILE equals the GENERATED schema (drift dies);
//   (b) every 'always'-required field of the contract is enforced at runtime
//       (the four deletions Sol demonstrated are in the matrix explicitly);
//   (c) intentionally-optional fields stay optional (no crude strictification);
//   (d) unknown fields are refused at every strict scope (matching the
//       schema's additionalProperties:false — the unknown-field policy is
//       INTENTIONAL, not accidental);
//   (e) the trustful tier (infraSignal / snapshots / observationAnomalies)
//       is required for trustful labels and optional for weak ones.
// ---------------------------------------------------------------------------
describe('post-sol M-1 — contract.ts is the single source of truth', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
  const publishedPath = path.join(repoRoot, 'schemas', 'evidence.schema.json');

  it('the committed schemas/evidence.schema.json EQUALS the generated contract (no drift)', () => {
    assert.ok(fs.existsSync(publishedPath), `published schema file missing at ${publishedPath}`);
    const committed = JSON.parse(fs.readFileSync(publishedPath, 'utf8')) as unknown;
    assert.deepEqual(committed, buildPublishedSchema(),
      'schemas/evidence.schema.json is stale relative to contract.ts — regenerate from the contract');
  });

  type Spec = { req: string; kind?: string; obj?: Record<string, Spec>; arr?: Spec };
  const requiredPaths = (spec: Spec, prefix: string, out: string[]): void => {
    if (spec.arr) { requiredPaths(spec.arr, `${prefix}[0]`, out); return; }
    if (spec.obj) {
      for (const [k, sub] of Object.entries(spec.obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (sub.req === 'always') out.push(p);
        if (sub.req === 'optional') continue; // intentionally optional subtree
        requiredPaths(sub, p, out);
      }
    }
  };
  const drop = (o: Record<string, unknown>, dotted: string): void => {
    const segs = dotted.replace(/\[0\]/g, '.0').split('.').filter(Boolean);
    let cur: unknown = o;
    for (let i = 0; i < segs.length - 1; i++) cur = (cur as Record<string, unknown>)[segs[i]!];
    delete (cur as Record<string, unknown>)[segs[segs.length - 1]!];
  };

  it('every always-required contract field is refused at runtime when DELETED (Sol: commands, killedByTimeout, startedAt, durationMs included)', () => {
    const paths: string[] = [];
    requiredPaths(BUNDLE_CONTRACT as unknown as Spec, '', paths);
    assert.ok(paths.includes('commands'), 'commands must be always-required now');
    assert.ok(paths.includes('rounds[0].killedByTimeout') && paths.includes('rounds[0].startedAt') && paths.includes('rounds[0].durationMs'));
    assert.ok(paths.includes('environment') && paths.includes('environment.toolchainOverrides'));
    for (const p of paths) {
      const b = goodBundle();
      drop(b, p);
      const issues = validateBundle(b);
      const leaf = p.split('.').pop()!.replace(/\[0\]/, '');
      assert.ok(issues.some((i) => i.includes(leaf)), `${p}: runtime accepted a bundle missing an always-required field: ${issues.join('; ')}`);
    }
  });

  it('intentionally-optional fields may be absent (we do not blind-strictify)', () => {
    const b = goodBundle();
    for (const r of b.rounds as Record<string, unknown>[]) {
      delete r.reportedPassing; delete r.reportedPending; delete r.crashSignal; delete r.sweepFailed; delete r.failingTestNames;
    }
    // reportedFailing removed too (baseline never had it); re-derivation then
    // sees no counts -> those become INFRA-flagged rounds, so compare only
    // the STRUCTURAL floor: structuralIssues must stay silent.
    assert.deepEqual(structuralIssues(b as Record<string, unknown>)
      .filter((i) => /reportedPassing|reportedPending|crashSignal|sweepFailed|failingTestNames/.test(i)), []);
    // ai stays optional with the full weak-label path: INCONCLUSIVE rule 0
    // with no rounds is impossible; instead assert absence of ai is fine:
    const b2 = goodBundle();
    delete b2.ai;
    assert.equal((b2 as Record<string, unknown>).ai, undefined);
    assert.ok(!structuralIssues(b2).some((i) => /(^|\.)ai\b|ai missing/.test(i)));
  });

  it('unknown fields are refused at root, round, and treeComparison scopes (policy is intentional)', () => {
    for (const where of [['bogus'], ['rounds', '0', 'bogus'], ['treeComparison', 'bogus'], ['classification', 'bogus'] as const]) {
      const b = goodBundle();
      if (where.length === 1) b[where[0]!] = 1;
      else if (where[0] === 'rounds') (b.rounds as Record<string, unknown>[])[0]![where[2]!] = 1;
      else (b[where[0]!] as Record<string, unknown>)[where[1]!] = 1;
      const issues = structuralIssues(b);
      assert.ok(issues.some((i) => /unknown fields are refused by policy/.test(i)), `${where.join('.')}: ${issues.join('; ')}`);
    }
  });

  it('trustful-tier fields: deleted infraSignal/snapshots/anomalies kill a trustful claim but validate clean under a weak honest label', () => {
    const b = goodBundle();
    for (const r of b.rounds as Record<string, unknown>[]) delete r.infraSignal;
    delete (b.treeComparison as Record<string, unknown>).snapshots;
    delete (b.treeComparison as Record<string, unknown>).observationAnomalies;
    const trustfulIssues = validateBundle(seal(b));
    assert.ok(trustfulIssues.some((e) => /infraSignal/.test(e)), trustfulIssues.join('; '));
    assert.ok(trustfulIssues.some((e) => /requires a retained treeComparison/.test(e)), trustfulIssues.join('; '));
    // same deletions under an honest INCONCLUSIVE rule 0... rule 0 needs a
    // missing arm; rule 13 is the honest coverage story here:
    const w = goodBundle();
    for (const r of w.rounds as Record<string, unknown>[]) { delete r.infraSignal; }
    (w.treeComparison as Record<string, unknown>).observationStatus = { baseline: 'INCOMPLETE', candidate: 'VALID' };
    delete (w.treeComparison as Record<string, unknown>).snapshots;
    delete (w.treeComparison as Record<string, unknown>).observationAnomalies;
    (w.classification as Record<string, unknown>).label = 'INCONCLUSIVE';
    (w.classification as Record<string, unknown>).rule = 10;
    assert.deepEqual(validateBundle(seal(w)), [], validateBundle(seal(w)).join('; '));
  });

  it('round indices must be contiguous per arm (an omitted round shrinks the claimed reproduction)', () => {
    const b = goodBundle();
    // rounds order: baseline#1, baseline#2, candidate#1, candidate#2 —
    // drop baseline#1 so the baseline arm starts at #2 (a silent gap):
    (b.rounds as Record<string, unknown>[]).splice(0, 1);
    const issues = validateBundle(seal(b));
    assert.ok(issues.some((e) => /contiguous 1\.\./.test(e)), issues.join('; '));
  });
});
