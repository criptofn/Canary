/**
 * Sanitized process execution — the security contract of docs/SECURITY.md
 * implemented as the ONLY way Canary spawns external processes.
 *
 * Allowlist by construction: anything not listed is invisible to untrusted
 * fixture code — Anthropic / GitHub / cloud credentials, SSH agents,
 * NODE_OPTIONS, user npm auth — everything not in the list simply does not
 * exist for the child process. Exception found by audit F6: the Windows
 * loader appends logon-session identity vars on top of any replaced block;
 * sanitizedEnv NEUTRALIZES those too (fixed values), so the child's observed
 * environment equals the declared allowlist on both platforms — verified by
 * the permanent observation test (test/env.test.ts), not by prose.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceLayout {
  /** Disposable run root (everything lives under it). */
  root: string;
  /** Directory the fixture content is extracted into. */
  fixture: string;
}

export interface EnvOptions {
  ws: WorkspaceLayout;
  /** Node + system binaries only. */
  nodeDir: string;
}

export function sanitizedEnv({ ws, nodeDir }: EnvOptions): NodeJS.ProcessEnv {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
  const home = path.join(ws.root, 'isolated-home');
  const tmp = path.join(ws.root, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });

  if (process.platform === 'win32') {
    // Audit F6 (executed probe, 2026-08-30): the Windows process loader
    // APPENDS logon-session identity vars (USERNAME, USERDOMAIN, LOGONSERVER,
    // HOMEDRIVE, HOMEPATH, SYSTEMDRIVE, ...) to every child environment even
    // when `env` is fully replaced — env:{} still yielded the real ones.
    // They are not in the parent block; they come from the logon session.
    // Containment therefore requires NEUTRALIZING them explicitly: a var
    // present in the given block is NOT overwritten by the loader (proven by
    // the same probe), so declaring them with fixed non-identity values makes
    // the child's OBSERVED environment equal to the DECLARED allowlist.
    // The permanent observation test in test/env.test.ts pins this contract.
    const homeParsed = path.parse(home); // { root: 'C:\\', ... }
    const homeDrive = homeParsed.root.slice(0, 2); // 'C:'
    const homeRelative = home.slice(homeParsed.root.length - 1); // '\\Users\\...'
    return {
      PATH: `${nodeDir};${path.join(systemRoot, 'System32')};${systemRoot}`,
      PATHEXT: '.EXE;.CMD',
      SystemRoot: systemRoot,
      windir: systemRoot,
      ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
      TEMP: tmp,
      TMP: tmp,
      HOME: home,
      USERPROFILE: home,
      // Neutralized session identity (loader would otherwise inject the real
      // account identity into every fixture-visible environment):
      USERNAME: 'canary',
      USERDOMAIN: 'CANARY',
      LOGONSERVER: '\\\\CANARY',
      HOMEDRIVE: homeDrive,
      HOMEPATH: homeRelative,
      SYSTEMDRIVE: homeDrive,
    };
  }
  // POSIX analogues — the loader appends nothing here (child envp is exactly
  // what is passed); the observation test asserts equality on Linux CI.
  return {
    PATH: `${nodeDir}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
  };
}

/** Names of the env vars a child receives — recorded in evidence (names only). */
export function sanitizedEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).sort();
}

export interface RunOptions {
  ws: WorkspaceLayout;
  nodeDir: string;
  argv: [string, ...string[]];
  cwd?: string;
  timeoutSecs?: number;
}

export interface RunOutcome {
  /** Process exit code; -1 reserved for killed (timeout or signal death). */
  exitCode: number;
  killedByTimeout: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  argv: readonly string[];
  envKeys: readonly string[];
  /** PID Canary spawned (absent on spawn-error paths). */
  childPid?: number | undefined;
  /**
   * Audit F5: descendant PIDs still alive when the child exited, swept after
   * close. Empty means the sweep ran cleanly and found no survivors; see
   * `sweepFailed` for the difference between "nothing survived" and
   * "could not look".
   */
  sweptPids?: number[] | undefined;
  sweepFailed?: boolean | undefined;
}

/**
 * Run a command under the sanitized environment. argv arrays only — `shell`
 * is never enabled, env is fully REPLACED (deny-by-omission; there is
 * deliberately no env-merge option: red-team finding F9 removed the
 * `envExtra` overwrite vector). stdout/stderr captured as UTF-8 strings.
 *
 * Timeout performs a PROCESS-TREE kill (F2): a killed test runner must not
 * leave orphaned grandchildren holding ports/files that would poison later
 * rounds asymmetrically into a false CONFIRMED_REGRESSION. And per audit F5,
 * containment is also enforced on NORMAL exit: after every child close a
 * descendant sweep runs (see sweepDescendants).
 */
export async function runCommand(o: RunOptions): Promise<RunOutcome> {
  const env = sanitizedEnv(o);
  const envKeys = sanitizedEnvKeys(env);
  const start = Date.now();
  return new Promise<RunOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(o.argv[0], o.argv.slice(1), {
        cwd: o.cwd ?? o.ws.fixture,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        exitCode: -1, killedByTimeout: false, stdout: '',
        stderr: String((e as Error).message ?? e), durationMs: Date.now() - start,
        argv: [...o.argv], envKeys,
      });
      return;
    }
    const childPid = child.pid;
    const spawnedAtMs = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout = cap(stdout + d); });
    child.stderr?.on('data', (d: string) => { stderr = cap(stderr + d); });

    const timer = setTimeout(() => {
      killed = true;
      killTree(child.pid);
    }, (o.timeoutSecs ?? 600) * 1000);

    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += `\nspawn error: ${err.message}`;
      resolve({
        exitCode: -1, killedByTimeout: false, stdout, stderr,
        durationMs: Date.now() - start, argv: [...o.argv], envKeys,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Audit F5: containment must hold on NORMAL exit too, not just timeout.
      // The child is gone but its descendants may live on (a runner's helper
      // daemons holding ports/files poison later rounds asymmetrically).
      // Sweeps AFTER exit are still precise: Windows keeps the numeric PPID of
      // a dead parent in its process records, and on POSIX the child was
      // spawned detached into its own process group which outlives it.
      const sweep = sweepDescendants(childPid, spawnedAtMs);
      resolve({
        exitCode: killed ? -1 : (code ?? (signal ? -1 : -1)),
        killedByTimeout: killed,
        stdout, stderr,
        durationMs: Date.now() - start,
        argv: [...o.argv], envKeys,
        childPid, sweptPids: sweep.killed, sweepFailed: sweep.failed,
      });
    });
  });
}

const MAX_STREAM_CHARS = 64 * 1024 * 1024;
function cap(s: string): string {
  return s.length > MAX_STREAM_CHARS ? s.slice(0, MAX_STREAM_CHARS) : s;
}

/** Windows: taskkill /T /F walks the live tree. POSIX: negative pgid (child
 *  was spawned detached => own process group). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
}

/** Result of the audit-F5 post-exit containment sweep. */
export interface SweepResult {
  killed: number[];
  /** True when the sweep could not run/complete — "no survivors" is then unknown. */
  failed: boolean;
}

const SWEEP_MAX_PROCESSES = 200;

/**
 * Audit F5: after the spawned child has EXITED (normal or killed), sweep any
 * descendants that outlived it. Precise on both platforms post-exit:
 *  - Windows: `Win32_Process.ParentProcessId` keeps the numeric PPID of a dead
 *    parent, so a BFS over stale-PPID lineage finds grandchildren even when
 *    intermediate ancestors are gone. A CreationDate >= spawn-time filter
 *    guards against PID-reuse collateral (a recycled PPID belongs to a newer
 *    unrelated tree).
 *  - POSIX: the child was spawned `detached` => it led its own process GROUP
 *    and SESSION (setsid ⇒ sid == childPid). Members still alive after close
 *    are found via /proc (or `ps`) by SESSION or group membership (audit S1:
 *    a descendant that setpgid()s into its own group but keeps the session is
 *    now caught) plus a transitive PPID BFS, then SIGKILLed, and the whole pgid
 *    is signalled as a race backstop.
 *
 * Residual gap, documented honestly (SECURITY.md): a POSIX descendant that
 * `setsid()`s itself (double-fork daemonization) leaves BOTH the group and the
 * session before the parent dies and is then indistinguishable — that is out of
 * sweep reach on both platforms absent a kernel containment primitive (Job
 * Objects / cgroups), which v0.1 does not claim.
 */
export function sweepDescendants(pid: number | undefined, spawnedAtMs: number): SweepResult {
  if (!pid || pid <= 0) return { killed: [], failed: false };
  try {
    return process.platform === 'win32'
      ? sweepWin32(pid, spawnedAtMs)
      : sweepPosix(pid);
  } catch {
    return { killed: [], failed: true };
  }
}

function sweepPosix(pid: number): SweepResult {
  const killed: number[] = [];
  // collect: [pid, ppid, pgrp, session]
  const rows: Array<{ p: number; ppid: number; pgrp: number; sid: number }> = [];
  if (fs.existsSync('/proc')) {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat = '';
      try { stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
      // fields after the parenthesized comm: state ppid pgrp session ...
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]); const pgrp = Number(rest[2]); const sid = Number(rest[3]);
      if (!Number.isFinite(ppid)) continue;
      rows.push({ p: Number(entry), ppid, pgrp, sid });
    }
  } else {
    const ps = spawnSync('ps', ['-o', 'pid=,ppid=,pgid=,sid='], { timeout: 10_000, encoding: 'utf8' });
    if (ps.status !== 0) return { killed, failed: true };
    for (const line of ps.stdout.split('\n')) {
      const [p, pp, pg, sd] = line.trim().split(/\s+/).map(Number);
      if (p === undefined || pp === undefined || !Number.isFinite(p) || !Number.isFinite(pp)) continue;
      rows.push({
        p, ppid: pp,
        pgrp: pg !== undefined && Number.isFinite(pg) ? pg : -1,
        sid: sd !== undefined && Number.isFinite(sd) ? sd : -1,
      });
    }
  }
  // Membership: same session as the (setsid'd) child — catches descendants that
  // setpgid()ed into their own group but never escaped the session; OR stale
  // direct-ppid lineage (BFS below handles intermediate deaths). A process that
  // BOTH setsid()es and reparents is a documented residual (SECURITY Tier B).
  const inSession = (r: { pgrp: number; sid: number }): boolean => posixSessionMember(r.pgrp, r.sid, pid);
  const members = new Set<number>();
  for (const r of rows) {
    if (r.p === pid || r.p === process.pid) continue;
    if (inSession(r)) members.add(r.p);
  }
  // transitive PPID BFS (catches lineage whose session was reset but parentage
  // retained — rare, bounded by SWEEP_MAX_PROCESSES)
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.p === pid || r.p === process.pid || members.has(r.p)) continue;
      if (members.has(r.ppid)) { members.add(r.p); grew = true; }
    }
  }
  for (const m of members) {
    if (killed.length >= SWEEP_MAX_PROCESSES) break;
    try { process.kill(m, 'SIGKILL'); killed.push(m); } catch { /* already dead */ }
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already empty */ }
  return { killed, failed: false };
}

/**
 * Audit S1 (F10-adjacent): a process belongs to the swept child's lineage if it
 * is in the child's SESSION (the detached child is its own session leader, so
 * sid === child pid, and setpgid() descendants keep that sid) or directly
 * parented by it. Exported for unit testing of the predicate alone.
 */
export function posixSessionMember(pgrp: number, sid: number, childPid: number): boolean {
  return sid === childPid || pgrp === childPid;
}

function sweepWin32(pid: number, spawnedAtMs: number): SweepResult {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
  const psExe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // 60s clock slack: CIM CreationDate truncates to seconds.
  const cut = new Date(spawnedAtMs - 60_000).toISOString();
  const script =
    `$cut=[DateTime]::Parse('${cut}').ToUniversalTime();` +
    `$q=New-Object System.Collections.Generic.Queue[int]; $q.Enqueue(${pid});` +
    `$done=New-Object System.Collections.Generic.HashSet[int]; $k=@();` +
    `while($q.Count -and $done.Count -lt ${SWEEP_MAX_PROCESSES}){` +
    `$p=$q.Dequeue(); if(-not $done.Add($p)){continue};` +
    `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$p" -ErrorAction SilentlyContinue | ForEach-Object{` +
    `if($_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $cut){` +
    `$q.Enqueue($_.ProcessId);` +
    `try{ Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $k+=$_.ProcessId }catch{} ` +
    `} } };` +
    `$k -join ','`;
  const r = spawnSync(fs.existsSync(psExe) ? psExe : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 30_000, windowsHide: true, encoding: 'utf8', shell: false });
  if (r.error || r.status !== 0) return { killed: [], failed: true };
  const text = (r.stdout ?? '').trim();
  const killed = text
    ? text.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  return { killed, failed: false };
}

export const ExitCode = {
  CONFIRMED_REGRESSION: 0,
  PASS: 1,
  OTHER_CLASSIFICATION: 2,
  MISUSE: 3,
} as const;

export class CanaryError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
    this.name = 'CanaryError';
  }
}
