/**
 * Evidence Bundle v1 — the machine-readable artifact that makes a Canary
 * conclusion auditable by someone who does not trust Canary.
 *
 * Invariants enforced by validateBundle():
 *  - classification lives ONLY under `classification` and is one of the six
 *    deterministic labels;
 *  - every round carries raw AND normalized stream hashes;
 *  - SEMANTIC integrity (audit F3): the label is RE-DERIVED from the round
 *    facts by the very decision table that produced it, and internal
 *    contradictions (timeout/exit, reproductionCount, unconfined drift with a
 *    trustful verdict) are rejected. A hand-authored bundle whose story does
 *    not follow from its own facts is invalid, not just a weird-looking one.
 *  - optional `ai` data is namespaced and has no path to classification —
 *    the type system literally cannot express an AI-authored verdict.
 */

import {
  classify, type RoundFact, type ExecutionObservation,
} from '@canary-rn/classification';

/**
 * The mirror's OWN copy of the strong-label list (post-GLM round-5 F2).
 * Imported before that — while the docs claimed "three sites, own constants,
 * weakening one leaves two" — a single edit to the classifier's array
 * silently disabled enforcement sites 1 AND 2 together. Independence needs
 * its own bytes: this list is what panel H keys on, and
 * schema.test.ts pins STRONG_MIRROR_LABELS == STRONG_EXECUTION_LABELS as a
 * deliberate, tested coupling (shrinking EITHER list without shrinking both
 * fails CI; the third site, prove's byte binding, keys on no label list at
 * all). Same two-tier posture as TRUSTFUL_LABELS in contract.ts — the
 * pattern always was the point; STRONG just never got it.
 */
export const STRONG_MIRROR_LABELS: readonly string[] = [
  'PASS', 'CONFIRMED_REGRESSION', 'PRE_EXISTING_FAILURE', 'FLAKY',
];
import { KNOWN_RUNNER_RELEASES } from '@canary-rn/support';
import { canonicalJson, sha256hex } from '@canary-rn/hashing';
import { structuralIssues } from './contract.js';

/** sha256 of zero bytes — the frames hash of a round that carried no frames. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';


// Post-sol M-1: the structural contract (shared source of truth for BOTH the
// runtime floor and the published JSON schema) is re-exported so consumers
// (apps/cli e2e tests) can validate against it too.
export { buildPublishedSchema, structuralIssues, BUNDLE_CONTRACT, TRUSTFUL_LABELS } from './contract.js';

export const EVIDENCE_SCHEMA_VERSION = 1;

export const CLASSIFICATION_LABELS = [
  'PASS',
  'CONFIRMED_REGRESSION',
  'PRE_EXISTING_FAILURE',
  'FLAKY',
  'INFRASTRUCTURE_FAILURE',
  'INCONCLUSIVE',
] as const;
export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

export interface RoundEvidence {
  arm: 'baseline' | 'candidate';
  round: number;
  exitCode: number;
  killedByTimeout: boolean;
  hasRunnerSummary: boolean;
  /** Deterministic infra pattern matched in this round's output (audit F3:
   *  required for the validator to re-derive the classification faithfully).
   *  Audit B2: recognized at ANY exit code, including 0. */
  infraSignal?: boolean | undefined;
  /** Passing-test count as parsed from the runner summary, if readable
   *  (round-3 blocker 2: passing+failing — NOT pending — defines the
   *  executed-total; pending tests never execute an assertion). */
  reportedPassing?: number | undefined;
  /** Failing-test count as parsed from the runner summary, if machine-readable. */
  reportedFailing?: number | undefined;
  /** Pending/skipped count as parsed from the runner summary. Recorded for
   *  transparency only; excluded from the executed-total (audit B2 corrected
   *  by round-3 blocker 2). */
  reportedPending?: number | undefined;
  /** Sorted, deduped failing-test identities parsed from this round's log
   *  (audit F13). Round-3 blocker 1: trustful labels additionally require
   *  |unique identities| == reportedFailing on every failing round — a
   *  partial parse cannot anchor a regression claim. */
  failingTestNames?: string[] | undefined;
  /** Fatal runtime crash signature (heap OOM / abort / segfault) observed in
   *  this round's output (round-3 secondary: a valid summary followed by a
   *  crash must not masquerade as a clean run). */
  crashSignal?: boolean | undefined;
  /** Post-exit containment sweep could not confirm zero survivors (round-3
   *  secondary: isolation unknown => execution invalid). */
  sweepFailed?: boolean | undefined;
  /**
   * Post-GLM observation hardening — Canary's OWN execution record for this
   * round (contract panel E): what Canary injected, what the in-process
   * observer watched, and how the two channels agreed. REQUIRED on every
   * round; a subject-side bundle can carry it but cannot MAKE it VALID —
   * prove re-runs the shared validator over the retained .attest.ndjson
   * bytes and byte-compares. Missing means old bundle (refused); ABSENT
   * means Canary observed nothing, which structurally caps the label.
   */
  executionObservation: ExecutionObservation;
  startedAt: string;
  durationMs: number;
  rawStdoutSha256: string;
  rawStderrSha256: string;
  normalizedStdoutSha256: string;
  normalizedStderrSha256: string;
  /** path relative to the bundle's artifacts directory */
  logPath: string;
  argv: string[];
  envKeys: string[];
}

