/**
 * `canary prove` — re-runs (or checks) an experiment and asserts it matches
 * the committed expectation file exactly. This is the regression proof of
 * Canary's golden fixture; the CI gate.
 */

import fs from 'node:fs';
import path from 'node:path';

import { extractFailingTestNames, parseSummaryCounts } from '@canary-rn/comparator';
import { hasRunnerSummary } from '@canary-rn/executor';
import { sha256File } from '@canary-rn/hashing';
import { validateBundle, type EvidenceBundle } from '@canary-rn/evidence-schema';

export interface SummaryExpectation { passing: number; failing?: number | undefined }

/**
 * Audit F11: structured identity of the host that captured the hash-exact
 * expectations. Normalized stream hashes are machine-local (path separators
 * and runner formatting survive normalization), so they are the ONLY
 * assertions that cannot be evaluated cross-host. Everything else —
 * classification, rule, drift confinement, version attestation, pinning,
 * exit codes, WITHIN-ARM determinism, summaries, failing-test identities —
 * is portable and MUST be asserted on every host, including CI.
 */
export interface HostFingerprint {
  platform: string;
  arch: string;
  nodeVersion: string;
  npmVersion: string;
}

export interface ProofExpectation {
  schema: number;
  experimentId: string;
  /** Expected evidence schema (defaults to 1). Binds the bundle's declared
   *  schemaVersion so a rewritten version is caught (audit B4/S2). */
  evidenceSchema?: number | undefined;
  /** Optional: pin the fetched-content digest so a rewritten tarballSha256 in
   *  the evidence fails check (audit B4). */
  tarballSha256?: string | undefined;
  dependency?: { package: string; baseline: string; candidate: string };
  downstream?: { repo: string; commit: string };
  /** Optional runtime pin (audit B4): platform/arch are asserted on every
   *  host; nodeVersion/npmVersion only on the proof host. */
  environment?: {
    platform: string; arch: string;
    nodeVersion?: string | undefined; npmVersion?: string | undefined;
  } | undefined;
  /** When present, hash-exact assertions run only if the evidence's recorded
   *  environment matches field-for-field; elsewhere they are reported SKIPPED
   *  (honestly — not silently dropped, not silently failed). */
  proofHost?: HostFingerprint | undefined;
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
  /** True when a host-exact assertion was not evaluated on this host (F11). */
  skipped?: boolean | undefined;
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
  // Audit B4/S2: bind the bundle's identity to the (committed, trusted) proof.
  // Without these, experimentId / run identity / schema / repo / tarball could
  // be rewritten in the evidence and check would still "pass".
  eq('experiment identity', ev.experimentId, proof.experimentId);
  eq('evidence schema', ev.schemaVersion, proof.evidenceSchema ?? 1);
  eq('fetch method', ev.downstream.fetchMethod, 'tarball-by-sha');
  if (proof.downstream?.repo) {
    eq('repository pinned', ev.downstream.repositoryUrl, `https://github.com/${proof.downstream.repo}`);
  }
  if (proof.downstream) {
    eq('commit pinned', ev.downstream.commitSha, proof.downstream.commit);
  }
  // Audit B4: a release-critical fact the check path must not silently trust.
  eq('tree observation VALID', [ev.treeComparison.observationStatus?.baseline, ev.treeComparison.observationStatus?.candidate], ['VALID', 'VALID']);
  eq('drift-confined-to-dependency', ev.treeComparison.driftConfinedToDependency, true);
  eq('resolved versions attested',
    `${ev.treeComparison.resolvedVersions.baseline}->${ev.treeComparison.resolvedVersions.candidate}`,
    `${proof.dependency?.baseline ?? '?'}->${proof.dependency?.candidate ?? '?'}`);
  if (proof.dependency) {
    eq('dependency pinned',
      `${ev.dependency.package}@${ev.dependency.baselineVersion}->${ev.dependency.candidateVersion}`,
      `${proof.dependency.package}@${proof.dependency.baseline}->${proof.dependency.candidate}`);
  }
  if (proof.tarballSha256 !== undefined) {
    eq('tarball digest pinned', ev.downstream.tarballSha256, proof.tarballSha256);
  }

  const base = ev.rounds.filter((x) => x.arm === 'baseline');
  const cand = ev.rounds.filter((x) => x.arm === 'candidate');
  eq('baseline exit codes', base.map((x) => x.exitCode), e.baseline.exitCodes);
  eq('candidate exit codes', cand.map((x) => x.exitCode), e.candidate.exitCodes);

