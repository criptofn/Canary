/**
 * `canary prove` — re-runs (or checks) an experiment and asserts it matches
 * the committed expectation file exactly. This is the regression proof of
 * Canary's golden fixture; the CI gate.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { diffTrees, extractFailingTestNamesFor, hasRunnerSummaryFor, parseSummaryCountsFor } from '@canary-rn/comparator';
import { observerNonce } from '@canary-rn/executor';
import {
  hasRunnerSummary, isInfraOutput, hasCrashSignature, Recorder,
  validateObservation, OBSERVER_PRELOAD_SOURCE, observerPreloadPath, type ExpansionPlan,
} from '@canary-rn/executor';
import { sha256File } from '@canary-rn/hashing';
import { validateBundle, type EvidenceBundle } from '@canary-rn/evidence-schema';
import { classify, applyConfinementGuard, type ExecutionObservation, type RoundFact } from '@canary-rn/classification';
import { sanitizedEnv, sanitizedEnvKeys, resolveNpmCli, KNOWN_RUNNER_RELEASES, canonicalPath, type WorkspaceLayout } from '@canary-rn/support';
import { deriveArmTreeFacts } from './verify-tree.js';

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
  /** post-GLM F2: SHA-256 of the ACTUAL node executable bytes
   *  (`sha256File(process.execPath)`). The four metadata fields above are
   *  self-reported strings that a repackaged or patched runtime can claim
   *  while `process.version` lies — `--set-node-options`-style trojans,
   *  swapped binaries under a real version string. Host-exactness is only
   *  meaningful when the verifier proves WHICH bytes executed: the digest
   *  turns "claims to be v26.3.0" into "IS the pinned v26.3.0 binary".
   *  REQUIRED: a committed proofHost without it is refused (see assertProof). */
  nodeExecSha256: string;
}

/** The self-reported metadata half — everything the evidence environment
 *  block can ever carry (post-GLM F2: evidence has NO exec digest). */
type HostMeta = Pick<HostFingerprint, 'platform' | 'arch' | 'nodeVersion' | 'npmVersion'>;

