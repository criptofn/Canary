/**
 * The experiment pipeline — TS port of the proven scripts/run-experiment.mjs.
 * Golden proof assertions (fixtures/.../prove) are the equivalence oracle.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand, sanitizedEnv, resolveNpmCli, CanaryError, type WorkspaceLayout } from '@canary-rn/support';
import { validateSpec, type ExperimentSpec } from '@canary-rn/planner';
import { auditFixtureDir, expectedExtractedDir } from '@canary-rn/workspace';
import { downloadTarball } from '@canary-rn/github';
import { staticFingerprint, withNpmVersion } from '@canary-rn/environment';
import {
  Recorder, roundEvidence as execRoundEvidence, ensureObserverPreload,
  type ExecResult, type ExpansionPlan,
} from '@canary-rn/executor';
import { buildPipeline, machineRules, DEFAULT_RULE_NAMES } from '@canary-rn/normalizers';
import { diffTrees, escapePkgKey, extractFailingTestNamesFor, parseSummaryCountsFor, classifyTreeObservation, dependencyInTree, type DepTree, type TreeStatus } from '@canary-rn/comparator';
import { classify, applyConfinementGuard, type RoundFact } from '@canary-rn/classification';
import { EVIDENCE_SCHEMA_VERSION, validateBundle, integrityFor, type EvidenceBundle, type RoundEvidence, type TreeSnapshotRef } from '@canary-rn/evidence-schema';
import { sha256hex } from '@canary-rn/hashing';
import { runnerIdentitiesFromSealedPlan } from './runner-authority.js';

const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);
// R2 host-neutrality: probe BOTH bundled-npm layouts (see resolveNpmCli).
// The fallback keeps the historical path when neither exists, so absence
// still fails LOUDLY downstream (empty sample → contract violation) —
// never silently masquerades as a measurement.
const NPM_CLI = resolveNpmCli() ?? path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const SYSTEMROOT = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
export const CANARY_VERSION = '1.0.0';

export interface PipelineResult {
  bundle: EvidenceBundle;
  workspace: string;
  artifactsDir: string;
  failingTestNames: string[];
  summaryCounts: ReturnType<typeof parseSummaryCountsFor>;
  bundleIssues: string[];
}

/**
 * THE PRODUCTION AUTHORITY SOURCE for a non-package runner's identity lives in
 * `runner-authority.ts` (it needs `onboarding.ts`, which imports this module).
 * Re-exported here so the spec path's authority has one discoverable address.
 */
export { runnerIdentitiesFromSealedPlan } from './runner-authority.js';

export interface PipelineDeps {
  /**
   * Test seam mirroring downloadTarball's own deps.fetchFn and the recorder's
   * deps.run: replaces the network fetch. Default = real codeload download.
   * Only the offline pipeline integration test (audit M8) injects this; the
   * production golden-proof path is untouched.
   */
  fetch?: (repo: string, sha: string) => Promise<{ bytes: Buffer; sha256: string }>;
  /**
   * Test seam for the tarball EXTRACT step (production shells out to the OS
   * tar.exe, which is platform-specific — see F15). Receives the workspace
   * root and must populate WS/<repo-proj>-<sha>/ as real tar extraction does.
   */
  extract?: (tgzPath: string, wsRoot: string, repo: string, sha: string) => void;
  /**
   * post-GLM F5: TEST-ONLY execution authority to select the canary-double
   * runner pin for observation injection. The double exists ONLY for the
   * offline suite and its bytes are public in-repo (see knownRunners.ts),
   * so a spec that stages them at the canonical anchor must NOT earn
   * injection — authority lives in this in-process channel, never in the
   * spec. The production CLI (main.ts) constructs no PipelineDeps, so a
   * spec file can never reach this grant.
   */
  allowCanaryDoubleOrigin?: boolean;
  /**
   * IN-PROCESS AUTHORITY for a non-package runner's identity (v1.1 Phase 2).
   *
   * A Python interpreter is not an npm package, so it cannot be pinned by a
   * repo-side tree hash the way mocha is. The authority is therefore an explicit
   * statement from the CALLER: "this is the interpreter I have authorized", by
   * version and by a digest of the interpreter's own bytes. It rides the same
   * in-process channel as `allowCanaryDoubleOrigin` — the production CLI
   * constructs no PipelineDeps, so a spec file, env or argv can never reach it,
   * and a spec that ships its own interpreter earns ABSENT
   * (`runner-identity-unpinned`) instead of a strong label.
   */
  runnerIdentities?: Record<string, { version: string; identitySha256: string }> | undefined;
}

