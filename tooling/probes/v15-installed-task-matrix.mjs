#!/usr/bin/env node
/** No-model acceptance and negative controls using one explicitly installed artifact. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? null : process.argv[i + 1];
};
const root = path.resolve(import.meta.dirname, '../..');
const cli = arg('cli');
const archive = arg('package');
const scratch = arg('scratch-root');
const output = arg('out');
const javaBin = arg('java-bin');
for (const [name, value] of Object.entries({ cli, package: archive, 'scratch-root': scratch, out: output, 'java-bin': javaBin })) {
  assert.ok(value && path.isAbsolute(value), `--${name} requires an absolute path`);
}
assert.ok(!fs.existsSync(output), 'output must be a new directory');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => hash(fs.readFileSync(file));
const cliHash = fileHash(cli);
const packageHash = fileHash(archive);
const preparationProbe = path.join(root, 'tooling/probes/v15-pilot-prepare.mjs');
const runner = path.join(root, 'tooling/probes/v15-release-validation-task.mjs');
const oracle = path.join(root, 'tooling/probes/v15-validation-oracle.mjs');
const solutionProbe = path.join(root, 'tooling/probes/v15-prepare-validation-solution.mjs');
const solutionRoot = path.join(root, 'tooling/benchmark/results/session-evidence/post-v15-pilot-20260927/solutions');
const taskRoot = path.join(root, 'tooling/benchmark/results/session-evidence/v15-realworld/tasks');
const sourcePaths = {
  H1: 'src/workflows/fileOrganizer.js', H2: 'src/workflows/fileOrganizer.js',
  H3: 'src/agent/matrixNormCore.js', H5: 'src/agent/matrixNormCore.js',
  R1: 'src/verify/failure-ids.ts',
  S1: 'src/main/java/net/schniedelsmp/smp/util/IdLookup.java',
};
const selectedTasks = arg('tasks')?.split(',') ?? Object.keys(sourcePaths);
assert.ok(selectedTasks.length && new Set(selectedTasks).size === selectedTasks.length
  && selectedTasks.every((label) => Object.hasOwn(sourcePaths, label)), '--tasks must name unique existing task labels');
const taskNames = {
  H1: 'H1-maxagedays-zero.md', H2: 'H2-invoice-classification.md',
  H3: 'H3-quantize-bits-validation.md', H5: 'H5-simulation-cases.md',
  R1: 'R1-pytest-id-collision.md', S1: 'S1-idlookup-ambiguity.md',
};
fs.mkdirSync(output, { recursive: true });
const commands = [];
const manifest = {
  startedAt: new Date().toISOString(), cli, cliSha256: cliHash,
  package: archive, packageSha256: packageHash, scratch, javaBin,
  selectedTasks, unselectedTasks: Object.keys(sourcePaths).filter((label) => !selectedTasks.includes(label)),
  fullScopeExpectedControls: 12,
  instruments: [fileURLToPath(import.meta.url), preparationProbe, runner, oracle, solutionProbe]
    .map((file) => ({ file, sha256: fileHash(file) })),
  solutions: Object.keys(sourcePaths).map((label) => ({
    label, file: path.join(solutionRoot, label, 'candidate.diff'),
    sha256: fileHash(path.join(solutionRoot, label, 'candidate.diff')),
  })),
};
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
fs.mkdirSync(path.join(output, 'instruments'));
for (const instrument of manifest.instruments) fs.copyFileSync(instrument.file, path.join(output, 'instruments', path.basename(instrument.file)), fs.constants.COPYFILE_EXCL);
function run(name, executable, args, cwd = root, input) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, args, {
    cwd, input, encoding: 'utf8', timeout: 2_000_000,
    windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(output, `${name}.stdout.txt`), result.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(output, `${name}.stderr.txt`), result.stderr ?? '', { flag: 'wx' });
  commands.push({ name, executable, args, cwd, startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdoutSha256: hash(result.stdout ?? ''), stderrSha256: hash(result.stderr ?? '') });
  assert.equal(result.error, undefined, `${name}: process error`);
  assert.equal(result.status, 0, `${name}: exit ${result.status}; see saved outputs`);
  return (result.stdout ?? '').trim();
}
const rows = [];
let failure = null;
try {
  run('preparation', process.execPath, [preparationProbe, '--out', path.join(output, 'prepared'),
    '--cli', cli, '--artifact-sha256', packageHash, '--scratch-root', scratch, '--tasks', selectedTasks.join(',')]);
  const preparation = JSON.parse(fs.readFileSync(path.join(output, 'prepared/preparation-summary.json'), 'utf8'));
  assert.equal(preparation.cliSha256, cliHash);
  for (const record of preparation.records) {
    const measured = JSON.parse(fs.readFileSync(path.join(record.output, 'attempt-result.json'), 'utf8'));
    assert.ok(measured.commands.every((c) => c.exitCode === 0 && !c.timedOut && !c.spawnError), `${record.label}/${record.arm}: baseline check failed`);
    if (record.arm === 'canary') assert.equal(record.canaryVerdict, 'READY');
  }
  for (const label of selectedTasks) {
    const start = preparation.records.find((r) => r.label === label && r.arm === 'canary');
    assert.ok(start, `${label}: missing independent baseline`);
    const repo = start.repo;
    const taskFile = path.join(taskRoot, taskNames[label]);
    const base = start.setupCommit;
    const git = (name, ...args) => run(`${label}-${name}`, 'git', ['-C', repo, ...args]);
    const runOracle = (role, expected) => run(`${label}-${role}-oracle`, process.execPath,
      [oracle, '--label', label, '--repo', repo, '--expected', expected,
        '--out', path.join(output, 'oracles', label, role),
        ...(label === 'H1' ? ['--strict-age'] : []),
        '--javac', path.join(javaBin, 'javac.exe'), '--java', path.join(javaBin, 'java.exe')]);
    runOracle('baseline', 'fail');
    if (label === 'H2') {
      run(`${label}-prepare-solution`, process.execPath, [solutionProbe, '--label', label,
        '--repo', repo, '--baseline-head', base, '--task-file', taskFile,
        '--out', path.join(output, 'solutions', label), '--cli', cli,
        '--artifact-sha256', packageHash, '--evidence-root', path.join(root, 'tooling/benchmark/results/session-evidence/v15-realworld')]);
    } else {
      const patch = fs.readFileSync(path.join(solutionRoot, label, 'candidate.diff'), 'utf8');
      run(`${label}-apply-solution`, 'git', ['-C', repo, 'apply', '--whitespace=nowarn'], root, patch);
      git('add-solution', 'add', '-A');
      git('commit-solution', 'commit', '-m', `Matrix positive control ${label}`);
    }
    for (const role of ['positive', 'negative']) {
      if (role === 'negative') {
        // Keep the same regression checks; restore only the implementation.
        git('restore-source', 'restore', '--source', base, '--worktree', '--staged', '--', sourcePaths[label]);
        git('commit-negative', 'commit', '-m', `Matrix negative control ${label}`);
      }
      const head = git(`${role}-head`, 'rev-parse', 'HEAD');
      const checkOut = path.join(output, 'checks', label, role);
      const args = [runner, '--label', label, '--phase', 'candidate', '--repo', repo,
        '--expected-head', head, '--baseline-head', base, '--task-file', taskFile,
        '--out', checkOut, '--cli', cli, '--artifact-sha256', packageHash];
      for (const dir of start.toolchainDirectories) args.push('--toolchain-dir', dir);
      if (label === 'S1') args.push('--gradle', path.join(start.toolchainDirectories[0], 'gradle.bat'));
      run(`${label}-${role}-checks`, process.execPath, args);
      runOracle(role, role === 'positive' ? 'pass' : 'fail');
      const attempt = JSON.parse(fs.readFileSync(path.join(checkOut, 'attempt-result.json'), 'utf8'));
      const checkpoint = JSON.parse(fs.readFileSync(path.join(repo, '.canary/last-checkpoint.json'), 'utf8'));
      assert.equal(checkpoint.source, 'checkpoint', `${label}/${role}: stale checkpoint`);
      const hook = fs.readFileSync(path.join(checkOut, 'canary-checkpoint-candidate.stdout.txt'), 'utf8');
      const tests = attempt.commands.filter((c) => c.name.startsWith('plain-'));
      const hookBlocked = /"decision"\s*:\s*"block"/.test(hook);
      const row = { label, role, repo, base, head, checkOutput: checkOut,
        checkpoint, hookBlocked, projectChecks: tests,
        passed: role === 'positive'
          ? checkpoint.status === 'pass' && !hookBlocked && tests.every((c) => c.exitCode === 0)
          : checkpoint.status !== 'pass' && hookBlocked && tests.some((c) => c.exitCode !== 0) };
      fs.writeFileSync(path.join(output, `${label}-${role}-checkpoint.json`), `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' });
      rows.push(row);
      console.log(`${row.passed ? 'PASS' : 'FAIL'} ${label}/${role}: checkpoint=${checkpoint.status}, blocked=${hookBlocked}`);
      assert.ok(row.passed, `${label}/${role}: acceptance expectation failed`);
    }
  }
  assert.equal(fileHash(cli), cliHash, 'installed CLI changed during measurement');
  assert.equal(fileHash(archive), packageHash, 'package changed during measurement');
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(failure);
} finally {
  const summary = { ...manifest, finishedAt: new Date().toISOString(), commands, rows, failure,
    selectedControlsStatus: !failure && rows.length === selectedTasks.length * 2 && rows.every((r) => r.passed) ? 'complete' : 'incomplete',
    caveat: 'Selected controls do not replace the full six-task comparison. Unselected tasks remain unproven.',
    status: !failure && rows.length === 12 && rows.every((r) => r.passed) ? 'complete' : 'incomplete' };
  fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  // Prepared projects are mutable working copies, not immutable raw evidence.
  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (file === path.join(output, 'prepared/projects')) continue;
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files.push(path.relative(output, file));
    }
  }
  collect(output);
  files.sort();
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${files.map((name) => `${fileHash(path.join(output, name))}  ${name.replaceAll('\\', '/')}`).join('\n')}\n`, { flag: 'wx' });
  console.log(`--- ${summary.status}: ${rows.filter((r) => r.passed).length}/12 controls; no model calls`);
  process.exitCode = summary.status === 'complete' ? 0 : 1;
}
