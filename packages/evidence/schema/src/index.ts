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

import { classify, type RoundFact } from '@canary-rn/classification';


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
   *  (audit B2: with failing+pending defines the executed-total). */
  reportedPassing?: number | undefined;
  /** Failing-test count as parsed from the runner summary, if machine-readable. */
  reportedFailing?: number | undefined;
  /** Pending/skipped count as parsed from the runner summary (audit B2). */
  reportedPending?: number | undefined;
  /** Sorted failing-test identities parsed from this round's log (audit F13). */
  failingTestNames?: string[] | undefined;
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
  };
  classification: {
    label: ClassificationLabel;
    rule: number;
    reason: string;
    reproductionCount: number;
  };
  /** Optional, non-authoritative, structurally unable to affect classification. */
  ai?: {
    provider: string;
    summary: string;
    attachedAt: string;
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

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

/** Structural validation of a bundle. Returns issues; empty array = valid. */
export function validateBundle(b: unknown): Issue[] {
  const issues: Issue[] = [];
  if (typeof b !== 'object' || b === null) return ['root is not an object'];
  const o = b as Record<string, unknown>;

  if (o.schemaVersion !== EVIDENCE_SCHEMA_VERSION) issues.push(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  for (const k of ['runId', 'createdAt', 'canaryVersion', 'experimentId']) {
    if (!isStr(o[k]) || (o[k] as string).length === 0) issues.push(`${k} missing/empty`);
  }

  const dep = o.dependency as Record<string, unknown> | undefined;
  if (!dep || !isStr(dep.package) || !isStr(dep.baselineVersion) || !isStr(dep.candidateVersion)) {
    issues.push('dependency{package,baselineVersion,candidateVersion} incomplete');
  }

  const ds = o.downstream as Record<string, unknown> | undefined;
  if (!ds || !isStr(ds.repositoryUrl)) issues.push('downstream.repositoryUrl missing');
  if (!ds || !SHA40.test(String(ds.commitSha ?? ''))) issues.push('downstream.commitSha must be a full 40-hex SHA');
  if (!ds || !HEX64.test(String(ds.tarballSha256 ?? ''))) issues.push('downstream.tarballSha256 invalid');

  const rounds = o.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    issues.push('rounds must be a non-empty array');
  } else {
    const kinds = new Set<string>();
    rounds.forEach((r: Record<string, unknown>, i) => {
      const at = `rounds[${i}]`;
      if (r.arm === 'baseline' || r.arm === 'candidate') kinds.add(r.arm);
      else issues.push(`${at}.arm invalid`);
      if (typeof r.exitCode !== 'number' || !Number.isInteger(r.exitCode) || r.exitCode < -1) {
        issues.push(`${at}.exitCode invalid`);
      }
      for (const h of ['rawStdoutSha256', 'rawStderrSha256', 'normalizedStdoutSha256', 'normalizedStderrSha256']) {
        if (!HEX64.test(String(r[h] ?? ''))) issues.push(`${at}.${h} invalid`);
      }
      if (!isStr(r.logPath)) issues.push(`${at}.logPath missing`);
      if (!Array.isArray(r.argv) || (r.argv as unknown[]).length === 0) issues.push(`${at}.argv empty`);
      if (!Array.isArray(r.envKeys)) issues.push(`${at}.envKeys missing`);
      else {
        for (const k of r.envKeys as unknown[]) {
          if (!SANITIZE_ALLOWLIST.has(String(k))) issues.push(`${at}.envKeys contains non-allowlisted var: ${String(k)}`);
        }
      }
    });
    if (!kinds.has('baseline')) issues.push('no baseline rounds');
    if (!kinds.has('candidate')) issues.push('no candidate rounds');
  }

  const cls = o.classification as Record<string, unknown> | undefined;
  if (!cls || !CLASSIFICATION_LABELS.includes(cls.label as ClassificationLabel)) {
    issues.push('classification.label must be one of the six deterministic labels');
  }
  if (!cls || typeof cls.rule !== 'number') issues.push('classification.rule missing');
  if (!cls || typeof cls.reproductionCount !== 'number' || (cls.reproductionCount as number) < 1) {
    issues.push('classification.reproductionCount must be >= 1');
  }

  const tc = o.treeComparison as Record<string, unknown> | undefined;
  if (!tc || !HEX64.test(String(tc.baselineTreeSha256 ?? '')) || !HEX64.test(String(tc.candidateTreeSha256 ?? ''))) {
    issues.push('treeComparison hashes invalid');
  }
  const rv = tc?.resolvedVersions as Record<string, unknown> | undefined;
  if (!rv || !isStr(rv.baseline) || !isStr(rv.candidate)) issues.push('treeComparison.resolvedVersions missing — arms were not attested');
  const dc = tc?.dependencyCopies as Record<string, unknown> | undefined;
  if (!dc || typeof dc.baseline !== 'number' || typeof dc.candidate !== 'number') issues.push('treeComparison.dependencyCopies missing');
  // Audit B6: the tree-observation status is mandatory and must be a known value.
  const TREE_STATUSES = new Set(['VALID', 'INCOMPLETE', 'INVALID']);
  const os = tc?.observationStatus as Record<string, unknown> | undefined;
  if (!os || !TREE_STATUSES.has(String(os.baseline)) || !TREE_STATUSES.has(String(os.candidate))) {
    issues.push('treeComparison.observationStatus missing/invalid — tree completeness was not recorded (audit B6)');
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

  // 4. Re-derive the classification from the round facts using the SAME
  //    decision table that produced it. This only runs when the bundle
  //    carries every input the classifier consumed (infraSignal present on
  //    all rounds — bundles predating audit F13 cannot be semantically
  //    verified and are flagged as such when claiming a trustful verdict).
  const fullFacts = rounds.every((r) => typeof r.hasRunnerSummary === 'boolean' && typeof r.infraSignal === 'boolean');
  if (!fullFacts) {
    if (label === 'CONFIRMED_REGRESSION' || label === 'PRE_EXISTING_FAILURE') {
      issues.push('trustful verdict in a bundle without per-round infraSignal — classification cannot be independently re-derived');
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