/**
 * Public entry: runs the experiment, translating Canary's own POLICY
 * refusals (CanaryError — e.g. a $bin:mocha argv that tries to load its own
 * --require, or a spec flag that collides with Canary's protected config)
 * into InfraAbort: the operator-visible outcome of a refused run is
 * INFRASTRUCTURE_FAILURE (exit 2), an honest infra-equivalent degrade —
 * never a PASS-adjacent verdict and never an unclassified crash.
 */
export async function runExperiment(
  specRaw: unknown, repoRoot: string, quiet = false, deps: PipelineDeps = {},
): Promise<PipelineResult> {
  try {
    return await runExperimentInner(specRaw, repoRoot, quiet, deps);
  } catch (e) {
    if (e instanceof InfraAbort || (e instanceof Error && e.name === 'InfraAbort')) throw e;
    if (e instanceof CanaryError) throw new InfraAbort(`spec refused by Canary policy: ${e.message}`);
    throw e;
  }
}

async function runExperimentInner(
  specRaw: unknown, repoRoot: string, quiet: boolean, deps: PipelineDeps,
): Promise<PipelineResult> {
  const log = quiet ? () => undefined : (m: string): void => { console.log(m); };
  const validation = validateSpec(specRaw);
  if (!validation.ok || !validation.spec) {
    throw new Error(`invalid experiment spec:\n  ${validation.errors.join('\n  ')}`);
  }
  const spec = validation.spec;

  const WS = path.join(repoRoot, '.canary-runs',
    `exp-${spec.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const FIXTURE = path.join(WS, 'fixture');
  const ART = path.join(WS, 'artifacts');
  for (const d of [ART, FIXTURE]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(WS, 'empty.npmrc'), '');
  const ws: WorkspaceLayout = { root: WS, fixture: FIXTURE };
  log(`workspace: ${WS}`);

  const resolveBin = (pkg: string, key?: string): string => {
    const pj = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'node_modules', pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[key ?? pkg.split('/').pop() ?? pkg];
    if (!rel) throw new Error(`no bin for ${pkg}`);
    const abs = path.join(FIXTURE, 'node_modules', pkg, rel);
    if (!fs.existsSync(abs)) throw new Error(`bin missing: ${abs}`);
    return abs;
  };

  const pipeline = buildPipeline(DEFAULT_RULE_NAMES, machineRules({
    tempDir: os.tmpdir(),
    homeDir: path.join(WS, 'isolated-home'),
    user: '',
    host: '',
    workspaceRoot: WS,
  }));
  // The runner-identity authority for the spec path: the operator's own SEALED
  // SETUP PLAN (see runner-authority.ts). `deps.runnerIdentities` stays the
  // in-process TEST seam and takes precedence, so a test can grant an identity no
  // config on this machine would.
  const sealedGrants = runnerIdentitiesFromSealedPlan(repoRoot);
  const runnerIdentities = { ...sealedGrants, ...(deps.runnerIdentities ?? {}) };
  const rec = new Recorder({
    ws, nodeDir: NODE_DIR, npmCli: NPM_CLI, artifactsDir: ART, pipeline,
    allowCanaryDoubleOrigin: deps.allowCanaryDoubleOrigin === true,
    ...(Object.keys(runnerIdentities).length > 0 ? { runnerIdentities } : {}),
  });
  const subs = { dep: spec.dependency.package, baseline: spec.dependency.baseline, candidate: spec.dependency.candidate };
  const execArgv = (cmd: readonly string[]): string[] => rec.expandArgv(cmd, subs, resolveBin);
  // Measurement rounds expand WITH the injection plan (post-GLM): the plan is
  // recorded per round, and prove re-derives it through the same call.
  const execTestArgv = (): { argv: string[]; plan: ExpansionPlan } =>
    rec.expandArgvWithPlan(spec.commands.test, subs, resolveBin);

  // [1] fetch pinned content
  const { repo, commit } = spec.downstream;
  log(`[1] fetch ${repo} @ ${commit.slice(0, 10)} (tarball by SHA)`);
  // Round-3 secondary: acquisition and extraction are INFRASTRUCTURE by
  // definition. A codeload 502/timeout/empty-tarball used to surface as a
  // generic Error → CLI exit 3 (misuse), implying the user's invocation was
  // wrong when in fact the environment failed. Everything from the network
  // boundary through extraction now throws InfraAbort (CLI exit 2).
  let blob: { bytes: Buffer; sha256: string };
  try {
    blob = deps.fetch
      ? await deps.fetch(repo, commit)
      : await downloadTarball(repo, commit);
  } catch (e) {
    if (e instanceof InfraAbort) throw e;
    throw new InfraAbort(`content fetch failed for ${repo}@${commit}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const tgz = path.join(WS, 'fixture.tgz');
  try {
    fs.writeFileSync(tgz, blob.bytes);
    log(`  ${Math.round(blob.bytes.length / 1024)} KiB sha256=${blob.sha256.slice(0, 16)}...`);
    if (deps.extract) {
      deps.extract(tgz, WS, repo, commit);
    } else {
      // Audit F15: tar lives at System32\tar.exe on Windows (bsdtar); POSIX
      // hosts provide GNU tar on PATH. Behavior on non-Windows hosts remains
      // UNVERIFIED until CI executes it (docs/SECURITY.md Platform status).
      const tarExe = process.platform === 'win32'
        ? path.join(SYSTEMROOT, 'System32', 'tar.exe')
        : 'tar';
      const tr = spawnSync(tarExe, ['-xzf', tgz, '-C', WS],
        { env: sanitizedEnv({ ws, nodeDir: NODE_DIR }), shell: false, timeout: 180_000 });
      if (tr.status !== 0) throw new Error('tar extraction failed');
    }
    const want = expectedExtractedDir(repo, commit);
    const root = fs.readdirSync(WS).find((d) => d === want || (d.startsWith(`${repo.split('/')[1] ?? ''}-`) && d.includes(commit.slice(0, 7))));
    if (!root) throw new Error(`extracted dir not found (wanted ${want})`);
    fs.rmSync(FIXTURE, { recursive: true, force: true });
    fs.renameSync(path.join(WS, root), FIXTURE);
  } catch (e) {
    if (e instanceof InfraAbort) throw e;
    throw new InfraAbort(`tarball extraction failed for ${repo}@${commit}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // [2] security gate before anything external executes
  log('[2] pre-execution audit');
  const audit = auditFixtureDir(FIXTURE, spec.dependency.package);
  if (!audit.ok) {
    const msg = `audit refused: ${audit.violations.map((v) => `${v.code}: ${v.detail}`).join('; ')}`;
    // Post-GLM AM-2: a SHIPPED node_modules is not a spec problem — real
    // tarballs in scope never contain one, and finding it means the
    // acquisition chain (or a stub seam) delivered content the audit tier
    // exists to quarantine. InfraAbort (exit 2), not MISUSE (exit 3).
    if (audit.violations.some((v) => v.code === 'node-modules-shipped')) throw new InfraAbort(msg);
    throw new Error(msg);
  }
  log(`  ${audit.package.name}@${audit.package.version}; declared ${spec.dependency.package}=${audit.declaredDependency ?? 'none'}; hooks/rc clean`);

  // Observer preload lives under wsRoot (NOT artifactsDir — it is not a
  // canonical artifact), written once here; round() re-verifies bytes before
  // every injected spawn, so a later tamper self-heals or aborts. prove
  // re-derives the same path from wsRoot.
  ensureObserverPreload(ws);

  // [3] prepare + toolchain overrides (identical for both arms)
  log('[3] prepare');
  for (const cmd of spec.commands.prepare) {
    if ((await rec.step('prepare', execArgv(cmd), spec.timeoutSecs?.install ?? 900)).run.exitCode !== 0) {
      throw new InfraAbort('prepare failed');
    }
  }
  for (const cmd of spec.commands.toolchainOverrides ?? []) {
    if ((await rec.step('toolchain', execArgv(cmd), spec.timeoutSecs?.install ?? 900)).run.exitCode !== 0) {
      throw new InfraAbort('toolchain override failed');
    }
  }
  const treeB = await treeHash(ws, spec.dependency.package, ART, 'baseline');
  const attB = await attestDependency(ws, spec.dependency.package);
  attB.copies = treeB.copies;
  // F3: the BASELINE arm's resolved dependency version must be attested from
  // the machine, not copied from the spec.
  if (attB.version !== spec.dependency.baseline) {
    throw new InfraAbort(`baseline attestation failed: resolved ${spec.dependency.package}@${attB.version}, spec claims ${spec.dependency.baseline}`);
  }
  log(`  attested baseline: ${spec.dependency.package}@${attB.version} (${attB.copies} copy/copies in tree)`);

  // [4] build once
  for (const cmd of spec.commands.build ?? []) {
    if ((await rec.step('build', execArgv(cmd), spec.timeoutSecs?.build ?? 600)).run.exitCode !== 0) {
      throw new InfraAbort('build failed under baseline');
    }
  }

  // [5] baseline arm
  log(`[5] baseline arm x${spec.repeats.baseline}`);
  const baseEv: RoundEvidence[] = [];
  for (let i = 1; i <= spec.repeats.baseline; i++) {
    const ex = execTestArgv();
    const r = await rec.round('baseline', i, ex.argv, spec.timeoutSecs?.test ?? 600, ex.plan);
    baseEv.push(execRoundEvidence(r, r.fact));
  }

  // [6] swap candidate
  log('[6] candidate swap');
  if ((await rec.step('swap', execArgv(spec.commands.swap), spec.timeoutSecs?.install ?? 900)).run.exitCode !== 0) {
    throw new InfraAbort('swap failed');
  }
  const attC = await attestDependency(ws, spec.dependency.package);
  if (attC.version !== spec.dependency.candidate) {
    throw new InfraAbort(`candidate attestation failed: resolved ${attC.version}, spec claims ${spec.dependency.candidate}`);
  }
  // Secondary round-3 fix: compute the candidate tree BEFORE logging the
  // attestation so the printed copy count is the real one (it used to print
  // the placeholder `1` emitted by attestDependency).
  const treeC = await treeHash(ws, spec.dependency.package, ART, 'candidate');
  attC.copies = treeC.copies;
  log(`  attested candidate: ${spec.dependency.package}@${attC.version} (${attC.copies} copy/copies)`);
  const drift = diffTrees(treeB.deps, treeC.deps, spec.dependency.package);
  log(`  tree drift: ${drift.confined ? 'confined to dependency subtree' : `NOT confined (${drift.other.slice(0, 8).join(', ')})`}`);

  // [7] candidate arm
  log(`[7] candidate arm x${spec.repeats.candidate}`);
  const candEv: RoundEvidence[] = [];
  let firstCand: (ExecResult & { fact: RoundFact }) | undefined;
  for (let i = 1; i <= spec.repeats.candidate; i++) {
    // Recomputed per round: the mocha tree can change between arms (a
    // prepare-created double is caught at expansion by AM-1 — hash miss ⇒
    // no injection ⇒ ABSENT ⇒ gate), and re-deriving each time means the
    // bundle's per-round plan always describes THAT round's spawn.
    const ex = execTestArgv();
    const r = await rec.round('candidate', i, ex.argv, spec.timeoutSecs?.test ?? 600, ex.plan);
    candEv.push(execRoundEvidence(r, r.fact));
    firstCand ??= r;
  }

  // [8] classify + bundle
  let cls = classify(rec.facts);
  // F4/B6: confinement is ENFORCED, not decorative — incomparable arms cannot
  // yield a verdict. applyConfinementGuard (rule 9 = unconfined drift; rule 10
  // = a dependency-tree observation too weak to prove confinement, audit B6)
  // lives in the classification package and is unit + pipeline tested so its
  // removal flips tests.
  cls = applyConfinementGuard(cls, {
    confined: drift.confined, other: drift.other, dependency: spec.dependency.package,
    baselineStatus: treeB.status, candidateStatus: treeC.status,
  });
  const envFp = withNpmVersion(staticFingerprint(spec.environmentNotes?.toolchainOverrides ?? {}), await npmVersion());
  const bundle: EvidenceBundle = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: path.basename(WS),
    createdAt: new Date().toISOString(),
    canaryVersion: CANARY_VERSION,
    experimentId: spec.id,
    dependency: {
      package: spec.dependency.package,
      baselineVersion: spec.dependency.baseline,
      candidateVersion: spec.dependency.candidate,
    },
    downstream: {
      repositoryUrl: `https://github.com/${repo}`,
      commitSha: commit,
      fetchMethod: 'tarball-by-sha',
      tarballSha256: blob.sha256,
    },
    environment: {
      nodeVersion: envFp.nodeVersion,
      npmVersion: envFp.npmVersion,
      packageManagerUsed: envFp.packageManagerUsed,
      platform: envFp.platform,
      arch: envFp.arch,
      toolchainOverrides: envFp.toolchainOverrides,
    },
    commands: {
      prepare: spec.commands.prepare,
      build: spec.commands.build ?? [],
      swap: spec.commands.swap,
      test: spec.commands.test,
    },
    rounds: [...baseEv, ...candEv],
    treeComparison: {
      baselineTreeSha256: treeB.hash,
      candidateTreeSha256: treeC.hash,
      driftConfinedToDependency: drift.confined,
      // Audit B6: how complete each arm's tree OBSERVATION was; a trustful
      // verdict requires both VALID (enforced by applyConfinementGuard and
      // independently by validateBundle).
      observationStatus: { baseline: treeB.status, candidate: treeC.status },
      resolvedVersions: { baseline: attB.version, candidate: attC.version },
      dependencyCopies: { baseline: attB.copies, candidate: attC.copies },
      // Round-3 blocker 6: the tree facts above are now ANCHORED — the raw
      // npm-ls bytes and canonical flatten are retained on disk (names derived
      // from the arm), and verify-tree re-derives hash/status/copies/drift
      // from them with an independent parser. A bundle without these refs
      // cannot carry a trustful verdict.
      snapshots: { baseline: treeB.snapshot, candidate: treeC.snapshot },
      observationAnomalies: {
        baseline: { json: treeB.jsonAnomalies },
        candidate: { json: treeC.jsonAnomalies },
      },
    },
    classification: {
      label: cls.classification,
      rule: cls.rule,
      reason: cls.reason,
      reproductionCount: cls.details.candidateRuns,
    },
  };

  // Audit B4: bind every release-critical claim (and the per-round artifact
  // digests, which verifyArtifacts ties to the on-disk bytes) into a single
  // manifest digest, computed BEFORE validation so the bundle is self-verifying.
  bundle.integrity = integrityFor(bundle);

  const bundleIssues = validateBundle(bundle);
  fs.writeFileSync(path.join(ART, 'evidence.json'), JSON.stringify(bundle, null, 2));
  fs.writeFileSync(path.join(ART, 'tree-drift.json'), JSON.stringify(drift, null, 2));
  fs.writeFileSync(path.join(repoRoot, '.canary-runs', `latest-${spec.id}.json`),
    JSON.stringify({ evidence: path.join(ART, 'evidence.json'), workspace: WS }, null, 2));

  // Runner-aware, like the round that produced these bytes: the plan for the first
  // candidate round says which channel was attempted, so a node:test project's
  // summary is read with the TAP grammar instead of mocha's.
  const firstRunner = firstCand?.fact.executionObservation?.runner;
  const failingTestNames = extractFailingTestNamesFor(firstRunner, firstCand?.combined ?? '');
  const summaryCounts = parseSummaryCountsFor(firstRunner, firstCand?.combined ?? '');
  log(`\nEXPERIMENT ${spec.id}: ${cls.classification} (rule ${cls.rule}) — ${cls.reason}`);
  return { bundle, workspace: WS, artifactsDir: ART, failingTestNames, summaryCounts, bundleIssues };
}

export class InfraAbort extends Error {
  constructor(readonly reasonText: string) {
    super(`INFRASTRUCTURE_FAILURE: ${reasonText}`);
    this.name = 'InfraAbort';
  }
}

async function npmVersion(): Promise<string> {
  const r = await runCommand({
    ws: { root: os.tmpdir(), fixture: process.cwd() },
    nodeDir: NODE_DIR,
    argv: [NODE, NPM_CLI, '--version'],
    timeoutSecs: 60,
  });
  return r.stdout.trim();
}

/**
 * F3: where does the fixture's own module system resolve the dependency to,
 * and what version lives there? Answered by the runtime itself
 * (require.resolve from the fixture cwd), not by trusting spec text or the
 * registry. Also counts copies present in the resolved tree.
 */
async function attestDependency(
  ws: WorkspaceLayout, dep: string,
): Promise<{ version: string; path: string; copies: number }> {
  // Resolve the package's MAIN entry (always exported), then walk up to its
  // package.json. (require.resolve('<dep>/package.json') fails for packages
  // whose exports map omits ./package.json — axios 1.0.0 among them; found
  // empirically by this very attestation.)
  const script = [
    "const r=require('module').createRequire(process.cwd()+require('path').sep);",
    "const m=r.resolve(DEP);",
    "const fs=require('fs'),path=require('path');",
    'let d=path.dirname(m);',
    "while(d!==path.parse(d).root && !(fs.existsSync(path.join(d,'package.json')) && JSON.parse(fs.readFileSync(path.join(d,'package.json'),'utf8')).name===DEP)) d=path.dirname(d);",
    "const pj=JSON.parse(fs.readFileSync(path.join(d,'package.json'),'utf8'));",
    "console.log(JSON.stringify({path:d,version:pj.version}));",
  ].join('').replace(/DEP/g, JSON.stringify(dep));
  const r = await runCommand({
    ws, nodeDir: NODE_DIR, argv: [NODE, '-e', script], timeoutSecs: 60,
  });
  if (r.exitCode !== 0) throw new InfraAbort(`dependency attestation crashed for ${dep}: ${r.stderr.slice(-400)}`);
  try {
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { path: string; version: string };
    if (!parsed.path.startsWith(ws.fixture)) throw new Error(`resolved outside workspace: ${parsed.path}`);
    return { ...parsed, copies: 1 }; // placeholder; callers refine with tree data
  } catch (e) {
    if (e instanceof InfraAbort) throw e;
    throw new InfraAbort(`dependency attestation unparseable for ${dep}: ${e}`);
  }
}

/**
 * One arm's dependency-tree OBSERVATION (audit B6, hardened by round-3
 * blocker 6). Everything release-critical about the tree — hash, status,
 * copy count, drift — is now anchored to RETAINED artifacts: the raw
 * `npm ls --json` stdout/stderr bytes and the canonical flatten.
 * verify-tree.ts re-derives all of it from those bytes with an INDEPENDENT
 * parser (different traversal, different version-extraction code path), so
 * the bundle cannot claim tree facts its own evidence does not support.
 * The flatten/completeness rules live in flattenNpmLsJson below.
 */
export interface TreeObservation {
  hash: string;
  deps: DepTree;
  status: TreeStatus;
  jsonAnomalies: string[];
  copies: number;
  snapshot: TreeSnapshotRef;
}

export interface NpmLsFlatten {
  parsed: boolean;
  hasRootDeps: boolean;
  /** Logical lineage keys (escaped; '/' means parent/child nesting) -> version. */
  flat: DepTree;
  /** Sorted, deterministic anomaly list (missing-version: / unwalked-subtree: / malformed-node:). */
  jsonAnomalies: string[];
}

/** Traversal budgets shared BY CONTRACT with verify-tree's re-flatten (the
 *  parity suite pins equality): a tree deeper/wider than any real npm
 *  resolution (post-sol secondary: deep inputs were unbounded — recursive
 *  walks could exhaust the stack on hostile bytes) is recorded as a bounded
 *  PARTIAL observation, never silently truncated. */
export const MAX_TREE_NODES = 200_000;
export const MAX_TREE_DEPTH = 128;

/**
 * Flatten `npm ls --json` stdout bytes (+ the retained stderr bytes, post-sol
 * M-2) into the logical tree + anomaly list (audit B6, hardened by round-3
 * blocker 6, the npm 11.19 compatibility finding, and post-sol M-2).
 * Exported PURE (bytes in, facts out) so the representation rules are
 * directly unit-testable — the live golden run exercises this code only when
 * the host's npm happens to emit `{}` optional nodes, which the canonical
 * 11.16.0 proof host does not: without a pinned unit test the 11.19 fix
 * could silently regress and CI would stay green.
 *
 * Completeness rules (round-3 blocker 6 — the old code silently turned
 * missing versions into an `'x'` sentinel and stayed VALID):
 *  - a node whose `version` is absent/non-string (npm's `{"missing":true}`
 *    unmet-dependency shape, malformed entries) => anomaly `missing-version`
 *    AND, if it carries a declared subtree, `unwalked-subtree` (its real
 *    descendants are NOT observable through it) — observation INCOMPLETE;
 *  - `dependencies` present but not an object => anomaly `malformed-node`;
 *  - traversal beyond MAX_TREE_NODES / MAX_TREE_DEPTH => *budget-exceeded
 *    anomalies (partial observation, INCOMPLETE; post-sol secondary).
 *
 * npm >= 11.19 renders NOT-INSTALLED OPTIONAL dependencies (fsevents on
 * win32, ws's native bufferutil/utf-8-validate, …) as EMPTY `{}` nodes —
 * probe-verified ground truth. An uninstalled REQUIRED dep NEVER renders
 * `{}`: it carries missing:true plus a root `problems` array and an
 * ELSPROBLEMS line on stderr. The narrowest evidence-supported exemption
 * (post-sol M-2; mirrored deliberately differently in verify-tree's
 * iterative re-flatten, pinned by the parity suite):
 *   a zero-key node is an expected-absent optional ONLY when
 *   (1) the document's `problems` channel is WELL-FORMED (absent, or an
 *       array containing nothing but strings; anything else is a
 *       `malformed-problems` anomaly and the name-silence check cannot be
 *       trusted),
 *   (2) the error channel is not CONTRADICTED: an ELSPROBLEMS line in the
 *       retained stderr demands a non-empty problems array (stderr screaming
 *       errors over a JSON that reports none is a stripped-channel forgery).
 *       The converse does NOT hold — self-review R4-SR1 probe: npm's
 *       extraneous-only trees list `problems: ["extraneous: …"]` while
 *       exiting 0 with an EMPTY stderr, so silent-stderr-with-problems is
 *       a genuine complete observation and must not be punished, and
 *   (3) no problems entry token-anchors the package name.
 * Anything else version-less stays an anomaly — uninstalled required deps
 * (missing:true / mentions) and partial or contradictory observations all
 * fail closed. The residual gap — bytes forged consistently across BOTH
 * channels — is the documented integrity-only ceiling, not a new trust
 * surface: the studied dependency can never be excused INTO presence
 * (a `{}` dep is absence => INCOMPLETE), and the committed proof pins the
 * summary counts the tree is claimed alongside.
 */
export function flattenNpmLsJson(rawStdout: string, rawStderr = ''): NpmLsFlatten {
  const parseAnomalies: string[] = [];
  let data: { dependencies?: Record<string, { version?: unknown; dependencies?: unknown; missing?: unknown }>; problems?: unknown };
  let parsed = false;
  try {
    data = JSON.parse(rawStdout) as typeof data;
    parsed = !!data && typeof data === 'object';
    if (!parsed) parseAnomalies.push('json-root-not-an-object');
  } catch {
    parsed = false;
    data = {} as typeof data;
    parseAnomalies.push('json-parse-failure');
  }
  // Parity with verify-tree's re-flatten (self-review N2): the verifier
  // records parse failures IN ITS ANOMALY SET, and verifyArm compares the two
  // sets for equality. Without these markers, an honestly-broken arm (garbage
  // npm ls output => INCONCLUSIVE rule 10) would mismatch on
  // [] vs ['json-parse-failure'] and prove would REFUSE the truthful bundle.
  // The status is INVALID either way (parsed=false); only the vocabulary was
  // missing. Successful parses carry no marker, so golden hashes are
  // unaffected.
  const channelAnomalies: string[] = [];
  let exemptionAllowed = parsed; // post-sol M-2: only for a corroborated doc
  if (parsed && data.problems !== undefined) {
    const okArray = Array.isArray(data.problems) && (data.problems as unknown[]).every((x) => typeof x === 'string');
    if (!okArray) {
      // The mention scan cannot be trusted over a channel npm never emits
      // this way (a STRING problems field was the post-sol differential
      // between the two parsers — unified here, fail closed).
      channelAnomalies.push('malformed-problems');
      exemptionAllowed = false;
    } else if ((data.problems as string[]).length === 0 && /ELSPROBLEMS/.test(rawStderr)) {
      // Only the ERROR-channel-loud + REPORT-channel-silent direction is a
      // contradiction: npm's extraneous-only trees carry non-empty problems
      // with a silent stderr BY DESIGN (R4-SR1 probe-verified).
      channelAnomalies.push('problems-stderr-contradiction');
      exemptionAllowed = false;
    }
  } else if (parsed && /ELSPROBLEMS/.test(rawStderr)) {
    // problems channel silent but stderr says the tree has problems:
    // contradiction (the stripped-`problems` forgery shape from post-sol M-2).
    channelAnomalies.push('problems-stderr-contradiction');
    exemptionAllowed = false;
  }
  const problemsLines: string[] = parsed && Array.isArray(data.problems)
    ? (data.problems as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const mentionedInProblems = (name: string): boolean => {
    const needle = `${name}@`;
    for (const line of problemsLines) {
      for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + 1)) {
        if (i === 0 || !/[A-Za-z0-9@/\\.-]/.test(line[i - 1]!)) return true;
      }
    }
    return false;
  };
  const expectedAbsentOptional = (name: string, v: { version?: unknown; dependencies?: unknown; missing?: unknown } | null): boolean =>
    exemptionAllowed && v !== null && v.missing !== true && Object.keys(v).length === 0 && !mentionedInProblems(name);
  const jsonAnomalies: string[] = [...parseAnomalies, ...channelAnomalies];
  const flat: DepTree = {};
  let visited = 0;
  let budgetHit = false;
  const walk = (node: { dependencies?: Record<string, unknown> }, prefix: string, depth: number): void => {
    for (const [k, vRaw] of Object.entries(node.dependencies ?? {})) {
      if (budgetHit) return;
      if (++visited > MAX_TREE_NODES || depth >= MAX_TREE_DEPTH) {
        budgetHit = true;
        jsonAnomalies.push(visited > MAX_TREE_NODES ? 'traversal-budget-exceeded' : 'depth-budget-exceeded');
        return;
      }
      // F4: escape '/' in (scoped) package names so raw '/' only ever means nesting.
      const key = `${prefix}${escapePkgKey(k)}`;
      const v = (typeof vRaw === 'object' && vRaw !== null) ? vRaw as { version?: unknown; dependencies?: unknown; missing?: unknown } : null;
      if (v === null) jsonAnomalies.push(`malformed-node:${key}`);
      const hasVersion = typeof v?.version === 'string' && (v?.version as string) !== '';
      if (hasVersion) flat[key] = v!.version as string;
      else if (expectedAbsentOptional(k, v)) { /* intentionally absent optional: no version to record, no hole */ }
      else jsonAnomalies.push(`missing-version:${key}`);
      const sub = v?.dependencies;
      if (sub === undefined || sub === null) continue;
      if (typeof sub !== 'object') { jsonAnomalies.push(`malformed-node:${key}`); continue; }
      if (hasVersion) {
        walk({ dependencies: sub as Record<string, unknown> }, `${key}/`, depth + 1);
      } else if (Object.keys(sub as object).length > 0) {
        // A version-less node is NOT walked: its subtree inherits the
        // missing-version anomaly, so trust caps at INCOMPLETE.
        jsonAnomalies.push(`unwalked-subtree:${key}`);
      }
    }
  };
  if (parsed) walk(data as { dependencies?: Record<string, unknown> }, '', 0);
  jsonAnomalies.sort();
  const hasRootDeps = parsed && !!data.dependencies && typeof data.dependencies === 'object';
  return { parsed, hasRootDeps, flat, jsonAnomalies: [...new Set(jsonAnomalies)].sort() };
}

