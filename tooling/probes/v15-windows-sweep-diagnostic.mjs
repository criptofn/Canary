#!/usr/bin/env node
/**
 * Bounded repeat of the published Windows lifecycle tests. This measures the
 * open v1.5 sweep observation; a green run does not close or explain it.
 * Every invocation stays below the 30-attempt limit and preserves raw TAP,
 * stderr, timing, platform, test bytes, and temporary load process identities.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const runs = Number(arg('runs', '18'));
const outDir = path.resolve(arg('out') ?? '.');
const testFile = path.resolve(arg('test-file', path.resolve(import.meta.dirname, '../../packages/support/dist/test/lifecycle.test.js')));
const runTimeoutMs = Number(arg('run-timeout-ms', '180000'));
const loadWorkers = Number(arg('load-workers', '8'));
const schedule = ['idle', 'loaded', 'loaded'];

if (!Number.isInteger(runs) || runs < 1 || runs > 30 || !Number.isInteger(loadWorkers) || loadWorkers < 1 || loadWorkers > 48
  || !Number.isFinite(runTimeoutMs) || runTimeoutMs < 10_000
  || !fs.statSync(testFile, { throwIfNoEntry: false })?.isFile()) {
  console.error('usage: --out <new dir> [--runs 1..30] [--test-file <dist test>] [--run-timeout-ms 180000] [--load-workers 1..48]');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error(`REFUSED: this is a native Windows reproduction; current platform is ${process.platform}`);
  process.exit(2);
}
if (fs.existsSync(outDir)) {
  console.error(`REFUSED: output directory already exists: ${outDir}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const runMeta = {
  schema: 'canary-v15-windows-sweep-diagnostic/1',
  probePath: 'tooling/probes/v15-windows-sweep-diagnostic.mjs',
  probeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  testFile, testSha256: sha256(fs.readFileSync(testFile)),
  node: process.version, nodePath: process.execPath,
  platform: process.platform, release: os.release(), cpus: os.cpus().length,
  runs, runTimeoutMs, loadWorkers, schedule,
  startedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(runMeta, null, 2)}\n`, { flag: 'wx' });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stopWorkers(workers) {
  for (const worker of workers) {
    if (worker.exitCode === null && worker.signalCode === null) {
      try { worker.kill(); } catch { /* the child may have exited */ }
    }
  }
  await Promise.all(workers.map((worker) => worker.exitCode !== null || worker.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      worker.once('close', () => { clearTimeout(timer); resolve(); });
    })));
}
function spawnLoad(count) {
  const source = 'const until=Date.now()+60000;let n=0;while(Date.now()<until)n=(n+1)|0;process.exitCode=n===-1?1:0;';
  return Array.from({ length: count }, () => spawn(process.execPath, ['-e', source], {
    stdio: 'ignore', windowsHide: true,
  }));
}

const results = [];
for (let i = 0; i < runs; i++) {
  const scenario = schedule[i % schedule.length];
  const attemptDir = path.join(outDir, `attempt-${String(i + 1).padStart(2, '0')}`);
  fs.mkdirSync(attemptDir);
  const workers = scenario === 'loaded' ? spawnLoad(Math.min(loadWorkers, os.cpus().length)) : [];
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    encoding: 'utf8', timeout: runTimeoutMs, windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - start;
  await stopWorkers(workers);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  fs.writeFileSync(path.join(attemptDir, 'stdout.tap.txt'), stdout, { flag: 'wx' });
  fs.writeFileSync(path.join(attemptDir, 'stderr.txt'), stderr, { flag: 'wx' });
  const attempt = {
    number: i + 1, scenario, startedAt, finishedAt: new Date().toISOString(), elapsedMs,
    exitCode: result.status ?? null, signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT', spawnError: result.error?.message ?? null,
    loadWorkerPids: workers.map((worker) => worker.pid ?? null),
    stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
    passed: result.status === 0 && !result.error,
  };
  fs.writeFileSync(path.join(attemptDir, 'attempt.json'), `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'wx' });
  results.push(attempt);
  console.log(`${attempt.passed ? 'PASS' : 'OBSERVED'} attempt ${attempt.number}/${runs} ${scenario}: exit ${String(attempt.exitCode)}, ${elapsedMs}ms`);
}

const summary = {
  ...runMeta, finishedAt: new Date().toISOString(),
  attempts: results,
  passed: results.filter((r) => r.passed).length,
  failedOrIncomplete: results.filter((r) => !r.passed).length,
  statement: results.every((r) => r.passed)
    ? 'No reproduction in this bounded sample; the v1.5 finding remains OPEN and unexplained.'
    : 'A failure or incomplete attempt occurred; see its raw TAP and stderr. The v1.5 finding remains OPEN pending diagnosis.',
};
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
const files = fs.readdirSync(outDir, { recursive: true }).filter((p) => typeof p === 'string' && fs.statSync(path.join(outDir, p)).isFile()).sort();
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${files.map((name) => `${sha256(fs.readFileSync(path.join(outDir, name)))}  ${name.replaceAll('\\', '/')}`).join('\n')}\n`, { flag: 'wx' });
console.log(`--- ${summary.passed}/${runs} complete; ${summary.statement}`);
process.exit(summary.failedOrIncomplete === 0 ? 0 : 1);