/**
 * Round-3 blocker 6 — a RETAINED, VERIFIABLE snapshot of one arm's
 * dependency-tree observation. Before this, `npm ls --json` output was
 * flattened, hashed, and DISCARDED: the tree hashes, copy counts, VALID
 * status, and drift confinement inside the bundle referenced nothing that
 * could later be re-checked — a resealed bundle could claim any tree facts
 * with zero evidence behind them. These refs name the raw (and canonical)
 * artifact files whose bytes a verifier re-flattens INDEPENDENTLY of the
 * pipeline's parser (apps/cli/src/verify-tree.ts) and re-derives every tree
 * fact from. Filenames are DERIVED from the arm (like round logs, audit B3),
 * so a bundle cannot redirect a snapshot to another arm's bytes.
 */
export interface TreeSnapshotRef {
  rawStdoutLog: string;
  rawStdoutSha256: string;
  rawStderrLog: string;
  rawStderrSha256: string;
  canonicalLog: string;
  canonicalSha256: string;
}

/** Per-arm observation anomalies recorded by the npm-ls flatten: nodes with
 *  missing/unreadable versions, unwalked subtrees, malformed entries. A
 *  physical disk cross-check is deliberately NOT part of the trust path:
 *  `npm ls` reports the LOGICAL tree (dedupe/hoist re-arranges physical
 *  locations), so raw disk-vs-JSON key comparison would fire false
 *  incompleteness on every real hoisted install; the logical tree is what
 *  drift keys address. Trustful verdicts require this array present AND
 *  empty (a missing array is indistinguishable from "did not look", which is
 *  exactly what must not anchor trust). The JSON anomaly list itself is
 *  RE-DERIVABLE from the retained snapshot bytes by verify-tree. */
export interface TreeAnomalies {
  json: string[];
}

export interface EvidenceBundle {
  schemaVersion: number;
  runId: string;
  createdAt: string;
  canaryVersion: string;
  experimentId: string;
  dependency: {
    package: string;
    baselineVersion: string;
    candidateVersion: string;
  };
  downstream: {
    repositoryUrl: string;
    commitSha: string;
    fetchMethod: 'tarball-by-sha';
    tarballSha256: string;
  };
  environment: {
    nodeVersion: string;
    npmVersion: string;
    packageManagerUsed: string;
    platform: string;
    arch: string;
    toolchainOverrides: Record<string, string>;
  };
  commands: {
    prepare: string[][];
    build: string[][];
    swap: string[];
    test: string[];
  };
  rounds: RoundEvidence[];
  treeComparison: {
    baselineTreeSha256: string;
    candidateTreeSha256: string;
    driftConfinedToDependency: boolean;
    /** Audit B6 — completeness of each arm's tree observation. A trustful
     *  verdict requires both 'VALID'; the pipeline's applyConfinementGuard
     *  downgrades otherwise, and this validator independently refuses a
     *  trustful label built on an incomplete/invalid observation. */
    observationStatus: { baseline: string; candidate: string };
    /** Where each arm's test code actually resolves the dependency from
     *  and the version found there — attested, not claimed (red-team F3). */
    resolvedVersions: { baseline: string; candidate: string };
    dependencyCopies: { baseline: number; candidate: number };
    /** Round-3 blocker 6: retained, arm-name-derived artifact refs for each
     *  arm's `npm ls` observation. REQUIRED (and required empty-anomaly) for
     *  any trustful verdict; verify-tree re-derives the tree facts from them. */
    snapshots?: { baseline: TreeSnapshotRef; candidate: TreeSnapshotRef } | undefined;
    /** Per-arm anomaly lists recorded by the flatten (see TreeAnomalies). */
    observationAnomalies?: { baseline: TreeAnomalies; candidate: TreeAnomalies } | undefined;
  };
  classification: {
    label: ClassificationLabel;
    rule: number;
    reason: string;
    reproductionCount: number;
  };
  /**
   * Audit B4 — deterministic MANIFEST digest binding the run's release-critical
   * claims into a single self-consistency hash. It covers the whole bundle
   * EXCEPT this `integrity` field (canonical, key-sorted serialization). Because
   * the per-round artifact DIGESTS are inside that scope, the manifest is
   * transitively bound to the on-disk bytes that verifyArtifacts checks, so a
   * rewrite of ANY field (experimentId, runId, repo URL, tarball digest, argv,
   * env keys, counts, failing identities, tree facts, classification) without
   * recomputing the manifest is caught here.
   *
   * HONEST SCOPE: this is content INTEGRITY / tamper-EVIDENCE and cross-field
   * coherence — NOT authenticated provenance. There is no external trust root or
   * signature; a forger who controls the whole file can recompute the digest.
   * The fields that can be checked against reality are checked by
   * verifyArtifacts (digests↔bytes) and verifyArtifactSemantics (facts↔bytes);
   * the fields that cannot (repo URL, tarball digest, argv) are pinned against
   * the committed proof by assertProof. Do not read this hash as a signature.
   */
  integrity?: BundleIntegrity | undefined;
  /** Optional, non-authoritative, structurally unable to affect classification. */
  ai?: {
    provider: string;
    summary: string;
    attachedAt: string;
  };
}