  // Audit F11: the ONLY host-local assertions. Normalized-stream hashes embed
  // machine-specific formatting, so they are exact only on the proof host.
  // A structured fingerprint comparison (NOT substring/prose matching) decides
  // whether to assert them or to report them SKIPPED (honest, never silent).
  const hf = proof.proofHost;
  const onProofHost = !hf || (
    ev.environment.platform === hf.platform &&
    ev.environment.arch === hf.arch &&
    ev.environment.nodeVersion === hf.nodeVersion &&
    ev.environment.npmVersion === hf.npmVersion);
  const hostExact = (
    name: string, actual: unknown, expected: unknown,
  ): void => {
    if (onProofHost) eq(name, actual, expected);
    else checks.push({ name: `${name} [SKIPPED: not proof host ${hf!.platform}/${hf!.arch}/node ${hf!.nodeVersion}]`, ok: true, skipped: true, expected, actual });
  };
  hostExact('baseline normalized stdout hashes',
    base.map((x) => x.normalizedStdoutSha256.slice(0, 16)),
    e.baseline.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  hostExact('candidate normalized stdout hashes',
    cand.map((x) => x.normalizedStdoutSha256.slice(0, 16)),
    e.candidate.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  // Within-arm determinism is host-INDEPENDENT (compares rounds to each other
  // in one run) and stays unconditional on every host.
  eq('baseline arm internally deterministic', new Set(base.map((x) => x.normalizedStdoutSha256)).size, 1);
  eq('candidate arm internally deterministic', new Set(cand.map((x) => x.normalizedStdoutSha256)).size, 1);

  // F7: numeric summary expectations, not substring vibes.
  eq('candidate summary counts', parseSummaryCounts(logs.candidateStdout), e.candidate.summary);
  eq('baseline summary counts', parseSummaryCounts(logs.baselineStdout), e.baseline.summary);

  // Audit B4: pin the RUNTIME METADATA so rewriting environment.{platform,
  // arch} (portable) can't slip through; node/npm exactness is host-gated
  // alongside the hashes (they legitimately differ across runners).
  if (proof.environment) {
    eq('environment platform/arch match proof',
      [ev.environment.platform, ev.environment.arch],
      [proof.environment.platform, proof.environment.arch]);
    if (proof.environment.nodeVersion !== undefined || proof.environment.npmVersion !== undefined) {
      hostExact('runtime node/npm match proof',
        [ev.environment.nodeVersion, ev.environment.npmVersion],
        [proof.environment.nodeVersion ?? ev.environment.nodeVersion, proof.environment.npmVersion ?? ev.environment.npmVersion]);
    }
  }

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
 * Audit F12: `canary report` / `npm run report` with no argument resolves
 * the MOST RECENT pointer across all experiments (by file mtime), so the
 * documented one-word command actually works after any run.
 */
export function findLatestEvidencePath(repoRoot: string): { experimentId: string; evidencePath: string } | undefined {
  const dir = path.join(repoRoot, '.canary-runs');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith('latest-') && n.endsWith('.json'));
  } catch {
    return undefined;
  }
  const dated = names
    .map((n) => {
      try {
        return { n, mtime: fs.statSync(path.join(dir, n)).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is { n: string; mtime: number } => x !== undefined)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { n } of dated) {
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { evidence?: string };
      if (typeof pointer.evidence === 'string' && fs.existsSync(pointer.evidence)) {
        return { experimentId: n.slice('latest-'.length, -'.json'.length), evidencePath: pointer.evidence };
      }
    } catch { /* stale/unreadable pointer — try the next-newest */ }
  }
  return undefined;
}

/**
 * Audit F4: prove/check must verify the bundle against the REAL artifacts on
 * disk. Without this, every recorded hash could as easily describe files that
 * never existed — tampered (or deleted) logs sail through because the old
 * assertions only compared bundle fields to each other. For each round we
 * re-hash the four artifact files (raw stdout/stderr + normalized
 * stdout/stderr, per the Recorder's filename convention) and require exact
 * equality with the recorded digests. Returns issues; empty = untampered.
 *
 * Audit B3 (this hardening): filenames are now DERIVED from each round's
 * structured arm/round (never parsed from the attacker-supplied logPath), the
 * round's logPath MUST equal the canonical `${arm}-${round}.stdout.log`
 * (ownership binding — kills `../` traversal, absolute paths, separator
 * variants AND cross-round/cross-type swaps), and every file is additionally
 * realpath-confined to the artifacts directory (symlink escape guard). A bare
 * derived basename cannot carry a separator, so containment is structural; the
 * lexical + realpath checks are defense-in-depth against a manipulated root or
 * a planted symlink.
 */
export function verifyArtifacts(artifactsDir: string, bundle: EvidenceBundle): string[] {
  const issues: string[] = [];
  const rootAbs = path.resolve(artifactsDir);
  let rootReal = rootAbs;
  try { rootReal = fs.realpathSync(rootAbs); } catch { /* root missing → surfaced per-file */ }

  for (const r of bundle.rounds) {
    const at = `round ${String(r.arm)}#${String(r.round)}`;
    if (r.arm !== 'baseline' && r.arm !== 'candidate') {
      issues.push(`${at}: invalid arm (cannot derive artifact names)`);
      continue;
    }
    if (!Number.isInteger(r.round) || r.round < 1) {
      issues.push(`${at}: invalid round index`);
      continue;
    }
    const label = `${r.arm}-${r.round}`;
    const expectedLogPath = `${label}.stdout.log`;
    if (r.logPath !== expectedLogPath) {
      issues.push(`${at}: logPath '${String(r.logPath)}' does not match its own identity (expected '${expectedLogPath}') — traversal/absolute path/cross-round ownership mismatch`);
      continue; // never read the claimed path; the canonical name is authoritative
    }
    const want: Array<[string, string]> = [
      [`${label}.stdout.log`, r.rawStdoutSha256],
      [`${label}.stderr.log`, r.rawStderrSha256],
      [`${label}.stdout.norm`, r.normalizedStdoutSha256],
      [`${label}.stderr.norm`, r.normalizedStderrSha256],
    ];
    for (const [file, hash] of want) {
      const p = path.join(rootAbs, file); // file is a bare derived basename (no separators)
      const lex = withinDir(rootAbs, p);
      if (!lex.ok) { issues.push(`${at}: artifact ${file} escapes the artifacts directory (${lex.why})`); continue; }
      let real = p;
      try { real = fs.realpathSync(p); } catch { /* dangling symlink; lexical already ok */ }
      const re = withinDir(rootReal, real);
      if (!re.ok) { issues.push(`${at}: artifact ${file} resolves outside the artifacts directory (${re.why})`); continue; }
      if (!fs.existsSync(p)) {
        issues.push(`${at}: artifact missing: ${file}`);
        continue;
      }
      let actual: string;
      try {
        actual = sha256File(p);
      } catch (e) {
        issues.push(`${at}: cannot hash ${file}: ${String(e)}`);
        continue;
      }
      if (actual !== hash) {
        issues.push(`${at}: TAMPERED artifact ${file}: recorded ${hash.slice(0, 16)}…, on disk ${actual.slice(0, 16)}…`);
      }
    }
  }
  return issues;
}

/** Lexical containment of `abs` within `root`; reports why it fails. */
function withinDir(root: string, abs: string): { ok: boolean; why: string } {
  const rel = path.relative(root, abs);
  if (rel === '') return { ok: true, why: '' };
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, why: `'${abs}' is not inside '${root}'` };
  }
  return { ok: true, why: '' };
}

