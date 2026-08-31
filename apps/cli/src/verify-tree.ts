/**
 * Round-3 blocker 6 — INDEPENDENT verification of retained dependency-tree
 * snapshots.
 *
 * The Round-3 audit's core testing lesson: "using the same parser/classifier
 * in both producer and verifier does not prove correctness." The pipeline
 * flattens `npm ls --json` output recursively, hashes it, and DISCARDED the
 * bytes; nothing could later refute a resealed bundle's tree hashes, copy
 * counts, VALID status, or drift confinement. This module is the second
 * opinion: it re-derives every tree fact from the RETAINED raw artifact bytes
 * with a deliberately different implementation (iterative stack traversal,
 * its own version-extraction and subtree-containment logic, no shared code
 * with the pipeline's recursive walk or the comparator's diff), and reports
 * every disagreement with the bundle's claims.
 *
 * What verification here establishes: the bundle's tree facts are what the
 * retained bytes say they are (content integrity of the observation), and
 * the observation was complete (anomaly list re-derived, not merely
 * recorded). What it does NOT establish: that the bytes came from the same
 * npm invocation that ran the tests — that binding is the manifest digest
 * plus the artifact-directory checks in prove.ts (and remains
 * tamper-evidence, not authenticated provenance).
 */

import fs from 'node:fs';
import path from 'node:path';

import { sha256hex } from '@canary-rn/hashing';
import type { EvidenceBundle, TreeSnapshotRef } from '@canary-rn/evidence-schema';

export interface Reflattened {
  parsed: boolean;
  hasRootDeps: boolean;
  /** Logical lineage keys (escaped; '/' means parent/child nesting) -> version. */
  flat: Record<string, string>;
  /** Sorted, deterministic: missing-version / unwalked-subtree / malformed-node. */
  anomalies: string[];
}

const escName = (name: string): string => name.replaceAll('/', '%2F');

/**
 * Iterative stack-based re-flatten of `npm ls --json` bytes. Structurally
 * different from the pipeline's recursive closure ON PURPOSE (see file
 * header): the two agreeing on hostile input is evidence, not a tautology.
 * Same anomaly VOCABULARY as the pipeline (missing-version:,
 * unwalked-subtree:, malformed-node:) so the two implementations can be
 * diffed; different code path to reach it.
 */
export function reflattenNpmLs(rawJson: string): Reflattened {
  let data: unknown;
  try {
    data = JSON.parse(rawJson) as unknown;
  } catch {
    return { parsed: false, hasRootDeps: false, flat: {}, anomalies: ['json-parse-failure'] };
  }
  if (typeof data !== 'object' || data === null) {
    return { parsed: false, hasRootDeps: false, flat: {}, anomalies: ['json-root-not-an-object'] };
  }
  const rootDeps = (data as Record<string, unknown>)['dependencies'];
  const hasRootDeps = typeof rootDeps === 'object' && rootDeps !== null;
  // npm >= 11.19 lists NOT-INSTALLED OPTIONAL dependencies (fsevents on
  // win32, ws's bufferutil/utf-8-validate, …) as empty `{}` nodes. That is a
  // complete observation of an intentionally-absent package, not a hole —
  // exempt iff: zero keys, no `missing` flag, and npm's own `problems` list
  // never mentions the package. GENUINE unmet dependencies carry
  // missing:true and/or a problems entry, so they keep failing closed. The
  // pipeline's flatten encodes this same rule with different code ON
  // PURPOSE; verifyArm's anomaly-set equality then cross-checks the two.
  const problemsRaw = (data as Record<string, unknown>)['problems'];
  const problemHay = (Array.isArray(problemsRaw) ? problemsRaw : [])
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join('\n');
  const mentionedInProblems = (n: string): boolean => {
    const at = `${n}@`;
    for (let i = problemHay.indexOf(at); i !== -1; i = problemHay.indexOf(at, i + 1)) {
      if (i === 0 || !/[A-Za-z0-9@/\\.-]/.test(problemHay[i - 1]!)) return true;
    }
    return false;
  };
  const flat: Record<string, string> = {};
  const anomalies: string[] = [];
  const stack: Array<[Record<string, unknown>, string]> =
    hasRootDeps ? [[rootDeps as Record<string, unknown>, '']] : [];
  let visited = 0;
  while (stack.length > 0) {
    const [deps, prefix] = stack.pop()!;
    for (const name of Object.keys(deps)) {
      const node = deps[name];
      const key = `${prefix}${escName(name)}`;
      const ent = (typeof node === 'object' && node !== null)
        ? node as Record<string, unknown>
        : null;
      const version = ent?.['version'];
      const hasVersion = typeof version === 'string' && version !== '';
      if (ent === null) anomalies.push(`malformed-node:${key}`);
      if (hasVersion) flat[key] = version as string;
      else if (ent !== null && Object.keys(ent).length === 0 && !('missing' in ent) && !mentionedInProblems(name)) {
        /* expected-absent optional: nothing recorded, nothing missing */
      } else anomalies.push(`missing-version:${key}`);
      const sub = ent?.['dependencies'];
      if (sub === undefined || sub === null) continue;
      if (typeof sub !== 'object') { anomalies.push(`malformed-node:${key}`); continue; }
      if (Object.keys(sub as object).length === 0) continue;
      if (hasVersion && ent !== null) {
        stack.push([sub as Record<string, unknown>, `${key}/`]);
      } else {
        anomalies.push(`unwalked-subtree:${key}`);
      }
      if (++visited > 500_000) { anomalies.push('traversal-budget-exceeded'); stack.length = 0; break; }
    }
  }
  return { parsed: true, hasRootDeps, flat, anomalies: [...new Set(anomalies)].sort() };
}

