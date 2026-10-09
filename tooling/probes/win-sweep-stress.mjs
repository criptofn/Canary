#!/usr/bin/env node
// Bounded Windows process cleanup check: six idle attempts followed by six
// attempts while a separate, throttled CPU worker is active. No network or
// project scripts are involved.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP host-bound: the Windows process sweep cannot run on this host');
  process.exit(3);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { sweepDescendants } = await import(pathToFileURL(path.join(repo, 'packages/support/dist/src/index.js')).href);
const fixtureDir = path.join(repo, 'packages/support/test/fixtures');
const parentScript = path.join(fixtureDir, 'process-tree-parent.cjs');
const loadScript = path.join(fixtureDir, 'process-tree-load.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { timeout: 10_000, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && (r.stdout ?? '').includes(String(pid));
}

async function childPidOf(parent) {
  let text = '';
  parent.stdout.setEncoding('utf8');
  parent.stdout.on('data', (part) => { text += part; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pid = Number(text.trim());
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    if (parent.exitCode !== null) throw new Error(`tree parent exited ${parent.exitCode} before printing its child PID`);
    await sleep(50);
  }
  throw new Error('tree parent did not report a child PID within 20 seconds');
}

function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000, windowsHide: true });
}

async function attempt(label, index) {
  const startedAt = Date.now();
  const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
  if (!parent.pid) throw new Error(`${label} ${index}: parent process has no pid`);
  let child = 0;
  try {
    child = await childPidOf(parent);
    assert.ok(alive(child), `${label} ${index}: child did not start`);
    const result = sweepDescendants(parent.pid, startedAt);
    assert.equal(result.failed, false, `${label} ${index}: sweep reported failure: ${JSON.stringify(result)}`);
    assert.ok(result.killed.includes(child), `${label} ${index}: child ${child} absent from ${JSON.stringify(result.killed)}`);
    assert.ok(!result.killed.includes(parent.pid), `${label} ${index}: root ${parent.pid} was reported as a descendant kill`);
    assert.ok(alive(parent.pid), `${label} ${index}: sweep killed its root process`);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && alive(child)) await sleep(100);
    assert.ok(!alive(child), `${label} ${index}: descendant ${child} survived`);
    console.log(`PASS ${label} attempt ${index}: root survived; descendant ${child} was terminated`);
  } finally {
    if (child) killTree(child);
    killTree(parent.pid);
  }
}

let load;
try {
  for (let i = 1; i <= 6; i += 1) await attempt('idle', i);
  load = spawn(process.execPath, [loadScript], { stdio: 'ignore', detached: true, windowsHide: true });
  if (!load.pid) throw new Error('load process has no pid');
  await sleep(200);
  assert.ok(alive(load.pid), 'load process did not start');
  for (let i = 1; i <= 6; i += 1) await attempt('loaded', i);
  console.log('PASS Windows process sweep stress: 12/12 attempts, 6 idle + 6 under CPU load');
} catch (error) {
  console.error(`FAIL Windows process sweep stress: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (load?.pid) killTree(load.pid);
}