/**
 * Audit B4 (layer a): bind the ROUND FACTS that drive classification to the
 * actual artifact BYTES. verifyArtifacts (B3/F4) proves the bytes match their
 * recorded digests; this proves the digests' bytes actually *say* what the
 * bundle claims they say — the same summary parse (`stdout ++ stderr`, exactly
 * as the recorder assembled `combined`) re-run through the same matchers the
 * executor used must reproduce the recorded hasRunnerSummary / counts /
 * failing-test identities. A bundle whose reportedFailing=3 is really a "0
 * passing" log, or whose failingTestNames don't appear in the bytes, is now
 * rejected here rather than being re-derivable only from its own self-
 * consistent (but unverified) facts.
 *
 * Returns issues; empty = every round's recorded facts are reproduced from
 * disk. Reads only canonical `${arm}-${round}.stdout.log`/`.stderr.log`.
 */
export function verifyArtifactSemantics(artifactsDir: string, bundle: EvidenceBundle): string[] {
  const issues: string[] = [];
  const rootAbs = path.resolve(artifactsDir);
  const read = (name: string): string | null => {
    const p = path.join(rootAbs, name);
    const lex = withinDir(rootAbs, p);
    if (!lex.ok) return null;
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  };
  for (const r of bundle.rounds) {
    const at = `round ${r.arm}#${r.round}`;
    const label = `${r.arm}-${r.round}`;
    const so = read(`${label}.stdout.log`);
    const se = read(`${label}.stderr.log`);
    if (so === null || se === null) {
      issues.push(`${at}: cannot read raw stdout/stderr for semantic re-derivation`);
      continue;
    }
    const combined = so + se;
    const counts = parseSummaryCounts(combined);
    const summary = hasRunnerSummary(combined);
    const names = extractFailingTestNames(combined).sort();
    if (r.hasRunnerSummary !== summary) {
      issues.push(`${at}: hasRunnerSummary=${String(r.hasRunnerSummary)} but the artifact bytes ${summary ? 'DO' : 'DO NOT'} match a runner summary`);
    }
    for (const [field, rec, obs] of [
      ['reportedPassing', r.reportedPassing, counts.passing],
      ['reportedFailing', r.reportedFailing, counts.failing],
      ['reportedPending', r.reportedPending, counts.pending],
    ] as const) {
      if ((rec ?? undefined) !== (obs ?? undefined)) {
        issues.push(`${at}: ${field}=${String(rec)} but the artifact bytes report ${String(obs)}`);
      }
    }
    const recNames = [...(r.failingTestNames ?? [])].sort();
    if (JSON.stringify(recNames) !== JSON.stringify(names)) {
      issues.push(`${at}: failingTestNames ${JSON.stringify(recNames)} disagree with the ${JSON.stringify(names)} extracted from the artifact bytes`);
    }
  }
  return issues;
}