export interface BundleIntegrity {
  version: number;
  /** sha256 over canonicalJson(bundle minus `integrity`). */
  manifestSha256: string;
}

/** Recompute the manifest digest over a bundle (any `integrity` field is
 *  excluded so this is stable whether or not one is already attached). */
export function computeManifestSha256(bundle: unknown): string {
  const { integrity: _omit, ...rest } = bundle as Record<string, unknown>;
  void _omit;
  return sha256hex(canonicalJson(rest));
}

/** Produce the integrity block for a freshly-built bundle. */
export function integrityFor(bundle: unknown): BundleIntegrity {
  return { version: 1, manifestSha256: computeManifestSha256(bundle) };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The exact variable names @canary-rn/support grants to children (both
 * platforms). Every round's envKeys must be a subset — the sanitized
 * boundary is thus auditable from the bundle alone (red-team F9).
 *
 * The last six are the audit-F6 NEUTRALIZATIONS: the Windows loader appends
 * these session-identity vars to every child environment no matter what, so
 * support declares them with fixed non-identity values instead of pretending
 * they are absent (packages/support/test/env.test.ts proves the child's
 * OBSERVED set equals this declaration on the executing host).
 */
export const SANITIZE_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'TMPDIR', 'LANG',
  'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMDRIVE',
]);

type Issue = string;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** Structural validation of a bundle. Returns issues; empty array = valid.
 *
 * Post-sol M-1: the structural floor (field presence, types, the
 * unknown-field policy) is derived from the SAME contract table that
 * generates the published schemas/evidence.schema.json — the runtime and
 * the published contract are now one definition viewed twice, and
 * schema.test.ts pins both directions of that equivalence. What stays
 * hand-written below is deliberately SEMANTIC: uniqueness/density of round
 * indices, the env-key allowlist, artifact-name ownership, attestation
 * coherence, the trustful evidence floor, and the full re-derivation.
 */
