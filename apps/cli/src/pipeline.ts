/**
 * The experiment pipeline — TS port of the proven scripts/run-experiment.mjs.
 * Golden proof assertions (fixtures/.../prove) are the equivalence oracle.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand, sanitizedEnv, type WorkspaceLayout } from '@canary-rn/support';
import { validateSpec, type ExperimentSpec } from '@canary-rn/planner';
import { auditFixtureDir, expectedExtractedDir } from '@canary-rn/workspace';
import { downloadTarball } from '@canary-rn/github';
import { staticFingerprint, withNpmVersion } from '@canary-rn/environment';
import { Recorder, type ExecResult } from '@canary-rn/executor';
import { buildPipeline, machineRules, DEFAULT_RULE_NAMES } from '@canary-rn/normalizers';
import { diffTrees, escapePkgKey, extractFailingTestNames, parseSummaryCounts, type DepTree } from '@canary-rn/comparator';
import { classify, type RoundFact } from '@canary-rn/classification';
import { EVIDENCE_SCHEMA_VERSION, validateBundle, type EvidenceBundle, type RoundEvidence } from '@canary-rn/evidence-schema';
import { sha256hex } from '@canary-rn/hashing';

const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);
const NPM_CLI = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const SYSTEMROOT = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
export const CANARY_VERSION = '0.1.0';

export interface PipelineResult {
  bundle: EvidenceBundle;
  workspace: string;
  artifactsDir: string;
  failingTestNames: string[];
  summaryCounts: ReturnType<typeof parseSummaryCounts>;
  bundleIssues: string[];
}

export async function runExperiment(specRaw: unknown, repoRoot: string, quiet = false): Promise<PipelineResult> {
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
  const rec = new Recorder({
    ws, nodeDir: NODE_DIR, npmCli: NPM_CLI, artifactsDir: ART, pipeline,
  });
  const subs = { dep: spec.dependency.package, baseline: spec.dependency.baseline, candidate: spec.dependency.candidate };
  const execArgv = (cmd: readonly string[]): string[] => rec.expandArgv(cmd, subs, resolveBin);

  // [1] fetch pinned content
  const { repo, commit } = spec.downstream;
  log(`[1] fetch ${repo} @ ${commit.slice(0, 10)} (tarball by SHA)`);
  const blob = await downloadTarball(repo, commit);
  const tgz = path.join(WS, 'fixture.tgz');
  fs.writeFileSync(tgz, blob.bytes);
  log(`  ${Math.round(blob.bytes.length / 1024)} KiB sha256=${blob.sha256.slice(0, 16)}...`);
  const tr = spawnSync(path.join(SYSTEMROOT, 'System32', 'tar.exe'), ['-xzf', tgz, '-C', WS],
    { env: sanitizedEnv({ ws, nodeDir: NODE_DIR }), shell: false, timeout: 180_000 });
  if (tr.status !== 0) throw new Error('tar extraction failed');
  const want = expectedExtractedDir(repo, commit);
  const root = fs.readdirSync(WS).find((d) => d === want || (d.startsWith(`${repo.split('/')[1] ?? ''}-`) && d.includes(commit.slice(0, 7))));
  if (!root) throw new Error(`extracted dir not found (wanted ${want})`);
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  fs.renameSync(path.join(WS, root), FIXTURE);

  // [2] security gate before anything external executes
  log('[2] pre-execution audit');
  const audit = auditFixtureDir(FIXTURE, spec.dependency.package);
  if (!audit.ok) {
    throw new Error(`audit refused: ${audit.violations.map((v) => `${v.code}: ${v.detail}`).join('; ')}`);
  }
  log(`  ${audit.package.name}@${audit.package.version}; declared ${spec.dependency.package}=${audit.declaredDependency ?? 'none'}; hooks/rc clean`);

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
  const treeB = await treeHash(ws);
  const attB = await attestDependency(ws, spec.dependency.package);
  attB.copies = countDependencyCopies(treeB.deps, spec.dependency.package);
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
    const r = await rec.round('baseline', i, execArgv(spec.commands.test), spec.timeoutSecs?.test ?? 600);
    baseEv.push(roundEvidence(r));
  }

  // [6] swap candidate
  log('[6] candidate swap');
  if ((await rec.step('swap', execArgv(spec.commands.swap), spec.timeoutSecs?.install ?? 900)).run.exitCode !== 0) {
    throw new InfraAbort('swap failed');
  }
  const attC = await attestDependency(ws, spec.dependency.package);
  log(`  attested candidate: ${spec.dependency.package}@${attC.version} (${attC.copies} copy/copies)`);
  if (attC.version !== spec.dependency.candidate) {
    throw new InfraAbort(`candidate attestation failed: resolved ${attC.version}, spec claims ${spec.dependency.candidate}`);
  }
  const treeC = await treeHash(ws);
  attC.copies = countDependencyCopies(treeC.deps, spec.dependency.package);
  const drift = diffTrees(treeB.deps, treeC.deps, spec.dependency.package);
  log(`  tree drift: ${drift.confined ? 'confined to dependency subtree' : `NOT confined (${drift.other.slice(0, 8).join(', ')})`}`);

  // [7] candidate arm
  log(`[7] candidate arm x${spec.repeats.candidate}`);
  const candEv: RoundEvidence[] = [];
  let firstCand: (ExecResult & { fact: RoundFact }) | undefined;
  for (let i = 1; i <= spec.repeats.candidate; i++) {
    const r = await rec.round('candidate', i, execArgv(spec.commands.test), spec.timeoutSecs?.test ?? 600);
    candEv.push(roundEvidence(r));
    firstCand ??= r;
  }

  // [8] classify + bundle
  let cls = classify(rec.facts);
  // F4: confinement is ENFORCED, not decorative — incomparable arms cannot
  // yield a verdict (rule 9 = pipeline-level guard outside the decision table).
  if (!drift.confined && cls.classification !== 'INFRASTRUCTURE_FAILURE') {
    cls = {
      ...cls,
      classification: 'INCONCLUSIVE',
      rule: 9,
      reason: `tree drift outside ${spec.dependency.package} subtree (${drift.other.slice(0, 6).join(', ')}) — arms not comparable`,
    };
  }
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
      resolvedVersions: { baseline: attB.version, candidate: attC.version },
      dependencyCopies: { baseline: attB.copies, candidate: attC.copies },
    },
    classification: {
      label: cls.classification,
      rule: cls.rule,
      reason: cls.reason,
      reproductionCount: cls.details.candidateRuns,
    },
  };

  const bundleIssues = validateBundle(bundle);
  fs.writeFileSync(path.join(ART, 'evidence.json'), JSON.stringify(bundle, null, 2));
  fs.writeFileSync(path.join(ART, 'tree-drift.json'), JSON.stringify(drift, null, 2));
  fs.writeFileSync(path.join(repoRoot, '.canary-runs', `latest-${spec.id}.json`),
    JSON.stringify({ evidence: path.join(ART, 'evidence.json'), workspace: WS }, null, 2));

  const failingTestNames = extractFailingTestNames(firstCand?.combined ?? '');
  const summaryCounts = parseSummaryCounts(firstCand?.combined ?? '');
  log(`\nEXPERIMENT ${spec.id}: ${cls.classification} (rule ${cls.rule}) — ${cls.reason}`);
  return { bundle, workspace: WS, artifactsDir: ART, failingTestNames, summaryCounts, bundleIssues };

  function roundEvidence(r: ExecResult & { fact: RoundFact }): RoundEvidence {
    const f = r.fact;
    return {
      arm: f.arm, round: f.round, exitCode: f.exitCode,
      killedByTimeout: r.run.killedByTimeout,
      hasRunnerSummary: f.hasRunnerSummary,
      startedAt: new Date().toISOString(),
      durationMs: r.run.durationMs,
      rawStdoutSha256: sha256hex(r.run.stdout),
      rawStderrSha256: sha256hex(r.run.stderr),
      normalizedStdoutSha256: sha256hex(r.normOut),
      normalizedStderrSha256: sha256hex(r.normErr),
      logPath: `${r.label}.stdout.log`,
      argv: [...r.run.argv],
      envKeys: [...r.run.envKeys],
    };
  }
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

async function treeHash(ws: WorkspaceLayout): Promise<{ hash: string; deps: DepTree }> {
  const r = await runCommand({
    ws, nodeDir: NODE_DIR,
    argv: [NODE, NPM_CLI, 'ls', '--json', '--all', '--depth', '9999',
      '--userconfig', path.join(ws.root, 'empty.npmrc')],
    timeoutSecs: 120,
  });
  let data: { dependencies?: Record<string, { version?: string; dependencies?: unknown }> };
  try {
    data = JSON.parse(r.stdout) as typeof data;
  } catch {
    return { hash: 'invalid', deps: {} };
  }
  const flat: DepTree = {};
  const walk = (node: { dependencies?: Record<string, { version?: string; dependencies?: unknown }> }, prefix: string): void => {
    for (const [k, v] of Object.entries(node.dependencies ?? {})) {
      // F4: escape '/' in (scoped) package names so raw '/' only ever means nesting.
      flat[`${prefix}${escapePkgKey(k)}`] = v.version ?? 'x';
      if (v.dependencies) walk(v as never, `${prefix}${escapePkgKey(k)}/`);
    }
  };
  walk(data, '');
  const sortedKeys = Object.keys(flat).sort();
  const canonical = JSON.stringify(sortedKeys.map((k) => [k, flat[k]]));
  return { hash: sha256hex(canonical), deps: flat };
}

function countDependencyCopies(deps: DepTree, dep: string): number {
  const esc = escapePkgKey(dep);
  return Object.keys(deps).filter((k) => k.split('/').pop() === esc).length;
}