async function treeHash(
  ws: WorkspaceLayout, dependency: string, artifactsDir: string, arm: 'baseline' | 'candidate',
): Promise<TreeObservation> {
  // post-glm F6e: same re-establish contract as the executor install path —
  // at the moment npm reads it, the userconfig must be Canary's empty file,
  // not whatever workspace-writable code left there since creation.
  fs.writeFileSync(path.join(ws.root, 'empty.npmrc'), '');
  const r = await runCommand({
    ws, nodeDir: NODE_DIR,
    argv: [NODE, NPM_CLI, 'ls', '--json', '--all', '--depth', '9999',
      '--userconfig', path.join(ws.root, 'empty.npmrc')],
    timeoutSecs: 120,
  });
  const { parsed, hasRootDeps, flat, jsonAnomalies } = flattenNpmLsJson(r.stdout, r.stderr);
  const sortedKeys = Object.keys(flat).sort();
  const canonical = JSON.stringify(sortedKeys.map((k) => [k, flat[k]]));
  // Audit B6: classify the OBSERVATION itself. A vacuous/empty tree, one
  // missing the studied dependency, or one carrying ANY partial-observation
  // anomaly cannot support a confinement proof (round-3 blocker 6).
  const status = classifyTreeObservation({
    parsed,
    hasRootDeps,
    deps: flat,
    dependencyPresent: parsed && dependencyInTree(flat, dependency),
    anomalies: jsonAnomalies,
  });

  // Retain the SNAPSHOT — raw bytes + canonical flatten — as first-class
  // artifacts. Canonical filenames are derived from the arm (audit B3
  // lesson: never let evidence name its own bytes).
  const snapshot: TreeSnapshotRef = {
    rawStdoutLog: `tree-${arm}.treels.raw.log`,
    rawStdoutSha256: sha256hex(r.stdout),
    rawStderrLog: `tree-${arm}.treels.stderr.log`,
    rawStderrSha256: sha256hex(r.stderr),
    canonicalLog: `tree-${arm}.treels.canonical.json`,
    canonicalSha256: sha256hex(canonical),
  };
  fs.writeFileSync(path.join(artifactsDir, snapshot.rawStdoutLog), r.stdout);
  fs.writeFileSync(path.join(artifactsDir, snapshot.rawStderrLog), r.stderr);
  fs.writeFileSync(path.join(artifactsDir, snapshot.canonicalLog), canonical);
  return { hash: sha256hex(canonical), deps: flat, status, jsonAnomalies, copies: countDependencyCopies(flat, dependency), snapshot };
}

/** Count dependency copies from the flattened logical tree.
 *  NOTE (kept deliberately conservative): this counts LOGICAL positions from
 *  `npm ls`, not physical node_modules locations — hoisting makes the two
 *  differ structurally; the logical count is what drift keys address. */
function countDependencyCopies(deps: DepTree, dep: string): number {
  const esc = escapePkgKey(dep);
  return Object.keys(deps).filter((k) => k.split('/').pop() === esc).length;
}
