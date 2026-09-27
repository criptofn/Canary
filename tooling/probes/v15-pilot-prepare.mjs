#!/usr/bin/env node
/** Create twelve solution-blind pilot copies and run their no-model setup checks. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const outRoot = path.resolve(arg('out') ?? '.');
const worktree = path.resolve(arg('worktree') ?? path.resolve(import.meta.dirname, '../..'));
const scratchRoot = path.resolve(arg('scratch-root') ?? 'C:\\Users\\Johannes\\AppData\\Local\\Temp\\canary-v15-baselines-20260927');
const cli = path.resolve(arg('cli') ?? '');
const artifact = arg('artifact-sha256', 'cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386');
const timeoutMs = Number(arg('timeout-ms', '1800000'));
const taskRoot = path.join(worktree, 'tooling/benchmark/results/session-evidence/v15-realworld/tasks');
const taskRunner = path.join(worktree, 'tooling/probes/v15-release-validation-task.mjs');
const labels = {
  H1: { base: '7d0eb49c46d83184638fa093b44a15222feb8c51', candidate: 'e6ed172dc22861b90487b3392b859542d53f8d30', task: 'H1-maxagedays-zero.md' },
  H2: { base: '4f35b9c51d787b3a2f05c91a2ae0c8377a2b5840', candidate: '9bf544223ac7fabecd533a2b9c4af35b764efc08', task: 'H2-invoice-classification.md' },
  H3: { base: '7d0eb49c46d83184638fa093b44a15222feb8c51', candidate: '560307cedbb2efc33104799fcfb42ee62ffa3824', task: 'H3-quantize-bits-validation.md' },
  H5: { base: '4f35b9c51d787b3a2f05c91a2ae0c8377a2b5840', candidate: '21696b29dec8b514d66367095549d504c06160b6', task: 'H5-simulation-cases.md' },
  R1: { base: '1fe40d8505bbb0cac703c976401c17213abf1e9d', candidate: 'd906039823003ce78b089b377d732e7d3aab1702', task: 'R1-pytest-id-collision.md' },
  S1: { base: '4255fa14049b479b479be1148df20bf0d097926c', candidate: '1663020d827895019b79e5c1b0b59972feaaff83', task: 'S1-idlookup-ambiguity.md' },
};
const python = 'C:\\Users\\Johannes\\Desktop\\canary-ws5-scratch\\python311';
const gradleBin = 'C:\\Users\\Johannes\\.gradle\\wrapper\\dists\\gradle-8.13-bin\\5xuhj0ry160q40clulazy9h7d\\gradle-8.13\\bin';
const javaBin = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot\\bin';
const gitCmd = 'C:\\Program Files\\Git\\cmd';
const gitUsr = 'C:\\Program Files\\Git\\usr\\bin';
function toolchains(label) {
  if (label === 'R1') return [python, path.join(python, 'Scripts'), gitCmd, gitUsr];
  if (label === 'S1') return [gradleBin, javaBin];
  return [];
}
function validateToolchains(label) {
  const dirs = toolchains(label);
  return dirs.flatMap((dir) => ['--toolchain-dir', dir]);
}
function run(executable, args, cwd, timeout = timeoutMs) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}
function git(repo, ...args) { return run('git', ['-C', repo, ...args], worktree, 60_000); }
function gitOut(repo, ...args) {
  const r = git(repo, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${repo} failed: ${r.stdout ?? ''}${r.stderr ?? ''}`);
  return (r.stdout ?? '').trim();
}
function makeShallowRepo(label, arm) {
  const target = path.join(outRoot, 'projects', label, arm);
  fs.mkdirSync(target, { recursive: true });
  const originlessSource = path.join(scratchRoot, label);
  const baseline = labels[label].base;
  let r = run('git', ['init', '--initial-branch=pilot-base', target], worktree, 60_000);
  if (r.status !== 0) throw new Error(`git init ${target}: ${r.stdout}${r.stderr}`);
  r = run('git', ['-C', target, 'fetch', '--depth=1', originlessSource, baseline], worktree, 120_000);
  if (r.status !== 0) throw new Error(`git fetch exact baseline ${label}: ${r.stdout}${r.stderr}`);
  r = git(target, 'reset', '--hard', 'FETCH_HEAD');
  if (r.status !== 0) throw new Error(`checkout exact baseline ${label}: ${r.stdout}${r.stderr}`);
  for (const [key, value] of [['user.name', 'Canary Pilot'], ['user.email', 'canary-pilot@localhost']]) {
    r = git(target, 'config', key, value);
    if (r.status !== 0) throw new Error(`git config ${key} ${label}/${arm}: ${r.stderr}`);
  }
  const configPath = path.join(target, '.git/FETCH_HEAD');
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  const head = gitOut(target, 'rev-parse', 'HEAD');
  const status = gitOut(target, 'status', '--porcelain');
  const remotes = gitOut(target, 'remote', '-v');
  const shallow = fs.existsSync(path.join(target, '.git/shallow'));
  const visibleHistory = gitOut(target, 'log', '--format=%H', '--all');
  if (head !== baseline || status || remotes || !shallow || visibleHistory !== baseline) {
    throw new Error(`solution-blind baseline validation failed for ${label}/${arm}: ${JSON.stringify({ head, baseline, status, remotes, shallow, visibleHistory })}`);
  }
  return { repo: target, baseCommit: baseline, clean: true, shallow: true, remotes: [], visibleHistory: [baseline] };
}
function runPhase(label, arm, repo) {
  const phase = arm === 'canary' ? 'baseline' : 'plain';
  const out = path.join(outRoot, 'preflight', arm, label);
  const args = [taskRunner, '--label', label, '--phase', phase, '--repo', repo,
    '--expected-head', labels[label].base,
    '--task-file', path.join(taskRoot, labels[label].task),
    '--out', out, '--cli', cli, '--artifact-sha256', artifact,
    '--timeout-ms', String(timeoutMs), ...validateToolchains(label)];
  if (label === 'S1') args.push('--gradle', path.join(gradleBin, 'gradle.bat'));
  const r = run(process.execPath, args, worktree, timeoutMs + 60_000);
  const resultPath = path.join(out, 'attempt-result.json');
  const attempt = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  if (r.status !== 0 || !attempt || attempt.status !== 'complete') {
    throw new Error(`${label}/${arm} preflight failed (exit ${String(r.status)}):\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  }
  return {
    label, arm, phase, repo, output: out, status: attempt.status,
    setupCommit: attempt.sealedBaselineHead ?? null,
    canaryVerdict: attempt.canaryVerdict ?? null,
    toolchainDirectories: toolchains(label),
    stdout: (r.stdout ?? '').trim(),
    setupLocalConfigSha256: fs.existsSync(path.join(repo, '.canary/canary.local.json'))
      ? sha256(fs.readFileSync(path.join(repo, '.canary/canary.local.json')))
      : null,
  };
}

if (!fs.statSync(taskRunner, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(cli, { throwIfNoEntry: false })?.isFile()
  || !Number.isFinite(timeoutMs) || timeoutMs < 1_000 || fs.existsSync(outRoot)) {
  console.error('usage: --out <new directory> --cli <installed 1.5.0 main.js> [--scratch-root <dir>] [--timeout-ms <n>]');
  process.exit(2);
}
const v = run(process.execPath, [cli, '--version'], worktree, 10_000);
if (v.status !== 0 || !/^canary 1\.5\.0\s*$/m.test(v.stdout ?? '')) throw new Error(`explicit package is not 1.5.0: ${v.stdout ?? ''}`);
fs.mkdirSync(outRoot, { recursive: true });
const records = [];
for (const label of Object.keys(labels)) {
  const plainRepo = makeShallowRepo(label, 'plain');
  const canaryRepo = makeShallowRepo(label, 'canary');
  const plain = runPhase(label, 'plain', plainRepo.repo);
  records.push({ source: plainRepo, ...plain });
  const canary = runPhase(label, 'canary', canaryRepo.repo);
  records.push({ source: canaryRepo, ...canary });
  const candidateCommit = labels[label].candidate;
  for (const record of [plain, canary]) {
    const candidateObject = git(record.repo, 'cat-file', '-e', `${candidateCommit}^{commit}`);
    if (candidateObject.status === 0) throw new Error(`${label}/${record.arm}: historical task candidate object is visible to the worker workspace`);
  }
  console.log(`PASS ${label}: both independent, solution-blind pilot baselines prepared`);
}
const summary = {
  schema: 'canary-post-v15-pilot-preparation/1',
  probe: 'tooling/probes/v15-pilot-prepare.mjs',
  probeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  taskRunnerSha256: sha256(fs.readFileSync(taskRunner)),
  cliPath: cli, cliVersion: (v.stdout ?? '').trim(),
  cliSha256: sha256(fs.readFileSync(cli)), artifactSha256: artifact,
  scratchRoot, outRoot, timeoutMs,
  model: 'qwen3.8-flash', modelCli: 'Claude Code CLI',
  records, finishedAt: new Date().toISOString(), status: 'complete',
};
fs.writeFileSync(path.join(outRoot, 'preparation-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
console.log(`--- PASS ${records.length} preflight arms; no model calls were made`);
