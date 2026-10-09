#!/usr/bin/env node
/**
 * Reproducible no-model checks for one frozen real-project task copy.
 *
 * `baseline` measures the recorded project state, runs the ordinary checks,
 * runs `canary setup` against the published CLI, then commits only setup files.
 * `remediate` re-runs operator setup on a clean pre-candidate tree after an
 * environment correction; `plain` runs only the ordinary project checks;
 * `candidate` tests the prepared solution and drives the real checkpoint.
 *
 * Every phase gets a new output directory. Environment values that commonly
 * carry credentials are removed; toolchain directories are explicit and are
 * recorded by path, never inferred from the caller's PATH.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const value = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const values = (name) => process.argv.flatMap((v, i) => v === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []);
const label = value('label');
const phase = value('phase');
const repo = path.resolve(value('repo') ?? '.');
const taskFile = path.resolve(value('task-file') ?? '.');
const outDir = path.resolve(value('out') ?? '.');
const cli = path.resolve(value('cli') ?? '');
const artifactSha256 = value('artifact-sha256', '').toLowerCase();
const expectedHead = value('expected-head');
const baselineHead = value('baseline-head');
const toolchainDirs = values('toolchain-dir').map((p) => path.resolve(p));
const gradle = value('gradle');
const timeoutMs = Number(value('timeout-ms', '1800000'));
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

if (!label || !/^[A-Z]\d$/.test(label) || !['baseline', 'remediate', 'plain', 'candidate'].includes(phase)
  || !expectedHead || !fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()
  || !fs.statSync(taskFile, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(cli, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(npmCli, { throwIfNoEntry: false })?.isFile()
  || !/^[0-9a-f]{64}$/.test(artifactSha256)
  || !Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
  console.error('usage: --label H1|H2|H3|H5|R1|S1 --phase baseline|remediate|plain|candidate --repo <copy> --task-file <task> --out <new immutable directory> --cli <installed main.js> --artifact-sha256 <64 hex> --expected-head <sha> [--baseline-head <setup sha>] [--toolchain-dir <dir> ...] [--gradle <gradle.bat>] [--timeout-ms <n>]');
  process.exit(2);
}
if (phase === 'candidate' && !baselineHead) {
  console.error('usage error: candidate phase requires --baseline-head <sealed setup commit>');
  process.exit(2);
}
for (const dir of toolchainDirs) {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`usage error: authorized toolchain directory does not exist: ${dir}`);
    process.exit(2);
  }
}
if (label === 'S1' && (!gradle || !fs.statSync(path.resolve(gradle), { throwIfNoEntry: false })?.isFile())) {
  console.error('usage error: S1 requires --gradle <existing gradle.bat>');
  process.exit(2);
}

const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
if (version.status !== 0 || !/^canary 1\.5\.0\s*$/m.test(version.stdout ?? '')) {
  console.error(`usage error: the explicit CLI must report canary 1.5.0: ${(version.stdout ?? '').trim()}`);
  process.exit(2);
}
const cliSha256 = sha256(fs.readFileSync(cli));
if (fs.existsSync(outDir)) {
  console.error(`REFUSED: output directory already exists: ${outDir}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(outDir), { recursive: true });
fs.mkdirSync(outDir);

const trustStore = path.join(os.tmpdir(), 'canary-v15-validation-trust', sha256(repo));
fs.mkdirSync(trustStore, { recursive: true });
const sensitiveKey = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|CLAUDE|OPENAI|ANTHROPIC|CODEX)/i;
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !sensitiveKey.test(key)));
safeEnv.CANARY_TRUST_STORE = trustStore;
safeEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
if (process.platform === 'win32') {
  for (const key of Object.keys(safeEnv)) if (key.toLowerCase() === 'path') delete safeEnv[key];
}
safeEnv.PATH = [...toolchainDirs, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);

const run = (exe, args, { input, cwd = repo, env = safeEnv, timeout = timeoutMs } = {}) => spawnSync(exe, args, {
  cwd, env, encoding: 'utf8', windowsHide: true, timeout, input,
});
const git = (...args) => run('git', args, { timeout: 60_000 });
const gitOut = (...args) => {
  const r = git(...args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stdout ?? '')}${(r.stderr ?? '')}`);
  return (r.stdout ?? '').trim();
};
const identity = () => ({
  head: gitOut('rev-parse', 'HEAD'), tree: gitOut('rev-parse', 'HEAD^{tree}'),
  status: gitOut('status', '--porcelain'), trackedFiles: gitOut('ls-files').split('\n').filter(Boolean).length,
});
const initial = identity();
if (initial.head.toLowerCase() !== expectedHead.toLowerCase()) {
  console.error(`REFUSED: expected HEAD ${expectedHead}, found ${initial.head}`);
  process.exit(1);
}
if (phase === 'baseline' && initial.status) {
  console.error(`REFUSED: baseline copy is dirty before measurement:\n${initial.status}`);
  process.exit(1);
}
if (phase === 'plain' && initial.status) {
  console.error(`REFUSED: plain-arm copy is dirty before measurement:\n${initial.status}`);
  process.exit(1);
}
if (phase === 'candidate') {
  const ancestor = run('git', ['merge-base', '--is-ancestor', baselineHead, 'HEAD'], { timeout: 60_000 });
  if (ancestor.status !== 0) {
    console.error(`REFUSED: sealed base ${baselineHead} is not an ancestor of ${initial.head}`);
    process.exit(1);
  }
}

const projectCommands = label === 'R1'
  ? [['typecheck', process.execPath, [npmCli, 'run', 'typecheck']], ['tests', process.execPath, [npmCli, 'run', 'test']], ['build', process.execPath, [npmCli, 'run', 'build']]]
  : label === 'S1'
    ? [['tests', 'cmd.exe', ['/d', '/c', path.join(outDir, 'gradle-test.cmd')]]]
    : [['tests', process.execPath, [npmCli, 'test']]];
if (label === 'S1') {
  fs.writeFileSync(path.join(outDir, 'gradle-test.cmd'), `@echo off\r\n"${path.resolve(gradle)}" test\r\nexit /b %ERRORLEVEL%\r\n`, { flag: 'wx' });
}
const commands = [];
let failures = 0;
function saveStep(name, exe, args, result, startedAt, elapsedMs) {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  fs.writeFileSync(path.join(outDir, `${name}.stdout.txt`), stdout, { flag: 'wx' });
  fs.writeFileSync(path.join(outDir, `${name}.stderr.txt`), stderr, { flag: 'wx' });
  const outcome = {
    name, executable: exe, args, cwd: repo, startedAt, elapsedMs,
    exitCode: result.status ?? null, signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT', spawnError: result.error?.message ?? null,
    stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
  };
  commands.push(outcome);
  console.log(`${outcome.exitCode === 0 ? 'PASS' : 'OBSERVED'} ${name}: exit ${String(outcome.exitCode)}${outcome.timedOut ? ' (timeout)' : ''}`);
  return outcome;
}
function step(name, exe, args, options = {}) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = run(exe, args, options);
  const outcome = saveStep(name, exe, args, result, startedAt, Date.now() - start);
  if (result.error || result.status === null) failures++;
  return { outcome, result };
}

const startRecord = {
  schema: 'canary-release-validation/1', label, phase,
  probe: 'tooling/probes/v15-release-validation-task.mjs',
  probeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  cliPath: cli, cliVersion: (version.stdout ?? '').trim(), cliBinarySha256: cliSha256,
  publishedArtifactSha256: artifactSha256, taskPath: taskFile,
  expectedHead, baselineHead,
  taskSha256: sha256(fs.readFileSync(taskFile)), repo, trustStore,
  toolchainDirectories: toolchainDirs,
  toolchainDirectoryCount: toolchainDirs.length,
  startingRepoIdentity: initial,
  startedAt: new Date().toISOString(),
  environmentKeyNames: Object.keys(safeEnv).sort(),
};
fs.writeFileSync(path.join(outDir, 'attempt.json'), `${JSON.stringify(startRecord, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(outDir, 'git-before.json'), `${JSON.stringify(initial, null, 2)}\n`, { flag: 'wx' });

if ((phase === 'baseline' || phase === 'plain') && label === 'R1' && !fs.existsSync(path.join(repo, 'node_modules'))) {
  step('dependency-install', process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
}
if (label === 'R1') step(`${phase}-prerequisite-build`, process.execPath, [npmCli, 'run', 'build']);
for (const [name, exe, args] of projectCommands) step(`plain-${name}`, exe, args);

if (phase === 'baseline' || phase === 'remediate') {
  const setupArgs = ['setup', '--yes'];
  if (phase === 'remediate') setupArgs.push('--clear-toolchain-dirs');
  for (const dir of toolchainDirs) setupArgs.push('--toolchain-dir', dir);
  const setup = step('canary-setup', process.execPath, [cli, ...setupArgs]);
  const configPaths = gitOut('status', '--porcelain').split('\n').filter(Boolean);
  const allowedSetupPath = /(?:^|\s)(?:\.mcp\.json|\.claude\/|\.codex\/|canary\.project\.json|CLAUDE\.md|AGENTS\.md)/i;
  const unexpected = configPaths.filter((line) => !allowedSetupPath.test(line.replace(/\\/g, '/')));
  if (unexpected.length) {
    failures++;
    console.log(`FAIL setup wrote unexpected project paths: ${unexpected.join(', ')}`);
  }
  step('git-config-user', 'git', ['config', 'user.name', 'Canary Validation']);
  step('git-config-email', 'git', ['config', 'user.email', 'canary-validation@localhost']);
  step('git-add-setup', 'git', ['add', '-A']);
  const commit = step('git-commit-setup', 'git', ['commit', '--allow-empty', '-m', `Canary validation setup baseline ${label}`]);
  const afterSetup = identity();
  step('canary-doctor-baseline', process.execPath, [cli, 'doctor', '--json']);
  startRecord.setupExitCode = setup.outcome.exitCode;
  startRecord.setupCommitExitCode = commit.outcome.exitCode;
  startRecord.sealedBaselineHead = afterSetup.head;
  startRecord.sealedBaselineTree = afterSetup.tree;
  startRecord.sealedBaselineStatus = afterSetup.status;
} else if (phase === 'candidate') {
  const hookInput = JSON.stringify({
    session_id: `post-v15-${label}`, cwd: repo,
    hook_event_name: 'Stop', stop_hook_active: false,
  });
  step('canary-checkpoint-candidate', process.execPath, [cli, 'checkpoint'], { input: hookInput });
}

const finalIdentity = identity();
const result = {
  ...startRecord,
  finishedAt: new Date().toISOString(),
  commands,
  finalRepoIdentity: finalIdentity,
  status: failures === 0 ? 'complete' : 'incomplete',
  infrastructureFailures: failures,
  canaryVerdict: (() => {
    const canaryCommand = commands.find((c) => c.name === 'canary-checkpoint-candidate')
      ? 'canary-checkpoint-candidate'
      : commands.find((c) => c.name === 'canary-doctor-baseline') ? 'canary-doctor-baseline' : null;
      if (canaryCommand === null) return null;
      const out = fs.readFileSync(path.join(outDir, `${canaryCommand}.stdout.txt`), 'utf8');
      // Only the envelope decides; nested proof duties have their own status.
      try {
        const envelope = JSON.parse(out);
        const verdict = envelope?.decision ?? envelope?.status;
        if (typeof verdict === 'string') return verdict;
      } catch { /* older hook prose is classified below, never a nested verdict */ }
      if (/sealed checks passed/i.test(out)) {
        return /with a caveat/i.test(out)
          ? 'passed_with_worker_authored_evidence_caveat'
          : 'passed';
      }
      if (/loop protection|loop guard|repeated stop/i.test(out)) return 'loop_protection';
      return null;
    })(),
};
fs.writeFileSync(path.join(outDir, 'attempt-result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
const sums = fs.readdirSync(outDir).filter((name) => name !== 'SHA256SUMS').sort()
  .map((name) => `${sha256(fs.readFileSync(path.join(outDir, name)))}  ${name}`);
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`, { flag: 'wx' });
console.log(`--- ${label}/${phase}: ${result.status}; Canary verdict ${String(result.canaryVerdict)}; record ${outDir}`);
process.exit(failures === 0 ? 0 : 1);
