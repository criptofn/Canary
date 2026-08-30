#!/usr/bin/env node
/**
 * Canary experiment runner v2 — spec-driven, security-contracted,
 * evidence-producing. Seed of the full pipeline (apps/cli will wrap this).
 *
 *   node scripts/run-experiment.mjs <spec.json> [--relabel <artifactsDir>]
 *
 * Exit: 0 CONFIRMED_REGRESSION · 1 PASS · 2 other classification · 3 misuse
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand, sanitizedEnv } from '../packages/support/dist/src/index.js';
import { buildPipeline, machineRules, normalize, DEFAULT_RULE_NAMES } from '../packages/evidence/normalizers/dist/src/index.js';
import { sha256hex } from '../packages/evidence/hashing/dist/src/index.js';
import { classify } from '../packages/core/classification/dist/src/index.js';
import { validateBundle, EVIDENCE_SCHEMA_VERSION } from '../packages/evidence/schema/dist/src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);
const NPM_CLI = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const SYSTEMROOT = process.env.SystemRoot ?? 'C:\\WINDOWS';
const YARN_PIN = 'yarn@1.22.22';
const CANARY_VERSION = '0.1.0';

const RUNNER_SUMMARY = /\b\d+ (?:tests? )?(?:passed|failed|passing|failing)\b/i;
const INFRA_PATTERNS = [
  /ERR_MODULE_NOT_FOUND/, /Cannot find module/, /ReferenceError: require is not defined/,
  /ERESOLVE/, /ETARGET/, /npm error code/, /error Command failed/,
  /ERR_REQUIRE_ESM/, /SyntaxError: Unexpected token/,
];

// ------------------------------------------------------------------ argv

const specArg = process.argv[2];
if (!specArg) { console.error('usage: run-experiment.mjs <spec.json>'); process.exit(3); }
const spec = JSON.parse(fs.readFileSync(specArg, 'utf8'));

const WS = path.join(REPO_ROOT, '.canary-runs',
  `exp-${spec.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const FIXTURE = path.join(WS, 'fixture');
const ART = path.join(WS, 'artifacts');
for (const d of [ART, FIXTURE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(WS, 'empty.npmrc'), '');

const wsLayout = { root: WS, fixture: FIXTURE };

// ------------------------------------------------------------------ helpers

function npmArgs(cmd) {
  // spec argv tokens: $npm / $yarn / $tsc / $bin:pkg[/key]
  const expand = (t) => {
    t = t.replaceAll('{dep}', spec.dependency.package)
         .replaceAll('{candidate}', spec.dependency.candidate)
         .replaceAll('{baseline}', spec.dependency.baseline);
    if (t === '$npm') return [NODE, NPM_CLI];
    if (t === '$yarn') return [NODE, NPM_CLI, 'exec', '--yes', '--package', YARN_PIN, '--', 'yarn'];
    if (t === '$tsc') return [NODE, resolveBin('typescript', 'tsc')];
    if (t.startsWith('$bin:')) {
      const s = t.slice(5);
      const i = s.lastIndexOf('/');
      return [NODE, i === -1 ? resolveBin(s) : resolveBin(s.slice(0, i), s.slice(i + 1))];
    }
    return [t];
  };
  const argv = cmd.flatMap(expand);
  const isInstall = cmd[0].match(/^\$(npm|yarn)$/) && ['install', 'i'].includes(cmd[1]);
  if (isInstall) {
    argv.push('--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps',
      '--userconfig', path.join(WS, 'empty.npmrc'), '--cache', path.join(WS, 'npm-cache'));
    if (cmd[0] === '$yarn') argv.push('--cache-folder', path.join(WS, 'yarn-cache'));
  }
  return argv;
}

function resolveBin(pkg, key) {
  const pj = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'node_modules', pkg, 'package.json'), 'utf8'));
  const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[key ?? pkg.split('/').pop()];
  if (!rel) throw new Error(`no bin for ${pkg}`);
  const abs = path.join(FIXTURE, 'node_modules', pkg, rel);
  if (!fs.existsSync(abs)) throw new Error(`bin missing: ${abs}`);
  return abs;
}

const roundFacts = [];
let startedAt;

const MACHINE = machineRules({
  tempDir: os.tmpdir(),
  homeDir: path.join(WS, 'isolated-home'),
  user: '',
  host: '',
  workspaceRoot: WS,
});
const PIPELINE = buildPipeline(DEFAULT_RULE_NAMES, MACHINE);

const labelCounts = new Map();
function execOne(label, cmd, timeoutSecs) {
  const seen = (labelCounts.get(label) ?? 0) + 1;
  labelCounts.set(label, seen);
  const uniq = seen === 1 ? label : `${label}-${seen}`;
  const argv = npmArgs(cmd);
  console.log(`  $ ${uniq}: ${cmd.join(' ')}`);
  const r = runCommand({ ws: wsLayout, nodeDir: NODE_DIR, argv, timeoutSecs: timeoutSecs ?? 600 });
  const out = r.stdout + r.stderr;
  fs.writeFileSync(path.join(ART, `${uniq}.stdout.log`), r.stdout);
  fs.writeFileSync(path.join(ART, `${uniq}.stderr.log`), r.stderr);
  const normOut = normalize(r.stdout, PIPELINE);
  const normErr = normalize(r.stderr, PIPELINE);
  fs.writeFileSync(path.join(ART, `${uniq}.stdout.norm`), normOut);
  fs.writeFileSync(path.join(ART, `${uniq}.stderr.norm`), normErr);
  return { r, out, normOut, normErr, label: uniq };
}

function recordTestRound(label, arm, round, res) {
  const { r, out, normOut, normErr } = res;
  roundFacts.push({
    arm, round,
    exitCode: r.exitCode,
    hasRunnerSummary: RUNNER_SUMMARY.test(out),
    infraSignal: r.exitCode !== 0 && INFRA_PATTERNS.some((p) => p.test(out)),
  });
  return {
    arm, round,
    exitCode: r.exitCode,
    killedByTimeout: r.killedByTimeout,
    hasRunnerSummary: RUNNER_SUMMARY.test(out),
    startedAt: new Date().toISOString(),
    durationMs: r.durationMs,
    rawStdoutSha256: sha256hex(r.stdout),
    rawStderrSha256: sha256hex(r.stderr),
    normalizedStdoutSha256: sha256hex(normOut),
    normalizedStderrSha256: sha256hex(normErr),
    logPath: `${res.label}.stdout.log`,
    argv: r.argv,
    envKeys: r.envKeys,
  };
}

function treeHash() {
  // Deterministic fingerprint of installed direct+transitive versions.
  const ls = runCommand({
    ws: wsLayout, nodeDir: NODE_DIR,
    argv: [NODE, NPM_CLI, 'ls', '--json', '--all', '--depth', '9999',
      '--userconfig', path.join(WS, 'empty.npmrc')],
    timeoutSecs: 120,
  });
  let data;
  try { data = JSON.parse(ls.stdout); } catch { return { hash: 'invalid', deps: null }; }
  const flat = {};
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node.dependencies ?? {})) {
      flat[`${prefix}${k}`] = v.version ?? 'x';
      if (v.dependencies) walk(v, `${prefix}${k}/`);
    }
  };
  walk(data, '');
  return { hash: sha256hex(JSON.stringify(flat, Object.keys(flat).sort())), deps: flat };
}

// ------------------------------------------------------------------ main

async function main() {
  startedAt = new Date().toISOString();
  console.log(`workspace: ${WS}\n`);

  // [1] fetch pinned content
  const { repo, commit } = spec.downstream;
  const url = `https://codeload.github.com/${repo}/tar.gz/${commit}`;
  console.log(`[1] fetch ${repo} @ ${commit.slice(0, 10)} (tarball by SHA)`);
  const fetchRes = await fetch(url, { redirect: 'follow' });
  if (!fetchRes.ok) throw new Error(`download failed HTTP ${fetchRes.status}`);
  const buf = Buffer.from(await fetchRes.arrayBuffer());
  const tgz = path.join(WS, 'fixture.tgz');
  fs.writeFileSync(tgz, buf);
  const tarballSha = sha256hex(buf);
  console.log(`  ${(buf.length / 1024) | 0} KiB sha256=${tarballSha.slice(0, 16)}...`);
  spawnSync(path.join(SYSTEMROOT, 'System32', 'tar.exe'), ['-xzf', tgz, '-C', WS],
    { env: sanitizedEnv({ ws: wsLayout, nodeDir: NODE_DIR }), shell: false, timeout: 180_000 });
  const proj = repo.split('/')[1];
  const root = fs.readdirSync(WS).find((d) => d.startsWith(proj + '-') && d.includes(commit.slice(0, 7)));
  if (!root) throw new Error('extracted dir not found');
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  fs.renameSync(path.join(WS, root), FIXTURE);

  // [2] static pre-execution audit (security contract: no lifecycle hooks,
  // no project-level npmrc/yarnrc — those could redirect registries and
  // bypass the sanitized-env boundary by injecting auth or mirrors)
  console.log('[2] pre-execution audit');
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'));
  const hooks = ['preinstall', 'install', 'postinstall', 'prepare'].filter((h) => pkg.scripts?.[h]);
  if (hooks.length) throw new Error(`lifecycle-hook-present, refusing: ${hooks.join(',')}`);
  for (const banned of ['.npmrc', '.yarnrc', '.yarnrc.yml']) {
    if (fs.existsSync(path.join(FIXTURE, banned))) {
      throw new Error(`config-file-injection-risk, refusing: fixture contains ${banned}`);
    }
  }
  console.log(`  ${pkg.name}@${pkg.version}; declared ${spec.dependency.package}=${pkg.dependencies?.[spec.dependency.package] ?? pkg.devDependencies?.[spec.dependency.package] ?? 'none'}; hooks none; rc-injection none`);

  // [3] prepare: era tree + toolchain overrides (recorded, identical for both arms)
  console.log('[3] prepare');
  for (const cmd of spec.commands.prepare) {
    if (execOne('prepare', cmd, 900).r.exitCode !== 0) return fail('prepare failed', 'INFRASTRUCTURE_FAILURE');
  }
  for (const cmd of (spec.commands.toolchainOverrides ?? [])) {
    console.log('  toolchain override:');
    if (execOne('toolchain', cmd, 900).r.exitCode !== 0) return fail('toolchain override failed', 'INFRASTRUCTURE_FAILURE');
  }
  const treeB = treeHash();

  // [4] build once (baseline contracts)
  for (const cmd of (spec.commands.build ?? [])) {
    if (execOne('build', cmd, 600).r.exitCode !== 0) return fail('build failed under baseline', 'INFRASTRUCTURE_FAILURE');
  }

  // [5] baseline rounds
  console.log(`[5] baseline arm x${spec.repeats.baseline}`);
  const baselineRounds = [];
  for (let i = 1; i <= spec.repeats.baseline; i++) {
    baselineRounds.push(recordTestRound(`baseline-${i}`, 'baseline', i,
      execOne(`baseline-${i}`, spec.commands.test, spec.timeoutSecs?.test ?? 600)));
  }

  // [6] swap candidate ONLY
  console.log('[6] candidate swap');
  if (execOne('swap', spec.commands.swap, 900).r.exitCode !== 0) return fail('swap failed', 'INFRASTRUCTURE_FAILURE');
  const actualVer = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'node_modules', spec.dependency.package, 'package.json'), 'utf8')).version;
  console.log(`  installed ${spec.dependency.package}@${actualVer} (expected ${spec.dependency.candidate})`);
  if (actualVer !== spec.dependency.candidate) return fail('candidate version mismatch', 'INFRASTRUCTURE_FAILURE');
  const treeC = treeHash();
  const drift = diffTrees(treeB.deps, treeC.deps);
  console.log(`  tree drift: ${drift.confined ? 'confined to dependency subtree' : 'NOT confined — ' + drift.other.slice(0, 8).join(', ')}`);

  // [7] candidate rounds
  console.log(`[7] candidate arm x${spec.repeats.candidate}`);
  const candidateRounds = [];
  for (let i = 1; i <= spec.repeats.candidate; i++) {
    candidateRounds.push(recordTestRound(`candidate-${i}`, 'candidate', i,
      execOne(`candidate-${i}`, spec.commands.test, spec.timeoutSecs?.test ?? 600)));
  }

  // [8] classification + evidence
  const cls = classify(roundFacts);
  const bundle = {
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
      tarballSha256: tarballSha,
    },
    environment: {
      nodeVersion: process.version,
      npmVersion: versionOf('npm'),
      packageManagerUsed: String(spec.commands.prepare[0]?.[0] ?? 'npm'),
      platform: process.platform,
      arch: process.arch,
      toolchainOverrides: spec.environmentNotes?.toolchainOverrides ?? {},
    },
    commands: {
      prepare: spec.commands.prepare,
      build: spec.commands.build ?? [],
      swap: spec.commands.swap,
      test: spec.commands.test,
    },
    rounds: [...baselineRounds, ...candidateRounds],
    treeComparison: {
      baselineTreeSha256: treeB.hash,
      candidateTreeSha256: treeC.hash,
      driftConfinedToDependency: drift.confined,
    },
    classification: {
      label: cls.classification,
      rule: cls.rule,
      reason: cls.reason,
      reproductionCount: cls.details.candidateRuns,
    },
  };
  const issues = validateBundle(bundle);
  if (issues.length) console.error('bundle validation issues:', issues);
  fs.writeFileSync(path.join(ART, 'evidence.json'), JSON.stringify(bundle, null, 2));
  fs.writeFileSync(path.join(ART, 'tree-drift.json'), JSON.stringify(drift, null, 2));
  // Pointer for the prove step (machine-local convenience artifact).
  fs.writeFileSync(path.join(REPO_ROOT, '.canary-runs', `latest-${spec.id}.json`),
    JSON.stringify({ evidence: path.join(ART, 'evidence.json'), workspace: WS }, null, 2));

  console.log('\n' + '='.repeat(66));
  console.log(`EXPERIMENT ${spec.id}: ${cls.classification} (rule ${cls.rule})`);
  console.log(`  ${cls.reason}`);
  console.log(`  tree drift confined to ${spec.dependency.package}: ${drift.confined}`);
  console.log(`  bundle valid: ${issues.length === 0} -> ${path.join(ART, 'evidence.json')}`);
  console.log('='.repeat(66));
  process.exit(cls.classification === 'CONFIRMED_REGRESSION' ? 0 : cls.classification === 'PASS' ? 1 : 2);
}

function versionOf() {
  const r = runCommand({ ws: wsLayout, nodeDir: NODE_DIR, argv: [NODE, NPM_CLI, '--version'], timeoutSecs: 60 });
  return r.stdout.trim();
}

function fail(reason, label) {
  console.log(`\nEXPERIMENT ${spec.id}: ${label} — ${reason}`);
  process.exit(2);
}

function diffTrees(a, b) {
  if (!a || !b) return { confined: false, other: ['<tree unavailable>'], changed: [] };
  const changed = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    if (a[k] !== b[k]) changed.push({ pkg: k, from: a[k] ?? 'absent', to: b[k] ?? 'absent' });
  }
  const prefix = spec.dependency.package;
  const other = changed.filter((c) => c.pkg !== prefix && !c.pkg.startsWith(prefix + '/')).map((c) => c.pkg);
  return { confined: other.length === 0, other, changed: changed.length, detail: changed.slice(0, 40) };
}

main().catch((e) => { console.error('CRASHED:', e); process.exit(3); });
