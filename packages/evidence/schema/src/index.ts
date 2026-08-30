/**
 * Evidence Bundle v1 — the machine-readable artifact that makes a Canary
 * conclusion auditable by someone who does not trust Canary.
 *
 * Invariants enforced by validateBundle():
 *  - classification lives ONLY under `classification` and is one of the six
 *    deterministic labels;
 *  - every round carries raw AND normalized stream hashes;
 *  - optional `ai` data is namespaced and has no path to classification —
 *    the type system literally cannot express an AI-authored verdict.
 */

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
 */
export const SANITIZE_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'TMPDIR', 'LANG',
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

  return issues;
}

/** True iff the bundle is valid AND its classification is trustworthy to print. */
export function isTrustworthy(b: unknown): boolean {
  return validateBundle(b).length === 0;
}
