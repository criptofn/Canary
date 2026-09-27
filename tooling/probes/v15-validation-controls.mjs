#!/usr/bin/env node
/** Verify the hidden correctness oracles reject each original bug and accept
 * the independently reconstructed/recorded candidate, using clean git archives. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const outRoot = path.resolve(arg('out') ?? '.');
const archiveRoot = path.resolve(arg('archive-root', path.join(outRoot, 'source-archives')));
const worktree = path.resolve(arg('worktree') ?? path.resolve(import.meta.dirname, '../..'));
const scratchRoot = path.resolve(arg('scratch-root') ?? 'C:\\Users\\Johannes\\AppData\\Local\\Temp\\canary-v15-baselines-20260927');
const oracle = path.resolve(arg('oracle', path.join(worktree, 'tooling/probes/v15-validation-oracle.mjs')));
const evidenceRoot = path.join(worktree, 'tooling/benchmark/results/session-evidence/post-v15-validation-2026-09-27');
const cli = path.resolve(arg('cli') ?? '');
const javac = path.resolve(arg('javac') ?? '');
const java = path.resolve(arg('java') ?? '');
const artifact = arg('artifact-sha256', 'cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386');
const tasks = {
  H1: { base: '7d0eb49c46d83184638fa093b44a15222feb8c51', candidate: 'e6ed172dc22861b90487b3392b859542d53f8d30' },
  H2: { base: '4f35b9c51d787b3a2f05c91a2ae0c8377a2b5840', candidate: '9bf544223ac7fabecd533a2b9c4af35b764efc08' },
  H3: { base: '7d0eb49c46d83184638fa093b44a15222feb8c51', candidate: '560307cedbb2efc33104799fcfb42ee62ffa3824' },
  H5: { base: '4f35b9c51d787b3a2f05c91a2ae0c8377a2b5840', candidate: '21696b29dec8b514d66367095549d504c06160b6' },
  R1: { base: '1fe40d8505bbb0cac703c976401c17213abf1e9d', candidate: 'd906039823003ce78b089b377d732e7d3aab1702' },
  S1: { base: '4255fa14049b479b479be1148df20bf0d097926c', candidate: '1663020d827895019b79e5c1b0b59972feaaff83' },
};
if (!fs.statSync(oracle, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(cli, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(javac, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(java, { throwIfNoEntry: false })?.isFile()
  || fs.existsSync(outRoot)
  || fs.existsSync(archiveRoot)) {
  console.error('usage: --out <new dir> --cli <installed main.js> --javac <javac.exe> --java <java.exe> [--scratch-root <dir>]');
  process.exit(2);
}
fs.mkdirSync(outRoot, { recursive: true });
fs.mkdirSync(archiveRoot, { recursive: true });
const oracleResults = [];
function archive(repo, rev, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bytes = spawnSync('git', ['-C', repo, 'archive', '--format=tar', rev], { encoding: null, timeout: 120_000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (bytes.status !== 0 || bytes.error || !Buffer.isBuffer(bytes.stdout) || bytes.stdout.length === 0) throw new Error(`git archive ${repo} ${rev} failed: ${bytes.error?.message ?? bytes.stderr?.toString() ?? ''}`);
  const unpack = spawnSync('tar.exe', ['-xf', '-', '-C', dir], { input: bytes.stdout, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (unpack.status !== 0) throw new Error(`tar extract ${dir} failed: ${unpack.stderr ?? ''}`);
  return crypto.createHash('sha256').update(bytes.stdout).digest('hex');
}
function runOracle(label, repo, role, expected) {
  const output = path.join(outRoot, 'oracle-results', role, label);
  const args = [oracle, '--label', label, '--repo', repo, '--out', output, '--expected', expected];
  if (label === 'R1') args.push('--runtime-root', path.join(scratchRoot, 'R1'));
  if (label === 'S1') args.push('--javac', javac, '--java', java);
  const result = spawnSync(process.execPath, args, { cwd: worktree, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const record = {
    label, role, repo, expected,
    exitCode: result.status ?? null, signal: result.signal ?? null,
    stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim(),
    passed: result.status === 0 && !result.error,
  };
  oracleResults.push(record);
  console.log(record.stdout || `${record.passed ? 'PASS' : 'FAIL'} ${label} ${role}; exit ${String(record.exitCode)}`);
  if (!record.passed) throw new Error(`${label} ${role} oracle did not meet expected ${expected}: ${record.stderr}`);
}
const archiveHashes = {};
for (const label of Object.keys(tasks)) {
  const sourceRepo = path.join(scratchRoot, label);
  const baseline = path.join(archiveRoot, 'baseline', label);
  const candidate = path.join(archiveRoot, 'candidate', label);
  archiveHashes[label] = {
    baseline: archive(sourceRepo, tasks[label].base, baseline),
    candidate: archive(sourceRepo, tasks[label].candidate, candidate),
  };
  runOracle(label, baseline, 'baseline', 'fail');
  runOracle(label, candidate, 'candidate', 'pass');
}
const summary = {
  schema: 'canary-validation-oracle-controls/1', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  worktree, scratchRoot, archiveRoot, archiveHashes, oracle, cli, artifactSha256: artifact,
  candidateHeads: Object.fromEntries(Object.entries(tasks).map(([label, ids]) => [label, ids.candidate])),
  controls: oracleResults,
  status: 'complete', statement: 'All six hidden oracles fail on the original baseline and pass on the prepared task candidate.',
};
fs.writeFileSync(path.join(outRoot, 'controls-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
console.log(`--- PASS ${oracleResults.length}/${oracleResults.length} independent baseline/candidate controls`);