export function validateBundle(b: unknown): Issue[] {
  const issues: Issue[] = [];
  if (typeof b !== 'object' || b === null) return ['root is not an object'];
  const o = b as Record<string, unknown>;

  if (o.schemaVersion !== EVIDENCE_SCHEMA_VERSION) issues.push(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  issues.push(...structuralIssues(o));

  const rounds = o.rounds;
  if (Array.isArray(rounds) && rounds.length > 0) {
    const kinds = new Set<string>();
    // Robustness H1 (round-2): each (arm, round) must be UNIQUE. A duplicated
    // index lets a bundle carry two contradictory claims for the same slot and
    // desyncs arm/round-derived artifact names from the rounds array.
    // Post-sol M-1 adds the other half of the honesty condition: the indices
    // must form a CONTIGUOUS 1..n per arm (an omitted round silently shrinks
    // the claimed reproduction).
    const seenIds = new Set<string>();
    const byArm: Record<'baseline' | 'candidate', number[]> = { baseline: [], candidate: [] };
    rounds.forEach((r: Record<string, unknown>, i) => {
      const at = `rounds[${i}]`;
      if (r.arm === 'baseline' || r.arm === 'candidate') {
        kinds.add(r.arm);
        byArm[r.arm].push(Number(r.round));
      } else issues.push(`${at}.arm invalid`);
      if (r.arm === 'baseline' || r.arm === 'candidate') {
        const rid = `${String(r.arm)}#${String(r.round)}`;
        if (seenIds.has(rid)) issues.push(`${at}: duplicate round ${rid} (each arm/round must appear once)`);
        else seenIds.add(rid);
      }
      if (typeof r.exitCode !== 'number' || !Number.isInteger(r.exitCode) || r.exitCode < -1) {
        issues.push(`${at}.exitCode invalid`);
      }
      if (Array.isArray(r.envKeys)) {
        for (const k of r.envKeys as unknown[]) {
          if (!SANITIZE_ALLOWLIST.has(String(k))) issues.push(`${at}.envKeys contains non-allowlisted var: ${String(k)}`);
        }
      }
    });
    if (!kinds.has('baseline')) issues.push('no baseline rounds');
    if (!kinds.has('candidate')) issues.push('no candidate rounds');
    for (const [armName, idx] of Object.entries(byArm) as Array<['baseline' | 'candidate', number[]]>) {
      const sorted = idx.filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
      sorted.forEach((n, k) => { if (n !== k + 1) issues.push(`${armName} rounds are not a contiguous 1..${sorted.length} sequence (got ${sorted.join(',')}) — omitted rounds shrink the claimed reproduction (post-sol M-1)`); });
    }
  } else {
    issues.push('rounds must be a non-empty array');
  }

  const cls = o.classification as Record<string, unknown> | undefined;
  const tc = o.treeComparison as Record<string, unknown> | undefined;
  const rv = tc?.resolvedVersions as Record<string, unknown> | undefined;
  // Round-3 blocker 6: resolvedVersions are ATTESTED from the machine, and
  // the pipeline aborts the run whenever an attestation disagrees with the
  // spec (steps [3]/[6]). So inside one honest bundle they can never differ
  // from the recorded dependency versions — a mismatch therefore cannot be
  // an artifact of an honest run; it means a tree fact was resealed under a
  // manifest that still advertises the original spec versions.
  const depVer = o.dependency as Record<string, unknown> | undefined;
  for (const [arm, field] of [['baseline', 'baselineVersion'], ['candidate', 'candidateVersion']] as const) {
    if (rv && depVer && isStr(rv[arm]) && isStr(depVer[field]) && rv[arm] !== depVer[field]) {
      issues.push(`treeComparison.resolvedVersions.${arm} '${String(rv[arm])}' contradicts dependency.${field} '${String(depVer[field])}' (attestation would have aborted the run — a resealed tree fact)`);
    }
  }
  // Round-3 blocker 6 (types/presence now contract-enforced): retained
  // snapshot refs must carry THIS ARM'S DERIVED artifact names — evidence
  // may not point its own snapshot at another arm's bytes (audit B3 lesson).
  const snaps = tc?.snapshots as Record<string, unknown> | undefined;
  if (snaps !== undefined) {
    for (const arm of ['baseline', 'candidate'] as const) {
      const s = snaps[arm] as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') continue; // presence/type: contract
      for (const [f, suffix] of [
        ['rawStdoutLog', 'treels.raw.log'], ['rawStderrLog', 'treels.stderr.log'], ['canonicalLog', 'treels.canonical.json'],
      ] as const) {
        if (s[f] !== `tree-${arm}.${suffix}`) {
          issues.push(`treeComparison.snapshots.${arm}.${f} '${String(s[f])}' is not this arm's canonical artifact name (tree-${arm}.${suffix})`);
        }
      }
    }
  }

  // Audit B4: the manifest digest is mandatory and must recompute over the
  // bundle's own (canonical) fields. A rewrite of any bound field without
  // recomputing the manifest is caught here (content integrity / cross-field
  // coherence — NOT authenticated provenance; see the interface docs).
  // Presence/type of integrity.{version,manifestSha256} is contract-governed;
  // the RECOMPUTE is the semantic heart of audit B4 and stays here.
  const integ = o.integrity as Record<string, unknown> | undefined;
  if (integ && integ.version !== 1) issues.push('integrity.version must be 1');
  if (integ && typeof integ.manifestSha256 === 'string' && HEX64.test(integ.manifestSha256)) {
    const recomputed = computeManifestSha256(o);
    if (recomputed !== integ.manifestSha256) {
      issues.push(
        `integrity.manifestSha256 mismatch — a bound field was rewritten without recomputing the manifest ` +
        `(recorded ${String(integ.manifestSha256).slice(0, 16)}…, recomputed ${recomputed.slice(0, 16)}…)`,
      );
    }
  }

  if (Array.isArray(rounds) && rounds.length > 0) {
    semanticChecks(
      rounds as Record<string, unknown>[],
      cls ?? {}, tc ?? {},
      issues,
    );
  }

  return issues;
}

/**
 * Audit F3: structural well-formedness is necessary but nowhere near
 * sufficient — the earlier validator accepted ANY well-shaped bundle,
 * including contradictory fabrications (label at odds with its own rounds).
 * These checks make the bundle refute itself if it lies.
 */
function semanticChecks(
  rounds: Record<string, unknown>[],
  cls: Record<string, unknown>,
  tc: Record<string, unknown>,
  issues: Issue[],
): void {
  // 1. Per-round internal contradictions.
  for (const r of rounds) {
    const at = `round ${String(r.arm)}#${String(r.round)}`;
    // Audit B3: the log path must be the canonical name OWNED by this round.
    // (verifyArtifacts re-derives bytes from arm/round, never from logPath;
    // this check makes a lying path a structural bundle error too.)
    if (typeof r.logPath === 'string' &&
      (r.arm === 'baseline' || r.arm === 'candidate') &&
      Number.isInteger(r.round) && (r.round as number) >= 1 &&
      r.logPath !== `${String(r.arm)}-${String(r.round)}.stdout.log`) {
      issues.push(`${at}: logPath '${String(r.logPath)}' is not this round's canonical artifact path (${String(r.arm)}-${String(r.round)}.stdout.log)`);
    }
    if (r.killedByTimeout === true && r.exitCode !== -1) {
      issues.push(`${at}: killedByTimeout but exitCode=${String(r.exitCode)} (a killed round exits -1)`);
    }
    for (const key of ['reportedPassing', 'reportedFailing', 'reportedPending'] as const) {
      const v = r[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
        issues.push(`${at}: ${key} must be a non-negative integer when present`);
      }
    }
    if (r.failingTestNames !== undefined &&
      !(Array.isArray(r.failingTestNames) && (r.failingTestNames as unknown[]).every((x) => typeof x === 'string'))) {
      issues.push(`${at}: failingTestNames must be an array of strings when present`);
    }
    for (const key of ['crashSignal', 'sweepFailed'] as const) {
      if (r[key] !== undefined && typeof r[key] !== 'boolean') {
        issues.push(`${at}: ${key} must be boolean when present`);
      }
    }
    // Post-GLM panel E: the observation object's cross-field iff-rules —
    // the layout JSON Schema can only half-express, owned by this layer.
    const o = r.executionObservation as Record<string, unknown> | undefined;
    if (o && typeof o === 'object') {
      const st = o.status;
      const has = (k: string): boolean => o[k] !== undefined;
      if (st === 'VALID') {
        if (!has('observedCounts') || !has('observedMochaVersion') || !has('expectedMochaVersion')
          || !has('expectedRunnerTreeSha256') || !has('observedRunnerTreeSha256')) {
          issues.push(`${at}: executionObservation VALID must carry counts + expected/observed version + expected/observed tree sha (panel E iff)`);
        }
        if (has('invalidReason') || has('absentKind') || has('strayFd3Bytes')) {
          issues.push(`${at}: executionObservation VALID must not carry invalidReason/absentKind/stray fields`);
        }
      } else if (st === 'INVALID') {
        if (!has('invalidReason')) issues.push(`${at}: executionObservation INVALID requires invalidReason`);
        if (has('observedCounts') || has('absentKind') || has('strayFd3Bytes')) {
          issues.push(`${at}: executionObservation INVALID must not carry counts/absentKind/stray fields`);
        }
      } else if (st === 'ABSENT') {
        if (!has('absentKind')) issues.push(`${at}: executionObservation ABSENT requires absentKind ("why Canary attempted nothing")`);
        if (has('observedCounts') || has('invalidReason') || has('observedMochaVersion')) {
          issues.push(`${at}: executionObservation ABSENT must not carry counts/invalidReason/observedMochaVersion`);
        }
        if (o.strayFd3Bytes === true && !has('strayFd3Sha256')) issues.push(`${at}: strayFd3Bytes=true requires strayFd3Sha256`);
        if (has('strayFd3Sha256') && o.strayFd3Bytes !== true) issues.push(`${at}: strayFd3Sha256 requires strayFd3Bytes=true`);
        if (has('expectedMochaVersion') || has('expectedRunnerTreeSha256')) {
          issues.push(`${at}: ABSENT means NO injection was attempted — expected* fields contradict it`);
        }
      }
      if ((o.framesSha256 === EMPTY_SHA256) !== (o.frameCount === 0)) {
        issues.push(`${at}: executionObservation.framesSha256 (empty-bytes hash?) disagrees with frameCount — bytes/counter desync`);
      }
    }
    // Round-3 blocker 1: a FAILING round of a trustful bundle must fully
    // account for its reported failures with parsed identities. This is an
    // independent coverage gate — it does not lean on the classifier's own
    // re-derivation (the validator must refute the lie even if the decision
    // table changes).
    const claimTrustful = cls?.label === 'CONFIRMED_REGRESSION' || cls?.label === 'PRE_EXISTING_FAILURE' || cls?.label === 'PASS';
    if (claimTrustful && typeof r.exitCode === 'number' && r.exitCode !== 0 &&
      typeof r.reportedFailing === 'number') {
      const parsed = Array.isArray(r.failingTestNames) ? new Set(r.failingTestNames).size : -1;
      if (parsed !== r.reportedFailing) {
        issues.push(
          `${at}: claims ${String(cls?.label)} but only ${parsed < 0 ? 'no' : String(parsed)} distinct parsed identities account for ${String(r.reportedFailing)} reported failures — trustful label built on a partial failure parse (rule-11/B1 coverage guard bypassed?)`,
        );
      }
    }
  }

  const candCount = rounds.filter((r) => r.arm === 'candidate').length;
  // 2. reproductionCount must be the candidate-arm round count (as the
  //    pipeline emits); a fabricated "100x reproduced" must die here.
  if (typeof cls.reproductionCount === 'number' && cls.reproductionCount !== candCount) {
    issues.push(`classification.reproductionCount=${cls.reproductionCount} but bundle has ${candCount} candidate round(s)`);
  }

  // 3. A verdict that asks the reader to TRUST arm comparability cannot ship
  //    with unconfined drift OR a non-VALID tree observation — the pipeline's
  //    rules 9/10 guard is verifiable here (audits F9 + B6).
  const label = cls.label as ClassificationLabel;
  const trustful = label === 'CONFIRMED_REGRESSION' || label === 'PRE_EXISTING_FAILURE' || label === 'PASS';
  const osv = tc.observationStatus as Record<string, unknown> | undefined;
  const treeValid = osv?.baseline === 'VALID' && osv?.candidate === 'VALID';
  if (tc.driftConfinedToDependency === false && trustful) {
    issues.push(`classification ${label} is impossible with driftConfinedToDependency=false (rule-9 guard bypassed?)`);
  }
  if (!treeValid && trustful) {
    issues.push(`classification ${label} is impossible with a non-VALID tree observation (baseline=${String(osv?.baseline)}, candidate=${String(osv?.candidate)}; rule-10/B6 guard bypassed?)`);
  }

  // 3c. Post-sol RB-2 — INDEPENDENT coverage-parity gate (the same posture
  // as the B1 identity-coverage gate: it must refute the lie even if the
  // decision table changes). A trustful label is a claim that BOTH arms
  // executed the SAME experiment, repeatedly:
  //   - >= 2 rounds per arm (a single round cannot 'reproduce' anything);
  //   - per-arm STABLE executed (passing+failing) and observed (+pending)
  //     totals across repetitions;
  //   - cross-arm COMPARABLE totals (undefined counts read as zero, exactly
  //     as the classifier does — a zero-count round is separately refused
  //     by the rules above/re-derivation).
  // Tests silently disappearing between arms are NOT equivalent to a stable
  // passing->failing transition, and may never anchor a strong verdict.
  // Precisely (post-GLM F1 wording): the cross-arm same-experiment invariant
  // enforced here and in classify() is CARDINALITY PLUS FAILING-SET
  // CONTAINMENT for PRE_EXISTING_FAILURE-shaped verdicts (restated at 3d) —
  // not identity correspondence; renamed/added PASSING tests at equal totals
  // stay inside the documented F3/§8.1 substitution ceiling.
  if (trustful) {
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const totals = (r: Record<string, unknown>) => {
      const executed = num(r.reportedPassing) + num(r.reportedFailing);
      return { executed, observed: executed + num(r.reportedPending) };
    };
    for (const armName of ['baseline', 'candidate'] as const) {
      const rs = rounds.filter((r) => r.arm === armName);
      if (rs.length < 2) {
        issues.push(`classification ${label} (trustful) requires >= 2 ${armName} rounds — a strong verdict needs repeated execution, one round proves no reproduction (post-sol RB-2)`);
        continue;
      }
      const first = totals(rs[0]!);
      for (const r of rs.slice(1)) {
        const t = totals(r);
        if (t.executed !== first.executed || t.observed !== first.observed) {
          issues.push(
            `classification ${label} (trustful) is impossible with ${armName} coverage-parity violation: rounds differ in executed/observed (${first.executed}/${first.observed} vs ${t.executed}/${t.observed}) — repetition coverage instability must cap at FLAKY (post-sol RB-2 coverage-parity gate bypassed?)`,
          );
          break;
        }
      }
      const cand = rounds.filter((r) => r.arm === 'candidate');
      if (armName === 'baseline' && cand.length >= 2) {
        const ct = totals(cand[0]!);
        if (ct.executed !== first.executed || ct.observed !== first.observed) {
          issues.push(
            `classification ${label} (trustful) is impossible with cross-arm coverage-parity violation: baseline executed/observed ${first.executed}/${first.observed}, candidate ${ct.executed}/${ct.observed} — weaker or missing test execution must not produce a stronger verdict (post-sol RB-2 coverage-parity gate bypassed?)`,
          );
        }
      }
    }
  }

  // 3b. Round-3 blocker 6 — a trustful verdict MUST be anchored to retained,
  // independently-verifiable tree snapshots, and those snapshots' anomaly
  // lists must be present AND EMPTY. Before this, tree hashes/copies/status/
  // drift floated free of any retained bytes: a resealed bundle could claim
  // VALID with hidden missing-version nodes and nothing on disk to refute it.
  if (trustful) {
    const snaps = tc.snapshots as Record<string, unknown> | undefined;
    const anoms = tc.observationAnomalies as Record<string, unknown> | undefined;
    for (const arm of ['baseline', 'candidate'] as const) {
      if (!snaps || typeof snaps[arm] !== 'object') {
        issues.push(`classification ${label} (trustful) requires a retained treeComparison.snapshots.${arm} artifact ref (round-3 B6 — tree facts are otherwise unverifiable)`);
      }
      const a = anoms?.[arm] as Record<string, unknown> | undefined;
      if (!a || !Array.isArray(a.json)) {
        issues.push(`classification ${label} (trustful) requires treeComparison.observationAnomalies.${arm}.json — a missing anomaly list is "did not look", not "nothing found"`);
      } else if ((a.json as unknown[]).length > 0) {
        issues.push(`classification ${label} (trustful) is impossible with ${String((a.json as unknown[]).length)} ${arm} tree-observation anomalies (partial/malformed observation cannot anchor trust, round-3 B6)`);
      }
    }
  }

  // 3d. Post-GLM panel H — INDEPENDENT execution-observation mirror. This
  // restates the classifier's gate (observationGateIssue) from the bundle's
  // own recorded fields, keyed on STRONG_MIRROR_LABELS — this package's own
  // copy of the strong set (equivalence with the classifier's constant is a
  // pinned, tested decision — see the constant's docblock), NOT the
  // retention-tier TRUSTFUL_LABELS (two tiers, two constants, never
  // conflated). Deliberately restated instead of relying on the re-derivation
  // below: a future decision-table edit must not silently weaken the floor —
  // the same "guard that changing it changes nothing" lesson rules 9/10 encode.
  if (STRONG_MIRROR_LABELS.includes(String(label))) {
    for (const r of rounds) {
      const at = `round ${String(r.arm)}#${String(r.round)}`;
      const o = r.executionObservation as Record<string, unknown> | undefined;
      if (!o || typeof o !== 'object' || o.status !== 'VALID') {
        issues.push(`${at}: ${String(label)} claims an execution outcome but executionObservation is ${o && typeof o === 'object' ? String(o.status) : 'missing'} — strong labels require a VALID Canary observation on EVERY round (panel H mirror)`);
        continue;
      }
      const nz = (v: unknown): number => (typeof v === 'number' && v >= 0 ? v : 0);
      const oc = o.observedCounts as Record<string, number> | undefined;
      if (!oc || oc.passing !== nz(r.reportedPassing) || oc.failing !== nz(r.reportedFailing) || oc.pending !== nz(r.reportedPending)) {
        issues.push(`${at}: ${String(label)} but observed counts disagree with text counts under ?? 0 semantics — the cross-channel gate was bypassed?`);
      }
      const obsIds = [...new Set((o.observedFailingIdentities as string[] | undefined) ?? [])].sort().join('\n');
      const txtIds = [...new Set((r.failingTestNames as string[] | undefined) ?? [])].sort().join('\n');
      if (obsIds !== txtIds) issues.push(`${at}: ${String(label)} but observed failing identities disagree with text identities — the cross-channel gate was bypassed?`);
      if (oc && typeof r.exitCode === 'number' && (oc.failing === 0 ? r.exitCode !== 0 : r.exitCode === 0)) {
        issues.push(`${at}: ${String(label)} but watched failures (${oc.failing}) contradict exit code ${r.exitCode} — panel D invariant violated`);
      }
      // AM-1 by construction: a VALID round must name the pinned release the
      // injection decision used, and BOTH tree hashes must equal the pin.
      const emv = o.expectedMochaVersion as string | undefined;
      const pin = (KNOWN_RUNNER_RELEASES['mocha'] ?? []).find((p) => p.version === emv);
      if (!pin || o.expectedRunnerTreeSha256 !== pin.treeSha256 || o.observedRunnerTreeSha256 !== pin.treeSha256) {
        issues.push(`${at}: ${String(label)} but the runner identity is not a Canary-pinned release (expectedMochaVersion=${String(emv)}) — strong verdicts require pinned runner BYTES (panel H/AM-1)`);
      }
      if (typeof o.framesSha256 !== 'string' || !HEX64.test(o.framesSha256)) {
        issues.push(`${at}: ${String(label)} but framesSha256 is not 64-hex — no retained frame stream to verify against`);
      }
    }
    // Post-GLM round-5 F1 restatement: PRE_EXISTING_FAILURE claims EVERY
    // candidate failure was already failing under baseline. Keyed on the
    // LABEL (not on a recomputed routing), so a decision-table edit that
    // removes the classifier-side containment check cannot silently make
    // the claim again: candidate observed failing identities not present in
    // the baseline union contradict the label's own reason text with
    // Canary-observed facts — a watched pass->fail transition may never be
    // swallowed, disjoint failing sets describe no comparable transition.
    if (String(label) === 'PRE_EXISTING_FAILURE') {
      const ids = (r: Record<string, unknown>): string[] => {
        const o = r.executionObservation as Record<string, unknown> | undefined;
        const obs = o?.observedFailingIdentities;
        return Array.isArray(obs) ? obs as string[] : Array.isArray(r.failingTestNames) ? r.failingTestNames as string[] : [];
      };
      const baseFailing = new Set(rounds.filter((r) => r.arm === 'baseline').flatMap(ids));
      const extra = [...new Set(rounds.filter((r) => r.arm === 'candidate').flatMap(ids).filter((x) => !baseFailing.has(x)))].sort();
      if (extra.length > 0) {
        issues.push(`classification PRE_EXISTING_FAILURE but candidate fails ${extra.length} identity/identities not failing in baseline (${extra.join(', ')}) — failing-set containment violated; the classifier's rule-13 extension was bypassed?`);
      }
    }
  }

  // 4. Re-derive the classification from the round facts using the SAME
  //    decision table that produced it. This only runs when the bundle
  //    carries every input the classifier consumed (infraSignal present on
  //    all rounds — bundles predating audit F13 cannot be semantically
  //    verified and are flagged as such when claiming a trustful verdict).
  //    Self-review N3: the flag previously named only CONFIRMED_REGRESSION /
  //    PRE_EXISTING_FAILURE, so a fabricated PASS could omit infraSignal on
  //    every round, skip the re-derivation entirely, and still validate
  //    clean — isTrustworthy() accepted a bundle whose story it could not
  //    check. PASS is trustful (§3 guards it as such); it must die here too.
  const fullFacts = rounds.every((r) => typeof r.hasRunnerSummary === 'boolean' && typeof r.infraSignal === 'boolean');
  if (!fullFacts) {
    if (trustful) {
      issues.push(`${label} (trustful) in a bundle without per-round infraSignal — classification cannot be independently re-derived`);
    }
    return;
  }
  const facts: RoundFact[] = rounds.map((r) => ({
    arm: r.arm as 'baseline' | 'candidate',
    round: r.round as number,
    exitCode: r.exitCode as number,
    hasRunnerSummary: r.hasRunnerSummary as boolean,
    infraSignal: r.infraSignal as boolean,
    ...(r.reportedPassing !== undefined ? { reportedPassing: r.reportedPassing as number } : {}),
    ...(r.reportedFailing !== undefined ? { reportedFailing: r.reportedFailing as number } : {}),
    ...(r.reportedPending !== undefined ? { reportedPending: r.reportedPending as number } : {}),
    ...(r.failingTestNames !== undefined ? { failingTestNames: r.failingTestNames as string[] } : {}),
    ...(r.crashSignal !== undefined ? { crashSignal: r.crashSignal === true } : {}),
    ...(r.sweepFailed !== undefined ? { sweepFailed: r.sweepFailed === true } : {}),
    // Re-derivation must see the SAME gate inputs classify() consumed at
    // capture; without this line every re-derived strong label would die at
    // rule 14 (missing observation ⇒ ABSENT) and the check would be noise.
    ...(r.executionObservation !== undefined && r.executionObservation !== null && typeof r.executionObservation === 'object'
      ? { executionObservation: r.executionObservation as ExecutionObservation }
      : {}),
  }));
  const derived = classify(facts);
  // A rule-9 (unconfined drift) or rule-10 (weak observation) downgrade to
  // INCONCLUSIVE is legitimate ONLY when its external justification is present
  // in the bundle; a fabricated INCONCLUSIVE rule 9/10 is rejected.
  const isConfinementOverride =
    label === 'INCONCLUSIVE' &&
    derived.classification !== 'INFRASTRUCTURE_FAILURE' &&
    (
      (cls.rule === 9 && treeValid && tc.driftConfinedToDependency === false) ||
      (cls.rule === 10 && !treeValid)
    );
  if (!isConfinementOverride && (derived.classification !== label || derived.rule !== cls.rule)) {
    issues.push(
      `classification contradicts its own round facts: bundle says ${String(cls.label)} rule ${String(cls.rule)}, ` +
      `re-derivation from these rounds yields ${derived.classification} rule ${derived.rule}`,
    );
  }
}

/** True iff the bundle is valid AND its classification is trustworthy to print. */
export function isTrustworthy(b: unknown): boolean {
  return validateBundle(b).length === 0;
}
