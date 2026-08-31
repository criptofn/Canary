/**
 * Audit F5 — process-lifecycle containment on NORMAL exit.
 *
 * Benign local node processes whose only behavior is a long timer; no other
 * software is involved. Two layers are tested separately:
 *
 *  1. sweepMechanism: sweepDescendants() positively proven against a LIVE
 *     parent's descendant (enumerate + kill). Windows enumerates via
 *     Win32_Process.ParentProcessId (which a live orphan retains after its
 *     parent dies — stale-PPID lineage); POSIX via the child's own process
 *     GROUP, and (audit S1) also the child's SESSION so a descendant that
 *     setpgid()ed into its own group is still caught, plus a transitive
 *     PPID BFS, with a group-kill backstop.
 *  2. containment: after runCommand resolves — normal exit or timeout — no
 *     descendant of the spawned child may still be alive. Which layer won the
 *     race (Canary's post-exit sweep vs an OS job-object container wrapping
 *     the test session) is environment-dependent and NOT asserted; on plain
 *     hosts only layer 1 exists, which is why layer 1 is proven directly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

import { runCommand, sweepDescendants, posixSessionMember, type RunOutcome, type WorkspaceLayout } from '../src/index.js';

const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-lifecycle-'));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

const survivorArgs = ['-e', 'setTimeout(()=>{}, 300000)'];

function workspace(): WorkspaceLayout {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
  const ws = { root, fixture: path.join(root, 'fixture') };
  fs.mkdirSync(ws.fixture, { recursive: true });
  return ws;
}

/** Child script: spawn ONE plain node helper on a long timer, unref it so
 *  THIS process can exit while the helper lives on, print the helper PID. */
const survivorChildScript = [
  "const { spawn } = require('node:child_process');",
  `const g = spawn(process.execPath, ${JSON.stringify(survivorArgs)},`,
  "  { stdio: 'ignore', windowsHide: true });",
  'g.unref();',
  'console.log(String(g.pid));',
].join(' ');

function isAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'],
      { timeout: 15_000, encoding: 'utf8', windowsHide: true });
    return (r.stdout ?? '').includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function untilDead(pid: number, budgetMs = 8_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

function killIfAlive(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { timeout: 15_000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

describe('audit F5 — sweep mechanism (live parent, positive proof)', () => {
  it('sweepDescendants finds and kills a live parent\'s child process', async () => {
    // Intermediate parent that spawns a child then sits on a timer, so the
    // sweep runs while the parent is still alive (mechanism, not race, is
    // what this test pins down).
    const mid = spawn(process.execPath, ['-e',
      "const { spawn } = require('node:child_process');" +
      `const c = spawn(process.execPath, ${JSON.stringify(survivorArgs)},` +
      "  { stdio: 'ignore', windowsHide: true });" +
      'c.unref(); console.log(String(c.pid));; setTimeout(()=>{}, 60000);',
    ], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
    let out = '';
    mid.stdout?.setEncoding('utf8');
    mid.stdout?.on('data', (d: string) => { out += d; });
    const kidPid = await new Promise<number>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('no child pid printed')), 15_000);
      mid.stdout?.on('data', () => {
        const n = Number(out.trim());
        if (Number.isFinite(n) && n > 0) { clearTimeout(to); resolve(n); }
      });
      mid.on('error', (e) => { clearTimeout(to); reject(e); });
    });
    try {
      assert.ok(isAlive(kidPid), 'precondition: child should be alive before sweep');
      const res = sweepDescendants(mid.pid, Date.now() - 1000);
      assert.equal(res.failed, false, 'sweep must not fail');
      assert.ok(res.killed.includes(kidPid),
        `sweep killed ${JSON.stringify(res.killed)} but not ${kidPid}`);
      assert.ok(await untilDead(kidPid), `child ${kidPid} survived the sweep`);
    } finally {
      killIfAlive(kidPid);
      killIfAlive(mid.pid!);
    }
  });
});

describe('audit F5 — containment through runCommand', () => {
  it('normal exit-0 of a child that left a helper behind: sweep clean, no survivors', async () => {
    const ws = workspace();
    const out: RunOutcome = await runCommand({
      ws, nodeDir: NODE_DIR,
      argv: [NODE, '-e', survivorChildScript],
      timeoutSecs: 60,
    });
    assert.equal(out.exitCode, 0, out.stderr);
    const grandchildPid = Number(out.stdout.trim());
    assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `no pid printed: ${out.stdout}`);
    try {
      assert.equal(out.sweepFailed, false, 'sweep reported failure');
      assert.ok(Array.isArray(out.sweptPids), 'sweptPids must be present on normal runs');
      assert.ok(await untilDead(grandchildPid),
        `grandchild ${grandchildPid} survived normal child exit (containment gap)`);
    } finally {
      killIfAlive(grandchildPid);
    }
  });

  it('a clean exit with no descendants sweeps nothing and does not fail', async () => {
    const ws = workspace();
    const out = await runCommand({
      ws, nodeDir: NODE_DIR,
      argv: [NODE, '-e', 'console.log("hi")'],
      timeoutSecs: 60,
    });
    assert.equal(out.exitCode, 0);
    assert.equal(out.sweepFailed, false);
    assert.deepEqual(out.sweptPids, []);
  });

  it('timeout: tree kill + sweep leave no survivors and do not fail', async () => {
    const ws = workspace();
    // Child spawns the survivor, then sits forever; the 2s timeout tree-kills
    // it on the timer, and the post-close sweep must still run cleanly.
    const script = survivorChildScript + " ;setTimeout(()=>{}, 120000);";
    const out = await runCommand({ ws, nodeDir: NODE_DIR, argv: [NODE, '-e', script], timeoutSecs: 2 });
    assert.equal(out.killedByTimeout, true);
    assert.equal(out.exitCode, -1);
    const grandchildPid = Number(out.stdout.trim());
    assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `no pid printed: ${JSON.stringify(out.stdout)}`);
    try {
      assert.equal(out.sweepFailed, false, 'sweep reported failure');
      assert.ok(await untilDead(grandchildPid),
        `grandchild ${grandchildPid} alive after timeout+sweep`);
    } finally {
      killIfAlive(grandchildPid);
    }
  });

  it('the swept child PID itself is never listed as killed (only descendants)', async () => {
    const ws = workspace();
    const out = await runCommand({
      ws, nodeDir: NODE_DIR,
      argv: [NODE, '-e', survivorChildScript],
      timeoutSecs: 60,
    });
    assert.ok(out.childPid);
    assert.ok(!out.sweptPids?.includes(out.childPid!),
      'sweep must target descendants, not the already-exited child');
    // Canary itself must never appear in a sweep result.
    assert.ok(!out.sweptPids?.includes(process.pid));
    for (const p of out.sweptPids ?? []) killIfAlive(p);
  });
});

describe('audit S1 — POSIX session-membership predicate (setpgid escapees)', () => {
  it('a member of the child session is caught even after it setpgid()s', () => {
    // detached child: session id == childPid; a descendant that setpgid into a
    // new group keeps sid == childPid -> still a member (old pgid-only check
    // would MISS it).
    assert.equal(posixSessionMember(/* pgrp */ 9999, /* sid */ 4242, /* childPid */ 4242), true);
  });
  it('a member of the child group is caught', () => {
    assert.equal(posixSessionMember(/* pgrp */ 4242, /* sid */ 1, 4242), true);
  });
  it('an unrelated process is not swept', () => {
    assert.equal(posixSessionMember(/* pgrp */ 77, /* sid */ 88, 4242), false);
  });
});
