#!/usr/bin/env node
/**
 * Final 12-attempt diagnostic extension for the release's Windows sweep.
 * It reproduces the lifecycle fixture directly and records a fresh CIM view
 * immediately before and after sweepDescendants, so process-end timing can be
 * compared with the sweep's own killed PID list. This is diagnostic only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const runs = Number(arg('runs', '12'));
const outDir = path.resolve(arg('out') ?? '.');
const loadWorkers = Number(arg('load-workers', '8'));
const root = path.resolve(import.meta.dirname, '../..');
const modulePath = path.join(root, 'packages/support/dist/src/index.js');
if (!Number.isInteger(runs) || runs < 1 || runs > 12 || !Number.isInteger(loadWorkers) || loadWorkers < 1 || loadWorkers > 48
  || !fs.statSync(modulePath, { throwIfNoEntry: false })?.isFile()) {
  console.error('usage: --out <new dir> [--runs 1..12] [--load-workers 1..48]');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error(`REFUSED: native Windows required; current platform is ${process.platform}`);
  process.exit(2);
}
if (fs.existsSync(outDir)) {
  console.error(`REFUSED: output directory already exists: ${outDir}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const support = await import(pathToFileURL(modulePath).href);
if (typeof support.sweepDescendants !== 'function') throw new Error('release dist does not export sweepDescendants');
const testPath = path.join(root, 'packages/support/dist/test/lifecycle.test.js');
const metadata = {
  schema: 'canary-v15-windows-sweep-trace/1',
  probe: 'tooling/probes/v15-windows-sweep-trace.mjs',
  probeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  modulePath, moduleSha256: sha256(fs.readFileSync(modulePath)),
  testPath, testSha256: sha256(fs.readFileSync(testPath)),
  node: process.version, platform: process.platform, release: os.release(),
  cpuCount: os.cpus().length, runs, loadWorkers,
  fixture: 'same parent -> one unrefed Node child with a 300 s timer; parent holds a 60 s timer',
  startedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
const survivorArgs = ['-e', 'setTimeout(()=>{}, 300000)'];
const childScript = [
  "const { spawn } = require('node:child_process');",
  `const c = spawn(process.execPath, ${JSON.stringify(survivorArgs)}, { stdio: 'ignore', windowsHide: true });`,
  'c.unref(); console.log(String(c.pid)); setTimeout(()=>{}, 60000);',
].join(' ');
const alive = (pid) => {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { timeout: 15_000, encoding: 'utf8', windowsHide: true });
  return result.status === 0 && (result.stdout ?? '').includes(String(pid));
};
const observe = (pids) => {
  const script = "$ErrorActionPreference='SilentlyContinue';" +
    '$all=@(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_ -ne $null });' +
    `Write-Output ('snapshotCount=' + $all.Count);` +
    `foreach($want in @(${pids.join(',')})){` +
    '$hit=$all | Where-Object { [int]$_.ProcessId -eq $want } | Select-Object -First 1;' +
    `if($null -eq $hit){ Write-Output ('row=' + $want + ';present=false') } else {` +
    "$cd=$hit.CreationDate; $cdText=if($null -eq $cd){'null'}else{([DateTime]$cd).ToUniversalTime().ToString('o')};" +
    "Write-Output ('row=' + $want + ';present=true;ppid=' + [int]$hit.ParentProcessId + ';creationDate=' + $cdText) } }";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 30_000, encoding: 'utf8', windowsHide: true,
  });
  return {
    exitCode: result.status ?? null, error: result.error?.message ?? null,
    stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim(),
  };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopWorkers = async (workers) => {
  for (const w of workers) if (w.exitCode === null && w.signalCode === null) { try { w.kill(); } catch {} }
  await Promise.all(workers.map((w) => w.exitCode !== null || w.signalCode !== null ? Promise.resolve() : new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000); w.once('close', () => { clearTimeout(timer); resolve(); });
  })));
};
const startWorkers = (count) => {
  const source = 'const until=Date.now()+60000;let n=0;while(Date.now()<until)n=(n+1)|0;';
  return Array.from({ length: Math.min(count, os.cpus().length) }, () => spawn(process.execPath, ['-e', source], { stdio: 'ignore', windowsHide: true }));
};
const waitForPid = async (child) => new Promise((resolve, reject) => {
  let text = '';
  const timeout = setTimeout(() => reject(new Error('parent did not print child PID within 15 s')), 15_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (part) => {
    text += part;
    const pid = Number(text.trim());
    if (Number.isInteger(pid) && pid > 0) { clearTimeout(timeout); resolve(pid); }
  });
  child.once('error', (e) => { clearTimeout(timeout); reject(e); });
});

const results = [];
for (let i = 0; i < runs; i++) {
  const scenario = i % 3 === 2 ? 'idle' : 'loaded';
  const dir = path.join(outDir, `attempt-${String(i + 1).padStart(2, '0')}`);
  fs.mkdirSync(dir);
  const workers = scenario === 'loaded' ? startWorkers(loadWorkers) : [];
  const parent = spawn(process.execPath, ['-e', childScript], {
    stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true,
  });
  let childPid = null;
  let before = null;
  let sweep = null;
  let after = null;
  let error = null;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  try {
    childPid = await waitForPid(parent);
    const parentPid = parent.pid;
    if (!parentPid) throw new Error('parent spawn returned no PID');
    const aliveBefore = { parent: alive(parentPid), child: alive(childPid) };
    if (!aliveBefore.child) throw new Error(`fixture child ${childPid} was not alive before observation`);
    const spawnedAtMs = Date.now() - 1_000;
    before = observe([parentPid, childPid]);
    const aliveImmediatelyBeforeSweep = { parent: alive(parentPid), child: alive(childPid) };
    sweep = support.sweepDescendants(parentPid, spawnedAtMs);
    const aliveImmediatelyAfterSweep = { parent: alive(parentPid), child: alive(childPid) };
    after = observe([parentPid, childPid]);
    const gone = !alive(childPid);
    const attempt = {
      number: i + 1, scenario, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start,
      parentPid, childPid, loadWorkerPids: workers.map((w) => w.pid ?? null), spawnedAtMs,
      aliveBefore, beforeSnapshot: before, aliveImmediatelyBeforeSweep,
      sweep, aliveImmediatelyAfterSweep, afterSnapshot: after,
      childGoneAfterSweep: gone,
      sweepRecordedChildKill: Array.isArray(sweep?.killed) && sweep.killed.includes(childPid),
      sweepFailed: sweep?.failed ?? null,
      interpretation: sweep?.failed
        ? 'sweep could not confirm its process snapshot'
        : Array.isArray(sweep?.killed) && sweep.killed.includes(childPid)
          ? 'sweep explicitly reported terminating the child'
          : gone
            ? 'child absent after sweep but not listed as killed; inspect the before/after snapshots for timing'
            : 'child survived the sweep; containment miss reproduced',
    };
    fs.writeFileSync(path.join(dir, 'attempt.json'), `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'wx' });
    results.push(attempt);
    console.log(`${attempt.sweepRecordedChildKill ? 'PASS' : attempt.childGoneAfterSweep ? 'OBSERVED' : 'FAIL'} attempt ${attempt.number}/${runs} ${scenario}: killed=${JSON.stringify(sweep?.killed)} childAlive=${String(!gone)}`);
  } catch (e) {
    error = String(e?.stack ?? e);
    fs.writeFileSync(path.join(dir, 'error.txt'), `${error}\n`, { flag: 'wx' });
    results.push({ number: i + 1, scenario, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start, parentPid: parent.pid ?? null, childPid, before, sweep, after, error });
    console.log(`FAIL attempt ${i + 1}/${runs} ${scenario}: ${String(e?.message ?? e)}`);
  } finally {
    if (childPid && alive(childPid)) spawnSync('taskkill.exe', ['/PID', String(childPid), '/F'], { timeout: 15_000, windowsHide: true });
    if (parent.pid && alive(parent.pid)) spawnSync('taskkill.exe', ['/PID', String(parent.pid), '/T', '/F'], { timeout: 15_000, windowsHide: true });
    await stopWorkers(workers);
    await sleep(100);
  }
}
const summary = {
  ...metadata, finishedAt: new Date().toISOString(), results,
  explicitChildKills: results.filter((r) => r.sweepRecordedChildKill).length,
  childrenGoneButNotListed: results.filter((r) => r.childGoneAfterSweep && !r.sweepRecordedChildKill).length,
  childrenSurvivingSweep: results.filter((r) => r.childGoneAfterSweep === false).length,
  statement: 'Diagnostic evidence only. No product change is implied; interpret each pre/post process snapshot and keep the original finding open until its cause is established.',
};
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
const files = fs.readdirSync(outDir, { recursive: true }).filter((p) => typeof p === 'string' && fs.statSync(path.join(outDir, p)).isFile()).sort();
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${files.map((name) => `${sha256(fs.readFileSync(path.join(outDir, name)))}  ${name.replaceAll('\\', '/')}`).join('\n')}\n`, { flag: 'wx' });
console.log(`--- ${summary.explicitChildKills}/${runs} explicit child kills; ${summary.childrenGoneButNotListed} children gone without a recorded child kill; ${summary.childrenSurvivingSweep} survivors`);
