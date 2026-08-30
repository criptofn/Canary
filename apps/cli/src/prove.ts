/**
 * `canary prove` — re-runs (or checks) an experiment and asserts it matches
 * the committed expectation file exactly. This is the regression proof of
 * Canary's golden fixture; the CI gate.
 */

import fs from 'node:fs';
import path from 'node:path';

import { extractFailingTestNames, parseSummaryCounts } from '@canary-rn/comparator';
import { sha256File } from '@canary-rn/hashing';
import { validateBundle, type EvidenceBundle } from '@canary-rn/evidence-schema';

export interface SummaryExpectation { passing: number; failing?: number | undefined }

export interface ProofExpectation {
  schema: number;
  experimentId: string;
  dependency?: { package: string; baseline: string; candidate: string };
  downstream?: { repo: string; commit: string };
  expected: {
    classification: string;
    rule: number;
    driftConfinedToDependency: boolean;
    baseline: { rounds: number; exitCodes: number[]; normalizedStdoutSha256AcrossRounds: string[]; summary: SummaryExpectation };
    candidate: { rounds: number; exitCodes: number[]; normalizedStdoutSha256AcrossRounds: string[]; summary: SummaryExpectation };
    failingTestNames: string[];
  };
}

export interface AssertionResult {
  name: string;
  ok: boolean;
  actual?: unknown;
  expected?: unknown;
}

export function assertProof(
  ev: EvidenceBundle,
  proof: ProofExpectation,
  logs: { candidateStdout: string; baselineStdout: string },
): AssertionResult[] {
  const checks: AssertionResult[] = [];
  const eq = (name: string, actual: unknown, expected: unknown): void => {
    checks.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  };
  const e = proof.expected;

  eq('classification', ev.classification.label, e.classification);
  eq('rule', ev.classification.rule, e.rule);
  eq('drift-confined-to-dependency', ev.treeComparison.driftConfinedToDependency, true);
  eq('resolved versions attested',
    `${ev.treeComparison.resolvedVersions.baseline}->${ev.treeComparison.resolvedVersions.candidate}`,
    `${proof.dependency?.baseline ?? '?'}->${proof.dependency?.candidate ?? '?'}`);
  if (proof.dependency) {
    eq('dependency pinned',
      `${ev.dependency.package}@${ev.dependency.baselineVersion}->${ev.dependency.candidateVersion}`,
      `${proof.dependency.package}@${proof.dependency.baseline}->${proof.dependency.candidate}`);
  }
  if (proof.downstream) {
    eq('commit pinned', ev.downstream.commitSha, proof.downstream.commit);
  }

  const base = ev.rounds.filter((x) => x.arm === 'baseline');
  const cand = ev.rounds.filter((x) => x.arm === 'candidate');
  eq('baseline exit codes', base.map((x) => x.exitCode), e.baseline.exitCodes);
  eq('candidate exit codes', cand.map((x) => x.exitCode), e.candidate.exitCodes);
  eq('baseline normalized stdout hashes',
    base.map((x) => x.normalizedStdoutSha256.slice(0, 16)),
    e.baseline.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  eq('candidate normalized stdout hashes',
    cand.map((x) => x.normalizedStdoutSha256.slice(0, 16)),
    e.candidate.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  eq('baseline arm internally deterministic', new Set(base.map((x) => x.normalizedStdoutSha256)).size, 1);
  eq('candidate arm internally deterministic', new Set(cand.map((x) => x.normalizedStdoutSha256)).size, 1);

  // F7: numeric summary expectations, not substring vibes.
  eq('candidate summary counts', parseSummaryCounts(logs.candidateStdout), e.candidate.summary);
  eq('baseline summary counts', parseSummaryCounts(logs.baselineStdout), e.baseline.summary);

  // F7: set membership on ACTUAL failing-test extraction, not raw substrings
  // (mocha prints test titles on passing lines too).
  const failing = new Set(extractFailingTestNames(logs.candidateStdout));
  for (const t of e.failingTestNames) {
    checks.push({ name: `failing test (extracted): "${t}"`, ok: failing.has(t), actual: [...failing] });
  }
  return checks;
}

/** Read + VALIDATE the last run's evidence for this experiment (F7). */
export function readLatestEvidence(repoRoot: string, experimentId: string): { bundle: EvidenceBundle; artifactsDir: string; issues: string[] } {
  const pointerPath = path.join(repoRoot, '.canary-runs', `latest-${experimentId}.json`);
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as { evidence: string };
  const bundle = JSON.parse(fs.readFileSync(pointer.evidence, 'utf8')) as EvidenceBundle;
  const issues = validateBundle(bundle);
  return { bundle, artifactsDir: path.dirname(pointer.evidence), issues };
}

/**
 * Audit F4: prove/check must verify the bundle against the REAL artifacts on
 * disk. Without this, every recorded hash could as easily describe files that
 * never existed — tampered (or deleted) logs sail through because the old
 * assertions only compared bundle fields to each other. For each round we
 * re-hash the four artifact files (raw stdout/stderr + normalized
 * stdout/stderr, per the Recorder's filename convention) and require exact
 * equality with the recorded digests. Returns issues; empty = untampered.
 */
export function verifyArtifacts(artifactsDir: string, bundle: EvidenceBundle): string[] {
  const issues: string[] = [];
  for (const r of bundle.rounds) {
    if (!r.logPath.endsWith('.stdout.log')) {
      issues.push(`round ${r.arm}#${r.round}: unexpected logPath ${r.logPath} (cannot derive artifact names)`);
      continue;
    }
    const label = r.logPath.slice(0, -'.stdout.log'.length);
    const want: Array<[string, string]> = [
      [`${label}.stdout.log`, r.rawStdoutSha256],
      [`${label}.stderr.log`, r.rawStderrSha256],
      [`${label}.stdout.norm`, r.normalizedStdoutSha256],
      [`${label}.stderr.norm`, r.normalizedStderrSha256],
    ];
    for (const [file, hash] of want) {
      const p = path.join(artifactsDir, file);
      if (!fs.existsSync(p)) {
        issues.push(`round ${r.arm}#${r.round}: artifact missing: ${file}`);
        continue;
      }
      let actual: string;
      try {
        actual = sha256File(p);
      } catch (e) {
        issues.push(`round ${r.arm}#${r.round}: cannot hash ${file}: ${e}`);
        continue;
      }
      if (actual !== hash) {
        issues.push(`round ${r.arm}#${r.round}: TAMPERED artifact ${file}: recorded ${hash.slice(0, 16)}…, on disk ${actual.slice(0, 16)}…`);
      }
    }
  }
  return issues;
}