/** Canonical serialization format shared BY DESIGN with the pipeline's
 *  hash definition (the hash is the CLAIM being verified, not the parser —
 *  re-deriving bytes->claims requires reproducing the encoding, and only
 *  the encoding). */
function canonicalOf(flat: Record<string, string>): string {
  return JSON.stringify(Object.entries(flat).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Count copies of `dep` by LOGICAL position (last path segment). Own loop,
 *  own escaping — independent of comparator/pipeline code. */
export function recountCopies(flat: Record<string, string>, dep: string): number {
  const esc = escName(dep);
  let n = 0;
  for (const key of Object.keys(flat)) {
    const segs = key.split('/');
    if (segs[segs.length - 1] === esc) n += 1;
  }
  return n;
}

/** Segment-containment test for drift confinement (round-3 B6 semantics):
 *  a changed key is inside the dependency's subtree iff the escaped dep name
 *  is one FULL segment of the key. Independent of comparator.inDependencySubtree. */
export function deriveConfined(changedKeys: readonly string[], dep: string): boolean {
  const esc = escName(dep);
  return changedKeys.every((k) => k.split('/').includes(esc));
}

function readArtifact(artifactsDir: string, name: string): string | undefined {
  try {
    const abs = path.resolve(artifactsDir, name);
    const root = path.resolve(artifactsDir);
    if (!abs.startsWith(root + path.sep)) return undefined; // confinement (audit B3)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return fs.readFileSync(abs, 'utf8');
    return undefined;
  } catch {
    return undefined;
  }
}

/** Status rule for one re-flattened observation (round-3 B6 semantics,
 *  VALID iff parsed, root deps object, non-empty, dep present, no anomalies).
 *  Exported so prove.ts's classification re-derivation (round-3 B4) judges
 *  confinement over exactly this same bytes-derived notion — one source. */
export function statusOfObservation(re: Reflattened, dependency: string): 'VALID' | 'INCOMPLETE' | 'INVALID' {
  const escDep = escName(dependency);
  const depPresent = Object.keys(re.flat).some((k) => k.split('/').includes(escDep));
  return !re.parsed || !re.hasRootDeps || Object.keys(re.flat).length === 0 ? 'INVALID'
    : re.anomalies.length > 0 || !depPresent ? 'INCOMPLETE'
      : 'VALID';
}

/**
 * Round-3 blocker 4-B: re-derive one arm's tree facts straight from the
 * RETAINED bytes (flat tree + observation status). Returns undefined when the
 * snapshot ref is absent or its raw bytes unreadable — callers must then treat
 * the claim as UNVERIFIABLE, never as supported. In cmdProve's gate order this
 * runs after verifyTreeSnapshots, which has already bound these files' digests
 * to the bundle; standalone use reads whatever bytes are on disk, which is
 * still an independent source relative to the bundle's JSON.
 */
export interface DerivedTreeFacts {
  flat: Record<string, string>;
  anomalies: string[];
  status: 'VALID' | 'INCOMPLETE' | 'INVALID';
}
export function deriveArmTreeFacts(
  bundle: EvidenceBundle, artifactsDir: string, arm: 'baseline' | 'candidate',
): DerivedTreeFacts | undefined {
  const tc = bundle.treeComparison as unknown as Record<string, unknown>;
  const snap = (tc.snapshots as Record<string, TreeSnapshotRef> | undefined)?.[arm];
  if (!snap) return undefined;
  const raw = readArtifact(artifactsDir, snap.rawStdoutLog);
  if (raw === undefined) return undefined;
  const re = reflattenNpmLs(raw);
  return { flat: re.flat, anomalies: re.anomalies, status: statusOfObservation(re, bundle.dependency.package) };
}

/**
 * Verify one arm's retained snapshot against the bundle's claims.
 * Returns issue strings (empty = everything the bundle says about this arm's
 * tree is what the retained bytes independently say).
 */
function verifyArm(
  arm: 'baseline' | 'candidate',
  bundle: EvidenceBundle,
  artifactsDir: string,
): string[] {
  const issues: string[] = [];
  const tc = bundle.treeComparison as unknown as Record<string, unknown>;
  const snaps = tc.snapshots as Record<string, TreeSnapshotRef> | undefined;
  const snap = snaps?.[arm];
  const at = `tree snapshot (${arm})`;
  if (!snap) {
    return [`${at}: no retained snapshot recorded — tree facts are not independently verifiable`];
  }
  // Canonical names are DERIVED from the arm — evidence may not point at
  // another arm's bytes (audit B3 lesson applied to tree artifacts).
  const expected: TreeSnapshotRef = {
    rawStdoutLog: `tree-${arm}.treels.raw.log`,
    rawStdoutSha256: snap.rawStdoutSha256,
    rawStderrLog: `tree-${arm}.treels.stderr.log`,
    rawStderrSha256: snap.rawStderrSha256,
    canonicalLog: `tree-${arm}.treels.canonical.json`,
    canonicalSha256: snap.canonicalSha256,
  };
  for (const f of ['rawStdoutLog', 'rawStderrLog', 'canonicalLog'] as const) {
    if (snap[f] !== expected[f]) issues.push(`${at}: ${f} '${String(snap[f])}' is not the arm-derived artifact name '${expected[f]}'`);
  }
  const raw = readArtifact(artifactsDir, snap.rawStdoutLog);
  if (raw === undefined) { issues.push(`${at}: raw npm-ls artifact '${snap.rawStdoutLog}' missing/unreadable`); return issues; }
  if (sha256hex(raw) !== snap.rawStdoutSha256) {
    issues.push(`${at}: raw artifact bytes do not match the recorded digest (tampered or misbound bytes)`);
    return issues; // further re-derivation would verify bytes no one claims
  }
  const stderr = readArtifact(artifactsDir, snap.rawStderrLog);
  if (stderr === undefined) issues.push(`${at}: raw npm-ls STDERR artifact '${snap.rawStderrLog}' missing (npm prints ELSPROBLEMS there; absence means it was not retained)`);
  else if (sha256hex(stderr) !== snap.rawStderrSha256) issues.push(`${at}: stderr bytes do not match the recorded digest`);

  // Re-derive everything from bytes with the INDEPENDENT parser.
  const re = reflattenNpmLs(raw);
  const claimedStatus = (tc.observationStatus as Record<string, string>)[arm];
  const claimedTreeSha = arm === 'baseline' ? tc.baselineTreeSha256 : tc.candidateTreeSha256;
  const claimedCopies = (tc.dependencyCopies as Record<string, number>)[arm];
  const claimedAnoms = (tc.observationAnomalies as Record<string, { json: string[] }> | undefined)?.[arm]?.json;

  // 1. Canonical flatten + tree hash chain: claimed hash == hash of
  //    retained-canonical-file == hash of INDEPENDENTLY re-derived flatten.
  const canonicalFile = readArtifact(artifactsDir, snap.canonicalLog);
  if (canonicalFile === undefined) issues.push(`${at}: canonical artifact '${snap.canonicalLog}' missing`);
  else {
    if (sha256hex(canonicalFile) !== snap.canonicalSha256) issues.push(`${at}: canonical bytes do not match the recorded digest`);
    const mine = canonicalOf(re.flat);
    if (canonicalFile !== mine) issues.push(`${at}: canonical artifact does not match the independent re-flatten of the raw bytes`);
    if (sha256hex(mine) !== claimedTreeSha) {
      issues.push(`${at}: ${arm}TreeSha256 does not match sha256 of the re-derived canonical flatten (tree hash not supported by retained evidence)`);
    }
  }

  // 2. Status equivalence — recomputed via statusOfObservation (round-3 B4:
  //    the same function prove.ts's classification re-derivation uses).
  const dep = bundle.dependency.package;
  const escDep = escName(dep);
  const derivedStatus = statusOfObservation(re, dep);
  if (claimedStatus !== derivedStatus) {
    issues.push(`${at}: observationStatus '${claimedStatus}' disagrees with re-derivation from bytes ('${derivedStatus}')`);
  }

  // 3. Anomaly set equality (recorded vs re-derived).
  if (claimedAnoms === undefined) {
    issues.push(`${at}: observationAnomalies.${arm}.json absent — cannot confirm the flatten was checked for holes`);
  } else if (JSON.stringify([...claimedAnoms].sort()) !== JSON.stringify(re.anomalies)) {
    issues.push(`${at}: recorded anomalies ${JSON.stringify(claimedAnoms.slice(0, 6))} differ from re-derived ${JSON.stringify(re.anomalies.slice(0, 6))}`);
  }

  // 4. Copy count.
  const mineCopies = recountCopies(re.flat, dep);
  if (claimedCopies !== mineCopies) {
    issues.push(`${at}: dependencyCopies.${arm}=${String(claimedCopies)} disagrees with ${String(mineCopies)} recounted from retained bytes`);
  }

  // 5. The attested resolved version is bound to the BYTES: when the
  //    dependency sits at the tree root (the position npm resolves it to),
  //    the retained flatten must carry that exact version there. Catches a
  //    resealed tree whose digests were recomputed but whose root entry now
  //    contradicts the attestation claim.
  const claimedResolved = (tc.resolvedVersions as Record<string, string> | undefined)?.[arm];
  const rootEntry = re.flat[escDep];
  if (claimedResolved !== undefined && rootEntry !== undefined && claimedResolved !== rootEntry) {
    issues.push(`${at}: resolvedVersions.${arm}='${claimedResolved}' contradicts the root-level '${escDep}' entry '${rootEntry}' in the retained bytes`);
  }
  return issues;
}

/**
 * Verify drift confinement independently: re-flatten BOTH arms and recompute
 * which changed keys live outside the dependency's subtree. Only possible
 * when both arms' raw snapshots survive; otherwise the claim is unverifiable
 * (reported as an issue).
 */
export function verifyDriftFromSnapshots(bundle: EvidenceBundle, artifactsDir: string): string[] {
  const tc = bundle.treeComparison as unknown as Record<string, unknown>;
  const snaps = tc.snapshots as Record<string, TreeSnapshotRef> | undefined;
  if (!snaps?.baseline || !snaps?.candidate) return ['tree drift: snapshots not retained for both arms — confinement claim is unverifiable'];
  const rawB = readArtifact(artifactsDir, snaps.baseline.rawStdoutLog);
  const rawC = readArtifact(artifactsDir, snaps.candidate.rawStdoutLog);
  if (rawB === undefined || rawC === undefined) return ['tree drift: raw snapshot bytes missing — confinement claim is unverifiable'];
  if (sha256hex(rawB) !== snaps.baseline.rawStdoutSha256 || sha256hex(rawC) !== snaps.candidate.rawStdoutSha256) {
    return ['tree drift: raw snapshot bytes do not match recorded digests'];
  }
  const b = reflattenNpmLs(rawB).flat;
  const c = reflattenNpmLs(rawC).flat;
  const changed: string[] = [];
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(c)])]) {
    if (b[k] !== c[k]) changed.push(k);
  }
  const confined = deriveConfined(changed, bundle.dependency.package);
  if (tc.driftConfinedToDependency !== confined) {
    return [`tree drift: claim driftConfinedToDependency=${String(tc.driftConfinedToDependency)} contradicts independent recomputation from retained snapshots (${confined ? 'confined' : 'NOT confined'}; offenders: ${changed.filter((k) => !k.split('/').includes(escName(bundle.dependency.package))).slice(0, 8).join(', ') || 'none'})`];
  }
  return [];
}

/** All issues from verifying both arms' snapshots + drift confinement. */
export function verifyTreeSnapshots(bundle: EvidenceBundle, artifactsDir: string): string[] {
  return [
    ...verifyArm('baseline', bundle, artifactsDir),
    ...verifyArm('candidate', bundle, artifactsDir),
    ...verifyDriftFromSnapshots(bundle, artifactsDir),
  ];
}