export interface ProofExpectation {
  schema: number;
  experimentId: string;
  /** Expected evidence schema (defaults to 1). Binds the bundle's declared
   *  schemaVersion so a rewritten version is caught (audit B4/S2). */
  evidenceSchema?: number | undefined;
  /** EXTERNALLY PINNED fetched-content digest (round-3 blocker 4). A proof
   *  without it is refused by assertProof ('proof pins tarball digest'):
   *  the tarball digest is release-critical, so the committed expectation —
   *  not the evidence — must anchor it. Independently, verifyRunIdentity
   *  re-hashes the retained `fixture.tgz` on disk, binding the evidence value
   *  to bytes as well. */
  tarballSha256?: string | undefined;
  dependency?: { package: string; baseline: string; candidate: string };
  downstream?: { repo: string; commit: string };
  /**
   * The observation channel the SUMMARY EXPECTATIONS below are written in
   * (v1.1 Phase 2). Absent ⇒ mocha, which is what every existing proof means, so
   * nothing already committed changes meaning.
   *
   * WHY THIS MUST BE A COMMITTED FIELD and not read from the evidence: the counts
   * in `expected.*.summary` are a human expectation, and comparing them requires
   * agreeing on the text grammar they were read from. Taking that grammar from the
   * (resealable) bundle would let a bundle choose which parser judges it. Here the
   * PROOF declares the channel, the check uses it, and a bundle that says otherwise
   * cannot change the comparison.
   */
  runner?: string | undefined;
  /** Optional runtime pin (audit B4): platform/arch are asserted on every
   *  host; nodeVersion/npmVersion only on the proof host. */
  environment?: {
    platform: string; arch: string;
    nodeVersion?: string | undefined; npmVersion?: string | undefined;
  } | undefined;
  /** Round-3 blocker 3: the COMMITTED, trusted identity of the machine whose
   *  exact normalized hashes are meaningful. Host-exact assertions run only
   *  when the ACTUAL runtime performing the verification matches this
   *  fingerprint field-for-field — the evidence's own (mutable) environment
   *  block can never opt into or out of these checks. Elsewhere they are
   *  reported SKIPPED and the CLI verdict downgrades to INCOMPLETE (exit 2):
   *  unverifiable host-exactness is never dressed up as PASS. */
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

/**
 * Round-3 blocker 3: sample the ACTUAL runtime performing the verification.
 * platform/arch/nodeVersion come from this very process; npmVersion from a
 * spawned `npm --version` resolved the same way the pipeline resolves it
 * (node_modules/npm under the running node's prefix) — never from evidence.
 * Throws if npm cannot be sampled; callers must treat that as unverifiable
 * (INCOMPLETE), never as a pass.
 *
 * Post-sol secondary: the sampler spawns under the SAME sanitized child
 * environment every other Canary process gets (allowlist, no inherited
 * NODE_OPTIONS / npm_config_*). Before this, it inherited the verifier's
 * full process environment: a poisoned NODE_OPTIONS (or any npm-steering
 * var) in the verifying shell could spoof or crash the very measurement
 * that decides host-exactness — the fingerprint must describe the RUNTIME,
 * not the shell that invoked us.
 *
 * Post-GLM F2: also hashes THIS process's executable bytes
 * (sha256File(process.execPath)) — the metadata fields above are claims the
 * runtime makes about itself; the digest is the only field that is not.
 */
export function actualHostFingerprint(): HostFingerprint {
  const nodeDir = path.dirname(process.execPath);
  // R2 host-neutrality: probe both bundled-npm layouts (Windows exe-dir and
  // POSIX prefix lib/); never PATH. Absent on both → throw (callers treat an
  // unsamplable host as INCOMPLETE, never as a pass) — no empty sample rides
  // a bundle pretending to be a measurement.
  const npmCli = resolveNpmCli();
  if (!npmCli) {
    throw new Error(`cannot sample npm: no bundled npm-cli.js under ${nodeDir}/node_modules/npm or ${path.join(nodeDir, '..', 'lib', 'node_modules', 'npm')}`);
  }
  const npmVersion = execFileSync(process.execPath, [npmCli, '--version'], {
    encoding: 'utf8', shell: false, timeout: 60_000, windowsHide: true,
    env: sanitizedEnv({ ws: { root: os.tmpdir(), fixture: process.cwd() }, nodeDir }),
  }).trim();
  if (!npmVersion) throw new Error('npm --version produced empty output');
  return {
    platform: process.platform, arch: process.arch,
    nodeVersion: process.version, npmVersion,
    nodeExecSha256: sha256File(process.execPath),
  };
}

/** Metadata-only equality — for comparisons where one side CANNOT carry a
 *  digest (the evidence's environment block). Not host-exactness. */
const metaEq = (a: HostMeta, b: HostMeta): boolean =>
  a.platform === b.platform && a.arch === b.arch &&
  a.nodeVersion === b.nodeVersion && a.npmVersion === b.npmVersion;

/** Host-exactness (post-GLM F2): metadata AND the executable bytes. */
const fpEq = (a: HostFingerprint, b: HostFingerprint): boolean =>
  metaEq(a, b) && a.nodeExecSha256 === b.nodeExecSha256;

/**
 * Round-3 blocker 3: bind the EVIDENCE's claimed environment to reality.
 * A bundle recorded on machine X can only be digest-verified on machine X;
 * when the two disagree, every host-bound claim (normalized hashes above all)
 * is unverifiable HERE — surfaced as an explicit note (report: NOT SELF-CONSISTENT)
 * instead of a silent self-consistency banner.
 */
export function environmentAttestationIssues(bundle: EvidenceBundle, runtime: HostMeta): string[] {
  const e = bundle.environment;
  const claimed: HostMeta = {
    platform: e.platform, arch: e.arch, nodeVersion: e.nodeVersion, npmVersion: e.npmVersion,
  };
  if (metaEq(claimed, runtime)) return [];
  return [`environment attestation: evidence claims ${claimed.platform}/${claimed.arch}/node ${claimed.nodeVersion}/npm ${claimed.npmVersion}, ` +
    `but the ACTUAL verifying runtime is ${runtime.platform}/${runtime.arch}/node ${runtime.nodeVersion}/npm ${runtime.npmVersion} — ` +
    `host-bound digests cannot be verified from this machine (round-3 B3)`];
}

/**
 * Round-3 blocker 3: the CLI verdict from assertion results. A PASS claim
 * requires ZERO failures AND zero skipped host-exact assertions — evidence
 * whose host-exactness could not be checked downgrades to INCOMPLETE (exit 2)
 * rather than passing on a shrug.
 */
export function proofVerdict(checks: AssertionResult[]): {
  failed: AssertionResult[]; skipped: AssertionResult[];
  status: 'PASS' | 'FAIL' | 'INCOMPLETE'; exitCode: number;
} {
  const failed = checks.filter((c) => !c.ok);
  const skipped = checks.filter((c) => c.skipped);
  if (failed.length > 0) return { failed, skipped, status: 'FAIL', exitCode: 1 };
  if (skipped.length > 0) return { failed, skipped, status: 'INCOMPLETE', exitCode: 2 };
  return { failed, skipped, status: 'PASS', exitCode: 0 };
}

/**
 * Round-3 blocker 3/4: decide host-exactness ONCE, from the ACTUAL runtime
 * only (never from evidence metadata), and produce the uniform skip reason.
 * Shared by assertProof and the host-bound evidence checks so both agree on
 * when a claim is verifiable here.
 */
export function proofHostContext(
  ev: EvidenceBundle, proof: ProofExpectation, runtime: HostFingerprint,
): { onProofHost: boolean; skipWhy: string } {
  const hf = proof.proofHost;
  // Host-exactness is granted ONLY by the committed proofHost, compared as
  // full fingerprints (metadata + exec bytes, post-GLM F2). The former
  // no-proofHost fallback derived trust from metaEq against the evidence's
  // own environment block — re-sealable attacker metadata, so an attacker
  // who matched it to their runtime minted host-exact trust and the proof
  // PASSed purely through the fallback (post-glm F6f). Absence of a
  // proofHost now NEVER grants: every host-exact assertion skips and
  // proofVerdict downgrades skips to INCOMPLETE — the fallback can no
  // longer produce a PASS.
  const onProofHost = hf !== undefined && fpEq(runtime, hf);
  const skipWhy = hf
    ? `actual runtime is not the committed proof host ${hf.platform}/${hf.arch}/node ${hf.nodeVersion}/npm ${hf.npmVersion} ` +
      `exec ${hf.nodeExecSha256 !== undefined ? hf.nodeExecSha256.slice(0, 16) + '…' : 'digest NOT PINNED'}`
    : 'no committed proofHost — host-exact assertions are never granted from re-sealable evidence metadata (post-glm F6f)';
  return { onProofHost, skipWhy };
}

/**
 * Round-3 blocker 3: `runtime` is the ACTUAL host performing the assertion
 * (see actualHostFingerprint). It is a REQUIRED parameter: host-exactness can
 * no longer be decided from the evidence's own mutable metadata.
 */
export function assertProof(
  ev: EvidenceBundle,
  proof: ProofExpectation,
  logs: { candidateStdout: string; baselineStdout: string },
  runtime: HostFingerprint,
): AssertionResult[] {
  const checks: AssertionResult[] = [];
  const eq = (name: string, actual: unknown, expected: unknown): void => {
    checks.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  };
  const e = proof.expected;

  // Self-review N9 (proof-version confusion): the expectation file declares a
  // schema version NO ONE used to read. A proof authored for a future (or
  // past) layout — moved fields, different hash truncation, new gates —
  // would be consumed under v1 semantics, silently comparing the wrong things
  // (or undefined against undefined). The proof is the trusted anchor; it
  // must ANCHOR at a version the reader actually implements.
  eq('proof schema', proof.schema, 1);
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
  // Round-3 blocker 4: the tarball digest is RELEASE-CRITICAL — a proof that
  // does not pin it cannot support a PASS claim (the golden proof omitted the
  // pin, so a coherently resealed tarballSha256 survived check unnoticed).
  eq('proof pins tarball digest', proof.tarballSha256 !== undefined, true);
  // post-GLM F2, same logic: a proof that NAMES a proof host must pin that
  // host's executable bytes. Metadata-only pinning is spoofable (a trojan
  // runtime can print any version), so an unpinning proofHost is refused —
  // loud FAIL, never a silently weaker host-exactness gate.
  if (proof.proofHost) {
    eq('proof pins proof-host exec digest', proof.proofHost.nodeExecSha256 !== undefined, true);
  }
  if (proof.tarballSha256 !== undefined) {
    eq('tarball digest pinned', ev.downstream.tarballSha256, proof.tarballSha256);
  }

  const base = ev.rounds.filter((x) => x.arm === 'baseline');
  const cand = ev.rounds.filter((x) => x.arm === 'candidate');
  eq('baseline exit codes', base.map((x) => x.exitCode), e.baseline.exitCodes);
  eq('candidate exit codes', cand.map((x) => x.exitCode), e.candidate.exitCodes);

  // Audit F11 + Round-3 blocker 3: the ONLY host-local assertions.
  // Normalized-stream hashes embed machine-specific formatting, so they are
  // exact only on the proof host. Round 3 showed the gate must NOT read the
  // evidence's mutable environment block (reseal it and every strict check
  // politely skips to a PASS). The ACTUAL runtime now decides (see
  // proofHostContext): committed proofHost wins when present, else the
  // evidence's recorded environment is the best available anchor.
  const { onProofHost, skipWhy } = proofHostContext(ev, proof, runtime);
  const hf = proof.proofHost;
  const hostExact = (
    name: string, actual: unknown, expected: unknown,
  ): void => {
    if (onProofHost) eq(name, actual, expected);
    else checks.push({ name: `${name} [SKIPPED: ${skipWhy}]`, ok: true, skipped: true, expected, actual });
  };
  hostExact('baseline normalized stdout hashes',
    base.map((x) => x.normalizedStdoutSha256.slice(0, 16)),
    e.baseline.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  hostExact('candidate normalized stdout hashes',
    cand.map((x) => x.normalizedStdoutSha256.slice(0, 16)),
    e.candidate.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  if (hf) {
    // The binding that makes resealing USELESS: on the proof host, the
    // evidence's environment block is no longer an identity claim to trust —
    // it is a fact to check against the committed expectation. Off host it
    // skips (and the verdict downgrades to INCOMPLETE), so metadata can
    // neither opt out of strict checks nor fake its way into them.
    hostExact('evidence environment bound to proof host',
      [ev.environment.platform, ev.environment.arch, ev.environment.nodeVersion, ev.environment.npmVersion],
      [hf.platform, hf.arch, hf.nodeVersion, hf.npmVersion]);
  }
  // Within-arm determinism is host-INDEPENDENT (compares rounds to each other
  // in one run) and stays unconditional on every host.
  eq('baseline arm internally deterministic', new Set(base.map((x) => x.normalizedStdoutSha256)).size, 1);
  eq('candidate arm internally deterministic', new Set(cand.map((x) => x.normalizedStdoutSha256)).size, 1);

  // F7: numeric summary expectations, not substring vibes. The channel the
  // expectations are written in comes from the COMMITTED proof (absent ⇒ mocha),
  // never from the bundle being judged.
  eq('candidate summary counts', parseSummaryCountsFor(proof.runner, logs.candidateStdout), e.candidate.summary);
  eq('baseline summary counts', parseSummaryCountsFor(proof.runner, logs.baselineStdout), e.baseline.summary);

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

  // F7 + Round-3 blocker 4-D: EXACT-SET equality on failing-test identities
  // extracted from the candidate bytes — not membership. Membership let a
  // resealed proof pin a SUBSET of the real failures (or the evidence hide an
  // extra one) while every pinned name was still present. No extra failure
  // identities, no missing ones; extraction (not raw substrings, mocha prints
  // test titles on passing lines too) is the source for the actual set.
  const failing = [...new Set(extractFailingTestNamesFor(proof.runner, logs.candidateStdout))].sort();
  eq('failing test identities (exact set from candidate bytes)', failing, [...new Set(e.failingTestNames)].sort());
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
  try { rootReal = canonicalPath(rootAbs); } catch {
    // The root itself did not resolve. MEASURED (v1.4 release gate, GitHub
    // Windows runner + probe v14-shorttemp-suite.mjs): `os.tmpdir()` there is
    // `C:\Users\RUNNER~1\...` — an 8.3 SHORT spelling — so a root that has
    // since been deleted used to be compared, short-spelled, against files
    // canonicalised to the LONG spelling: every file was then reported as
    // "resolves outside the artifacts directory" instead of "artifact
    // missing". Canonicalising the PARENT keeps the comparison between two
    // canonical spellings; when even that fails the root is genuinely gone and
    // each file is surfaced by the existence check below.
    try { rootReal = path.join(canonicalPath(path.dirname(rootAbs)), path.basename(rootAbs)); } catch { /* root missing → surfaced per-file */ }
  }

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
    // Post-GLM G: the tuple grew 4 → 5. Every round — injected or not — retains
    // `<arm>-<round>.attest.ndjson` (empty when the pipe carried nothing), so
    // the recorded framesSha256 is bound to bytes exactly like the other four.
    // No `.attest.norm` variant: the NDJSON IS the canonical bytes.
    const obs = r.executionObservation as ExecutionObservation | undefined;
    if (obs === undefined) {
      issues.push(`${at}: executionObservation absent — every round must carry its observation and retain ${label}.attest.ndjson (post-GLM G); observation bytes cannot be bound`);
    }
    const want: Array<[string, string]> = [
      [`${label}.stdout.log`, r.rawStdoutSha256],
      [`${label}.stderr.log`, r.rawStderrSha256],
      [`${label}.stdout.norm`, r.normalizedStdoutSha256],
      [`${label}.stderr.norm`, r.normalizedStderrSha256],
    ];
    if (obs !== undefined) want.push([`${label}.attest.ndjson`, obs.framesSha256]);
    for (const [file, hash] of want) {
      const p = path.join(rootAbs, file); // file is a bare derived basename (no separators)
      const lex = withinDir(rootAbs, p);
      if (!lex.ok) { issues.push(`${at}: artifact ${file} escapes the artifacts directory (${lex.why})`); continue; }
      // EXISTENCE BEFORE RESOLUTION. MEASURED (v1.4 release gate): the realpath
      // check used to run first, and a MISSING file cannot be canonicalised —
      // the fallback kept the caller's spelling while the root had been
      // canonicalised, so on a host whose temp path has an 8.3 short name
      // (`C:\Users\RUNNER~1\…`) a deleted artifact was reported as
      // "resolves outside the artifacts directory". That is a false accusation
      // of traversal, and it masked the finding the operator needs: the
      // artifact is gone. Both outcomes are refusals — no verdict changes —
      // but the named reason must be the true one.
      if (!fs.existsSync(p)) {
        issues.push(`${at}: artifact missing: ${file}`);
        continue;
      }
      let real: string;
      try { real = canonicalPath(p); } catch {
        try { real = path.join(canonicalPath(path.dirname(p)), path.basename(p)); } catch {
          issues.push(`${at}: artifact ${file} exists but cannot be resolved for containment`);
          continue;
        }
      }
      const re = withinDir(rootReal, real);
      if (!re.ok) { issues.push(`${at}: artifact ${file} resolves outside the artifacts directory (${re.why})`); continue; }
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
 *
 * Post-GLM G adds two more byte-boundities, both host-gated like argv
 * re-derivation: (1) each round's executionObservation must equal the result
 * of re-running the SHARED capture validator over the retained
 * `<arm>-<round>.attest.ndjson` bytes with Canary-re-derived inputs; (2) the
 * retained observer preload under wsRoot must byte-match the current
 * OBSERVER_PRELOAD_SOURCE (what Canary injected is checkable, not assumed).
 * Without a `ctx` (the report flow has no spec handle) these are not
 * evaluable here — verifyArtifacts still binds the frame bytes to their
 * recorded digest on every host.
 */
export function verifyArtifactSemantics(
  artifactsDir: string,
  bundle: EvidenceBundle,
  ctx?: ProveReplayContext,
): string[] {
  const issues: string[] = [];
  const rootAbs = path.resolve(artifactsDir);
  const replays = new Map(replayObservations(artifactsDir, bundle, ctx).map((x) => [x.label, x]));
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
    // The runner decides the TEXT GRAMMAR, and the record says which channel this
    // round was observed through. Capture and this re-derivation therefore resolve
    // runner→parser through the same dispatchers (one mapping, not two), and a
    // resealed runner id cannot buy a weaker re-derivation: a mismatched parser
    // reads no counts, and "recorded 5, bytes report nothing" is an issue, while
    // the runner itself is re-derived from the fixture by the argv/observation
    // replay. Consistency is the point — an issue here is fail-closed.
    const runner = r.executionObservation?.runner;
    const counts = parseSummaryCountsFor(runner, combined);
    const summary = hasRunnerSummaryFor(runner, combined);
    const infra = isInfraOutput(combined);
    const crashed = hasCrashSignature(combined);
    const names = extractFailingTestNamesFor(runner, combined).sort();
    if (r.hasRunnerSummary !== summary) {
      issues.push(`${at}: hasRunnerSummary=${String(r.hasRunnerSummary)} but the artifact bytes ${summary ? 'DO' : 'DO NOT'} match a runner summary`);
    }
    if (r.infraSignal !== infra) {
      issues.push(`${at}: infraSignal=${String(r.infraSignal)} but the artifact bytes ${infra ? 'DO' : 'DO NOT'} carry an infrastructure signature (round-3 B2 matcher)`);
    }
    // Round-3 secondary: a post-summary fatal crash (V8 OOM / abort / segfault)
    // is byte-observable and must be recorded exactly as the bytes say — a
    // resealed false must not launder a crashed round into a trustful verdict.
    if ((r.crashSignal ?? false) !== crashed) {
      issues.push(`${at}: crashSignal=${String(r.crashSignal ?? false)} but the artifact bytes ${crashed ? 'DO' : 'do NOT'} carry a fatal-crash signature`);
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
    const rep = replays.get(label);
    if (rep) {
      issues.push(...rep.issues);
      if (rep.replay) issues.push(...diffObservation(at, r.executionObservation as ExecutionObservation | undefined, rep.replay));
    }
  }
  // (2) The injected bytes themselves: the preload lives under wsRoot (NOT
  // artifactsDir — panel I), so it is outside the manifest of canonical
  // artifacts and bound here instead. Divergence from the CURRENT source means
  // capture and verification disagree about what Canary injects — loud fail by
  // design; bumping OBSERVER_VERSION without a re-run makes old evidence
  // unprovable rather than quietly re-interpretable.
  if (proveReplayEvaluable(bundle, ctx)) {
    const wsRoot = path.resolve(path.dirname(rootAbs));
    const preloadPath = observerPreloadPath({ root: wsRoot, fixture: path.join(wsRoot, 'fixture') });
    let pre: string | null = null;
    try { pre = fs.readFileSync(preloadPath, 'utf8'); } catch { pre = null; }
    if (pre === null) {
      issues.push(`retained observer preload missing (${preloadPath}) — the injected --require bytes cannot be bound to Canary source`);
    } else if (pre !== OBSERVER_PRELOAD_SOURCE) {
      issues.push('retained observer preload bytes differ from the current OBSERVER_PRELOAD_SOURCE — what was injected at capture is not what this build injects (re-run required; never re-interpret old evidence)');
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Round-3 blocker 4 — release-critical fields bound to INDEPENDENT sources.
//
// The Round-3 audit's proven attack: copy a valid bundle, rewrite any of
// {runId, tarball digest, dependency-copy counts, argv, env key set,
// classification label/rule/reason/reproductionCount}, recompute the manifest,
// and every pre-B4 layer agrees — because each layer compared the bundle to
// itself or to bytes that the rewritten field still described. These three
// closers make each field answer to something the forger does not control:
//   A. verifyRunIdentity            — the workspace directory and the RETAINED
//                                      fixture.tgz bytes on disk;
//   B. verifyClassificationDerivation — the round bytes re-flattened through
//                                      the decision table + retained trees;
//   C. hostBoundEvidenceChecks      — the COMMITTED spec re-expanded by the
//                                      trusted policy code, on the pinned
//                                      proof host only (paths/env are
//                                      machine-local; off-host the checks skip
//                                      and the verdict downgrades, B3-style).
// None of them trusts a value merely because it also appears in the bundle.
// ---------------------------------------------------------------------------

/**
 * B4-A: bind the run's identity and the fetched content to the workspace.
 * The pipeline retains BOTH the run directory (named `exp-<id>-<timestamp>`)
 * and the exact fetched tarball (`WS/fixture.tgz`) on disk, so these are
 * facts to CHECK, not claims to trust:
 *  - evidence runId equals the physical workspace directory name;
 *  - that name carries the `exp-<experimentId>-` convention;
 *  - sha256 of the retained tarball bytes equals downstream.tarballSha256.
 * A resealed bundle that renames the run or swaps the digest contradicts the
 * directory layout; one that keeps both consistent must also swap the actual
 * tarball bytes — which then diverges from the proof-pinned digest
 * (assertProof) and from what the tests executed against.
 */
export function verifyRunIdentity(artifactsDir: string, bundle: EvidenceBundle): string[] {
  const issues: string[] = [];
  const wsDir = path.resolve(path.dirname(artifactsDir));
  const dirId = path.basename(wsDir);
  if (bundle.runId !== dirId) {
    issues.push(`runId '${bundle.runId}' is not the workspace directory the artifacts live in ('${dirId}') — resealed run identity`);
  }
  const prefix = `exp-${bundle.experimentId}-`;
  if (!bundle.runId.startsWith(prefix)) {
    issues.push(`runId '${bundle.runId}' does not carry the run-directory convention 'exp-<experimentId>-<timestamp>' (expected prefix '${prefix}')`);
  }
  const tgz = path.join(wsDir, 'fixture.tgz');
  if (!fs.existsSync(tgz)) {
    issues.push(`retained fixture tarball missing (${tgz}) — downstream.tarballSha256 cannot be bound to bytes`);
  } else {
    let actual = '';
    try {
      actual = sha256File(tgz);
    } catch (e) {
      issues.push(`cannot hash retained fixture tarball: ${String(e)}`);
    }
    if (actual && actual !== bundle.downstream.tarballSha256) {
      issues.push(`TAMPERED fixture tarball: evidence records ${bundle.downstream.tarballSha256.slice(0, 16)}…, the retained bytes hash to ${actual.slice(0, 16)}…`);
    }
  }
  return issues;
}

/**
 * B4-B: the classification must FOLLOW from the evidence bytes, not merely
 * sit inside them. RoundFacts are rebuilt from the artifact bytes (the same
 * stdout+stderr the recorder assembled, digest-verified by verifyArtifacts
 * upstream): counts via parseSummaryCounts, hasRunnerSummary, isInfraOutput,
 * extractFailingTestNames. The confinement facts (statuses + drift) are
 * re-derived from the RETAINED tree snapshots via the independent re-flatten
 * (verify-tree), never from the bundle's treeComparison block. classify() +
 * applyConfinementGuard() are re-run over those facts and the recorded label,
 * rule, REASON and reproductionCount must match exactly — validateBundle only
 * re-checks label/rule against the bundle's own recorded facts; this checks
 * the full tuple against facts the bundle does not get to declare.
 *
 * exitCode and (when present) crashSignal/sweepFailed are execution facts no
 * byte stream carries — exit codes are pinned against the committed proof by
 * assertProof; the signal fields are read as recorded, matching how
 * validateBundle re-derives.
 */
export function verifyClassificationDerivation(
  artifactsDir: string,
  bundle: EvidenceBundle,
  ctx?: ProveReplayContext,
): string[] {
  const issues: string[] = [];
  const rootAbs = path.resolve(artifactsDir);
  // Post-GLM G: the gate reads executionObservation, so a re-derived-from-bytes
  // observation must feed classify() wherever one can honestly be re-derived
  // (proof host + committed spec). Elsewhere the recorded field flows through —
  // exactly how exitCode/sweepFailed already work — and host-exact conclusions
  // stay skipped, so the drifted-host posture (portable hold → INCOMPLETE)
  // never changes because of the channel.
  const replays = new Map(replayObservations(artifactsDir, bundle, ctx).map((x) => [x.label, x]));
  const read = (name: string): string | null => {
    const p = path.join(rootAbs, name);
    const lex = withinDir(rootAbs, p);
    if (!lex.ok) return null;
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  };
  const facts: RoundFact[] = [];
  for (const r of bundle.rounds) {
    const at = `round ${r.arm}#${r.round}`;
    const label = `${r.arm}-${r.round}`;
    const so = read(`${label}.stdout.log`);
    const se = read(`${label}.stderr.log`);
    if (so === null || se === null) {
      issues.push(`${at}: cannot read raw stdout/stderr for classification re-derivation`);
      continue;
    }
    const combined = so + se;
    const rep = replays.get(label);
    if (rep) issues.push(...rep.issues);
    // Runner-aware like capture: the recorded runner selects the text grammar, and
    // the observation replay above has already re-derived that id from the fixture.
    const runner = (rep?.replay?.runner ?? r.executionObservation?.runner);
    const counts = parseSummaryCountsFor(runner, combined);
    facts.push({
      arm: r.arm,
      round: r.round,
      exitCode: r.exitCode,
      hasRunnerSummary: hasRunnerSummaryFor(runner, combined),
      infraSignal: isInfraOutput(combined),
      reportedPassing: counts.passing,
      reportedFailing: counts.failing,
      reportedPending: counts.pending,
      failingTestNames: extractFailingTestNamesFor(runner, combined).sort(),
      executionObservation: rep?.replay ?? (r.executionObservation as ExecutionObservation | undefined),
      // crashSignal is byte-observable → re-derived here, not trusted from the
      // record, so a resealed false cannot launder a crashed round into trust.
      ...(hasCrashSignature(combined) ? { crashSignal: true } : {}),
      // sweepFailed is a post-exit kernel observation the streams cannot carry
      // → read as recorded (honest limit, documented in the executor).
      ...(r.sweepFailed !== undefined ? { sweepFailed: r.sweepFailed } : {}),
    });
  }
  if (issues.length > 0) return issues; // no verdict can be derived from unreadable bytes

  const treesB = deriveArmTreeFacts(bundle, rootAbs, 'baseline');
  const treesC = deriveArmTreeFacts(bundle, rootAbs, 'candidate');
  if (!treesB || !treesC) {
    return ['classification re-derivation requires retained tree snapshots readable for both arms — confinement facts would otherwise be taken on the bundle\'s word (round-3 B4)'];
  }
  const drift = diffTrees(treesB.flat, treesC.flat, bundle.dependency.package);
  const derived = applyConfinementGuard(classify(facts), {
    confined: drift.confined,
    other: drift.other,
    dependency: bundle.dependency.package,
    baselineStatus: treesB.status,
    candidateStatus: treesC.status,
  });
  const rec = bundle.classification;
  if (derived.classification !== rec.label) {
    issues.push(`classification label '${rec.label}' disagrees with re-derivation from the artifact bytes ('${derived.classification}')`);
  }
  if (derived.rule !== rec.rule) {
    issues.push(`classification rule ${rec.rule} disagrees with re-derivation from the artifact bytes (rule ${derived.rule})`);
  }
  if (derived.reason !== rec.reason) {
    issues.push(`classification reason '${rec.reason}' is not what the decision table says for these bytes ('${derived.reason}')`);
  }
  if (derived.details.candidateRuns !== rec.reproductionCount) {
    issues.push(`reproductionCount=${rec.reproductionCount} disagrees with the re-derived candidate round count (${derived.details.candidateRuns})`);
  }
  return issues;
}

/**
 * B4-C input: the slice of the COMMITTED spec the host-bound checks re-execute
 * expansion over. Trusted precisely because it is the checked-in file the
 * proof gate was invoked with — never anything the evidence carries.
 */
export interface TrustedRunSpec {
  id: string;
  dependency: { package: string; baseline: string; candidate: string };
  /** The re-derivation consumes `test`; the index signature lets a real
   *  (fuller) spec object flow through unchanged. */
  commands: { test: string[]; [k: string]: unknown };
}

/** Same npm-CLI resolution the pipeline itself uses (both bundled layouts,
 *  legacy exe-dir first — see resolveNpmCli). */
const proofNpmCli = (): string =>
  resolveNpmCli()
  ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

/** Mirror of the pipeline's resolveBin over the RETAINED fixture install. */
function fixtureResolveBin(fixtureDir: string): (pkg: string, key?: string) => string {
  return (pkg, key) => {
    const pj = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'node_modules', pkg, 'package.json'), 'utf8'),
    ) as { bin?: string | Record<string, string> };
    const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[key ?? pkg.split('/').pop() ?? pkg];
    if (!rel) throw new Error(`no bin for ${pkg}`);
    const abs = path.join(fixtureDir, 'node_modules', pkg, rel);
    if (!fs.existsSync(abs)) throw new Error(`bin missing: ${abs}`);
    return abs;
  };
}

/**
 * Expected argv (AND injection plan) for EVERY measurement round, re-derived
 * from the committed spec by the TRUSTED expansion code — post-GLM this flows
 * through Recorder.expandArgvWithPlan, the SAME function the pipeline used at
 * capture time, so the injection decision (pinned-bytes mocha at the canonical
 * path ⇒ trailing `--require <preload>`) is re-made identically from the
 * RETAINED fixture rather than re-implemented. Consequences:
 *  - on the proof host, expected argv includes the injected --require iff the
 *    retained runner tree still matches the pin — a resealed r.argv that
 *    dropped flags or swapped the executable diverges, and so does dropping
 *    or ADDING the observation channel;
 *  - a post-run swap of FIXTURE/node_modules/mocha makes the re-derived argv
 *    and the re-derived plan diverge from what was recorded — prove then FAILS
 *    loudly. That drift detection is a FEATURE (panel G), not a bug: the tree
 *    the claim was made about must still be the tree on disk.
 * `opts.allowCanaryDoubleOrigin` (post-GLM F5): the origin gate applies to
 * re-derivation exactly as to capture — see recordedClaimsCanaryDouble for
 * how prove supplies it without owning an authority channel.
 */
export function deriveExpectedRoundArgv(
  spec: TrustedRunSpec, wsRoot: string,
  opts: { allowCanaryDoubleOrigin?: boolean; runnerIdentities?: Record<string, { version: string; identitySha256: string }> } = {},
): { argv: string[]; plan: ExpansionPlan } {
  const fixture = path.join(wsRoot, 'fixture');
  const rec = new Recorder({
    ws: { root: wsRoot, fixture },
    nodeDir: path.dirname(process.execPath),
    npmCli: proofNpmCli(),
    artifactsDir: wsRoot, // irrelevant to expansion
    pipeline: [],
    allowCanaryDoubleOrigin: opts.allowCanaryDoubleOrigin === true,
    ...(opts.runnerIdentities !== undefined ? { runnerIdentities: opts.runnerIdentities } : {}),
  });
  return rec.expandArgvWithPlan(
    spec.commands.test,
    { dep: spec.dependency.package, baseline: spec.dependency.baseline, candidate: spec.dependency.candidate },
    fixtureResolveBin(fixture),
  );
}

/**
 * post-GLM F5 — prove-side injection parity WITHOUT an authority channel.
 * `check`/`prove` run as production CLI processes, which (by the F5 design)
 * can never grant double authority — yet the offline suite's committed
 * evidence was captured THROUGH the double with that grant, and re-deriving
 * its argv without it would diverge from the recorded `--require` (parity is
 * structural, see deriveExpectedRoundArgv). Resolution: honor the claim the
 * RETAINED EVIDENCE ALREADY MAKES. expectedMochaVersion is Canary-written
 * from the PIN at capture — if it names the double pin, capture held the
 * grant. This is sound because prove EXECUTES NOTHING: re-derivation with
 * the claim can only ever reproduce the decision; the attacker's own capture
 * (no grant) is all-ABSENT ⇒ no double claim ⇒ absent-posture re-derivation
 * ⇒ absent-parity, and a RESEALED double claim meets the argv re-derivation
 * and the replay diff — dropping `--require` from recorded argv, or forging
 * VALID frames without the injected lifecycle, fails loudly. npm-pinned
 * evidence (the golden) never claims the double, so its posture is identical
 * in both worlds.
 */
function recordedClaimsCanaryDouble(bundle: EvidenceBundle): boolean {
  const doubleVersions = new Set(
    (KNOWN_RUNNER_RELEASES.mocha ?? []).filter((p) => p.origin === 'canary-double').map((p) => p.version),
  );
  return bundle.rounds.some((r) => doubleVersions.has(r.executionObservation.expectedMochaVersion ?? ''));
}

/**
 * The NON-PACKAGE runner identities the retained evidence claims — the same
 * no-authority-channel resolution `recordedClaimsCanaryDouble` uses, for the same
 * reason: `check`/`prove` run as production processes that (by design) cannot
 * grant a runner identity, yet re-derivation must reproduce capture's injection
 * decision or parity would fail for every honestly captured round.
 *
 * Sound because prove EXECUTES NOTHING: re-derivation with the claim can only
 * reproduce the decision. An attacker's own capture (no grant) is all-ABSENT ⇒ no
 * claim ⇒ absent-posture re-derivation; and a RESEALED claim still has to survive
 * the argv re-derivation and the replay diff of the identity fields.
 */
function recordedRunnerIdentities(bundle: EvidenceBundle): Record<string, { version: string; identitySha256: string }> {
  const out: Record<string, { version: string; identitySha256: string }> = {};
  for (const r of bundle.rounds) {
    const o = r.executionObservation;
    if (o.runner !== undefined && o.expectedRunnerVersion !== undefined && o.expectedRunnerIdentitySha256 !== undefined) {
      out[o.runner] = { version: o.expectedRunnerVersion, identitySha256: o.expectedRunnerIdentitySha256 };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Post-GLM G — observation replay. The retained `<arm>-<round>.attest.ndjson`
// bytes are re-run through the SHARED capture validator (one implementation,
// never three) with inputs Canary re-derives itself: the expansion plan from
// deriveExpectedRoundArgv (injected / absentKind / expected* / the re-hashed
// fixture tree), the text channel from the digest-bound stdout/stderr bytes,
// the exit code from the round. Recorded-vs-rederived equality of
// status/counts/identities/hashes is then required — the same three-way
// re-derivation contract the text facts obey, extended to the execution
// channel. Host-gated exactly like argv re-derivation (paths and node
// resolution are machine-local; off the proof host these checks skip and the
// verdict downgrades to INCOMPLETE, never PASS).
// ---------------------------------------------------------------------------

/** Supplied by prove/check flows that hold the committed spec + proof + an
 *  actual runtime sample; the report flow has no handle on the spec and
 *  passes nothing — the replay is then simply not evaluable here. */
export interface ProveReplayContext {
  spec: TrustedRunSpec | undefined;
  proof: ProofExpectation | undefined;
  runtime: HostFingerprint;
}

export function proveReplayEvaluable(bundle: EvidenceBundle, ctx: ProveReplayContext | undefined): boolean {
  return ctx?.spec !== undefined && ctx.proof !== undefined
    && proofHostContext(bundle, ctx.proof, ctx.runtime).onProofHost;
}

interface ObservationReplay {
  label: string;
  /** Re-derived from retained bytes; null when not evaluable here (portable
   *  hold) or when the inputs needed for a re-derivation are unreadable. */
  replay: ExecutionObservation | null;
  issues: string[];
}

function extractHelloPid(raw: string): number | undefined {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{"k":"hello"')) continue;
    try {
      const f = JSON.parse(line) as { pid?: unknown };
      if (typeof f.pid === 'number') return f.pid;
    } catch { /* malformed frames fail validation downstream anyway */ }
  }
  return undefined;
}

/** Fields compared between recorded and re-derived observation. invalidReason
 *  is deliberately NOT in the list: a flood-cut stream dies structurally at
 *  replay (the retained prefix has no clean bye / has a partial line) with a
 *  different reason string than the capture's `flood-truncated` — the STATUS
 *  equality is the security property, the reason prose is not. */
const OBSERVATION_REPLAY_FIELDS = [
  'status', 'frameCount', 'framesSha256', 'observedFailingIdentities', 'observedCounts',
  'expectedMochaVersion', 'observedMochaVersion', 'expectedRunnerTreeSha256', 'observedRunnerTreeSha256',
  // Provider-neutral channel identity (v1.1 Phase 2): which runner was required,
  // which version, and the digest of its own bytes. Compared exactly like the
  // mocha fields, so a resealed or drifted runner identity fails loudly.
  'runner', 'expectedRunnerVersion', 'observedRunnerVersion',
  'expectedRunnerIdentitySha256', 'observedRunnerIdentitySha256',
  'absentKind', 'strayFd3Bytes', 'strayFd3Sha256',
] as const;

function diffObservation(at: string, rec: ExecutionObservation | undefined, rep: ExecutionObservation): string[] {
  const issues: string[] = [];
  for (const k of OBSERVATION_REPLAY_FIELDS) {
    const a = rec === undefined ? undefined : (rec as unknown as Record<string, unknown>)[k];
    const b = (rep as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      issues.push(`${at}: executionObservation.${k} records ${JSON.stringify(a ?? null)} but the retained bytes re-derived through the shared validator say ${JSON.stringify(b ?? null)} — resealed observation, tampered frame bytes, or post-run runner-tree drift (prove failing loudly on drift is the documented feature)`);
    }
  }
  return issues;
}

function replayObservations(
  artifactsDir: string,
  bundle: EvidenceBundle,
  ctx: ProveReplayContext | undefined,
): ObservationReplay[] {
  const rootAbs = path.resolve(artifactsDir);
  const wsRoot = path.resolve(path.dirname(rootAbs));
  const evaluable = proveReplayEvaluable(bundle, ctx);
  let derived: { argv: string[]; plan: ExpansionPlan } | undefined;
  let deriveWhy = '';
  if (evaluable) {
    try {
      derived = deriveExpectedRoundArgv(ctx!.spec!, wsRoot, { allowCanaryDoubleOrigin: recordedClaimsCanaryDouble(bundle), runnerIdentities: recordedRunnerIdentities(bundle) });
    } catch (e) {
      deriveWhy = String(e);
    }
  }
  const read = (name: string): string | null => {
    const p = path.join(rootAbs, name);
    if (!withinDir(rootAbs, p).ok) return null;
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  };
  const out: ObservationReplay[] = [];
  for (const r of bundle.rounds) {
    const label = `${r.arm}-${r.round}`;
    const at = `round ${r.arm}#${r.round}`;
    if (!evaluable || derived === undefined) {
      out.push({
        label, replay: null,
        issues: evaluable
          ? [`${at}: observation replay impossible — committed-spec re-expansion threw: ${deriveWhy}`]
          : [],
      });
      continue;
    }
    const attest = read(`${label}.attest.ndjson`);
    const so = read(`${label}.stdout.log`);
    const se = read(`${label}.stderr.log`);
    if (attest === null || so === null || se === null) {
      out.push({ label, replay: null, issues: [`${at}: cannot read retained ${attest === null ? 'observation' : 'stdout/stderr'} bytes for observation replay`] });
      continue;
    }
    const plan = derived.plan;
    const combined = so + se;
    // Channel-aware: the SAME dispatcher capture used, so the executor and this
    // replay can never read one stream as two different summaries.
    const counts = parseSummaryCountsFor(plan.runner, combined);
    const replay = validateObservation({
      raw: attest,
      injected: plan.injected,
      absentKind: plan.absentKind ?? 'no-injection',
      // Capture's flood cap cannot be re-applied here — the retained bytes ARE
      // its output; a cut stream lacks its bye frame and dies structurally in
      // the validator, so re-flagging by length buys nothing and could
      // mislabel an exactly-full legitimate stream. (See header comment.)
      truncated: false,
      exitCode: r.exitCode,
      // The spawn-pid cross-check is LIVE-only: the parent knows child.pid at
      // spawn, but the bundle keeps no independent copy (panel E fixed the
      // field layout without one), so the replay inherits the bytes' own pid.
      // The check defends the live pipe (co-tenant frame injection), not the
      // sealed archive — a forger who already controls these bytes also
      // controls the recorded claim they are checked against.
      childPid: extractHelloPid(attest) ?? 0,
      // Provider-neutral channel: the runner, version and identity digest come
      // from the RE-DERIVED plan (which re-made the injection decision from the
      // retained fixture), and the nonce is re-derived from the round's own
      // identity — so this is a genuine re-validation, not a restatement.
      ...(plan.runner !== undefined ? { runner: plan.runner } : {}),
      ...(plan.runner !== undefined && plan.expectedRunnerVersion !== undefined && plan.expectedRunnerIdentitySha256 !== undefined
        ? { expectedRunner: { id: plan.runner, version: plan.expectedRunnerVersion, identitySha256: plan.expectedRunnerIdentitySha256 } }
        : {}),
      ...(plan.runner !== undefined
        ? { expectedNonce: observerNonce(plan.runner, path.join(wsRoot, 'fixture'), r.arm, r.round) }
        : {}),
      ...(plan.observedRunnerIdentitySha256 !== undefined ? { observedRunnerIdentitySha256: plan.observedRunnerIdentitySha256 } : {}),
      expectedMochaVersion: plan.expectedMochaVersion,
      expectedRunnerTreeSha256: plan.expectedRunnerTreeSha256,
      observedRunnerTreeSha256: plan.observedRunnerTreeSha256,
      textCounts: { passing: counts.passing, failing: counts.failing, pending: counts.pending },
      hasSummary: hasRunnerSummaryFor(plan.runner, combined),
      textFailingNames: extractFailingTestNamesFor(plan.runner, combined),
    });
    out.push({ label, replay, issues: [] });
  }
  return out;
}

/**
 * B4-C: on the ACTUAL pinned proof host, each round's argv and env key set are
 * facts checkable against reality: the committed spec re-expanded to argv, and
 * the sanitizer's own declaration to the env key set (win32: 15 keys, POSIX:
 * 4 — derived here from `sanitizedEnv`, not from the allowlist prose). The
 * evidence therefore cannot weaken its own argv (e.g. dropping --ignore-scripts)
 * or trim its envKeys to a smaller allowlisted subset and reseal — both break
 * exact equality with the re-derivation. Off the proof host these are the only
 * checks that legitimately cannot be reproduced (paths and env policy ARE
 * machine-local), so they SKIP — and proofVerdict downgrades to INCOMPLETE,
 * never PASS (B3 posture).
 */
export function hostBoundEvidenceChecks(
  ev: EvidenceBundle,
  proof: ProofExpectation,
  spec: TrustedRunSpec | undefined,
  artifactsDir: string,
  runtime: HostFingerprint,
): AssertionResult[] {
  const checks: AssertionResult[] = [];
  const { onProofHost, skipWhy } = proofHostContext(ev, proof, runtime);
  if (!onProofHost) {
    checks.push({
      name: `round argv re-derived from committed spec [SKIPPED: ${skipWhy}]`,
      ok: true, skipped: true,
      expected: 'every round\'s argv == expandArgv(spec.commands.test) on this host',
      actual: ev.rounds.map((r) => [`${r.arm}#${r.round}`, r.argv]),
    });
    checks.push({
      name: `round envKeys re-derived from sanitizer policy [SKIPPED: ${skipWhy}]`,
      ok: true, skipped: true,
      expected: 'every round\'s envKeys == the exact sanitizedEnv key set on this host',
      actual: ev.rounds.map((r) => [`${r.arm}#${r.round}`, r.envKeys]),
    });
    return checks;
  }
  const wsRoot = path.resolve(path.dirname(artifactsDir));
  const eqJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  // --- argv per round -------------------------------------------------------
  if (!spec || !Array.isArray(spec.commands?.test) || spec.commands.test.length === 0) {
    checks.push({
      name: 'committed spec provides commands.test (argv re-derivation anchor)',
      ok: false,
      expected: 'spec.commands.test: non-empty string[]',
      actual: spec ? spec.commands?.test ?? null : 'no spec supplied',
    });
  } else {
    let expected: string[] | undefined;
    let why = '';
    try {
      expected = deriveExpectedRoundArgv(spec, wsRoot, { allowCanaryDoubleOrigin: recordedClaimsCanaryDouble(ev), runnerIdentities: recordedRunnerIdentities(ev) }).argv;
    } catch (e) {
      why = String(e);
    }
    if (expected === undefined) {
      checks.push({
        name: 'round argv re-derivation impossible (retained fixture or spec defective)',
        ok: false, expected: 'expandArgv over the committed spec + retained workspace', actual: why,
      });
    } else {
      for (const r of ev.rounds) {
        checks.push({
          name: `round ${r.arm}#${r.round} argv re-derived from committed spec`,
          ok: eqJson(r.argv, expected), expected, actual: r.argv,
        });
      }
    }
  }

  // --- env key set per round ------------------------------------------------
  let expectedKeys: string[] | undefined;
  let keysWhy = '';
  try {
    const ws: WorkspaceLayout = { root: wsRoot, fixture: path.join(wsRoot, 'fixture') };
    expectedKeys = sanitizedEnvKeys(sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath) }));
  } catch (e) {
    keysWhy = String(e);
  }
  if (expectedKeys === undefined) {
    checks.push({
      name: 'round envKeys re-derivation impossible (sanitizer policy not evaluable here)',
      ok: false, expected: 'Object.keys(sanitizedEnv(...)) on this host', actual: keysWhy,
    });
  } else {
    for (const r of ev.rounds) {
      const actual = [...r.envKeys].sort();
      checks.push({
        name: `round ${r.arm}#${r.round} envKeys re-derived from sanitizer policy`,
        ok: eqJson(actual, expectedKeys), expected: expectedKeys, actual,
      });
    }
  }
  return checks;
}