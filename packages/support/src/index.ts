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
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

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
  /** Metadata-only callers need an isolated environment without creating dirs. */
  materialize?: boolean;
  /**
   * CANARY-OWNED observer injection (v1.1 Phase 2).
   *
   * This is deliberately NOT an env-merge and NOT a general `envExtra`: audit F9
   * removed that vector, and the master-pass M7 mutant ("merge the CALLER
   * environment under the sanitized one") must stay dead. Every value here is a
   * path or token CANARY computed — the directory must live inside Canary's own
   * workspace root, and the variable NAMES are fixed by `kind`, so no
   * caller/subject-supplied string can reach the child's environment through this
   * door.
   *
   * Only runners whose observer needs an environment injection use it: Python's
   * `sitecustomize` is found through PYTHONPATH. Rust/Go inject through argv and
   * need nothing here.
   */
  observer?: ObserverInjection | undefined;
}

export interface ObserverInjection {
  /** `python` = PYTHONPATH=<dir> + a nonce + no user site-packages. */
  kind: 'python';
  /** Directory holding Canary's observer bytes. Must resolve inside ws.root. */
  dir: string;
  /** Per-round binding token the observer echoes in its `hello` frame. */
  nonce: string;
}

export function sanitizedEnv({ ws, nodeDir, materialize = true, observer }: EnvOptions): NodeJS.ProcessEnv {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
  const home = path.join(ws.root, 'isolated-home');
  const tmp = path.join(ws.root, 'tmp');
  if (materialize) {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
  }
  // Canary-owned observer variables. Fail closed on anything that is not a real
  // directory inside Canary's own workspace: this door must never become a way to
  // put a subject-chosen path (or value) into a verification child's environment.
  const observed: NodeJS.ProcessEnv = {};
  if (observer !== undefined) {
    const rootReal = (() => { try { return fs.realpathSync(ws.root); } catch { return path.resolve(ws.root); } })();
    const dirReal = (() => { try { return fs.realpathSync(observer.dir); } catch { return null; } })();
    if (dirReal === null || !fs.statSync(dirReal).isDirectory()) {
      throw new Error(`observer injection directory does not exist: ${observer.dir}`);
    }
    const rel = path.relative(rootReal, dirReal);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`observer injection directory must live inside Canary's workspace root (got ${dirReal}, root ${rootReal})`);
    }
    if (observer.kind === 'python') {
      observed.PYTHONPATH = dirReal;
      observed.PYTHONNOUSERSITE = '1'; // keep a host user-site-packages tree out of the observation
      observed.CANARY_OBSERVER_NONCE = observer.nonce;
    }
  }

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
      ...observed,
    };
  }
  // POSIX analogues — the loader appends nothing here (child envp is exactly
  // what is passed); the observation test asserts equality on Linux CI.
  return {
    PATH: `${nodeDir}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    ...observed,
  };
}

/** Names of the env vars a child receives — recorded in evidence (names only). */
export function sanitizedEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).sort();
}

/**
 * Audit F-6 (GLM minor closure): the containment helpers (taskkill / ps /
 * powershell) ran with the FULL caller environment — an inconsistency with
 * the hygiene every other Canary child gets. These paths are and remain
 * NON-verdict-authoritative: no classification or promotion decision reads
 * their success (a failed sweep is reported `failed: true`, never as
 * "nothing survived"), so this closes env-inheritance hygiene, not a claimed
 * attack. Same deny-by-omission posture as sanitizedEnv — system tools only
 * need OS plumbing, so they get OS plumbing: no caller PATH, no NODE_OPTIONS,
 * no npm auth, no PSModulePath (PowerShell's module loader is an env-var code
 * vector; absent means its compiled-in defaults), and the Windows identity
 * vars stay neutralized (audit F6's loader behavior). TEMP/TMP point at the
 * host temp because these tools may scratch there; temp contents are not a
 * code path for `taskkill`, bare `ps`, or `-NoProfile` `powershell -Command`.
 * `SystemRoot` itself is still honored as-is — same-UID actors able to set
 * the caller environment can equally overwrite Canary's own state, which is
 * the documented local-forgery ceiling, not what this narrows.
 */
export function containmentEnv(): NodeJS.ProcessEnv {
  const tmp = os.tmpdir();
  if (process.platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
    const sys32 = path.join(systemRoot, 'System32');
    const tmpParsed = path.parse(tmp);
    const tmpDrive = tmpParsed.root.slice(0, 2);
    return {
      PATH: `${sys32};${systemRoot}`,
      PATHEXT: '.EXE;.CMD',
      SystemRoot: systemRoot,
      windir: systemRoot,
      ComSpec: path.join(sys32, 'cmd.exe'),
      TEMP: tmp,
      TMP: tmp,
      USERNAME: 'canary',
      USERDOMAIN: 'CANARY',
      LOGONSERVER: '\\\\CANARY',
      HOMEDRIVE: tmpDrive,
      HOMEPATH: tmp.slice(tmpParsed.root.length - 1),
      SYSTEMDRIVE: tmpDrive,
      HOME: tmp,
      USERPROFILE: tmp,
    };
  }
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: tmp };
}

/**
 * Resolve an OS tool at its absolute System32 location when it exists there;
 * otherwise fall back to the bare NAME, which containmentEnv restricts to
 * System32 + windir — a caller PATH entry is never consulted either way.
 */
export function resolveSystemTool(...parts: string[]): string {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
  const abs = path.join(systemRoot, 'System32', ...parts);
  const bare = parts[parts.length - 1] ?? '';
  return fs.existsSync(abs) ? abs : bare;
}

/** The POSIX `ps` fallback resolves absolutely from system dirs only, so a
 *  lying `ps` placed on the caller PATH can never forge the process table the
 *  sweep reads. Bare `ps` (sanitized PATH = /usr/bin:/bin) is the fail-safe
 *  when no system copy exists; ENOENT then yields the honest failed sweep. */
export function resolvePsBinary(): string {
  for (const c of ['/usr/bin/ps', '/bin/ps']) if (fs.existsSync(c)) return c;
  return 'ps';
}

/**
 * R2 host-neutrality: resolve the npm BUNDLED WITH THE RUNNING node, not some
 * npm found on PATH. Two real install layouts exist: the Windows/audit-host
 * layout (the directory containing the node executable carries
 * node_modules/npm) and the POSIX prefix layout (bin/node belongs to
 * <prefix>, whose npm lives at <prefix>/lib/node_modules/npm). Probing order
 * is legacy-first, so hosts that already resolved the old way keep resolving
 * to the SAME byte-for-byte path. PATH and env are never consulted: an
 * untrusted shell must not be able to steer which npm Canary samples.
 * Returns null when NO bundled npm exists — callers must fail or skip
 * explicitly, never record an empty sample as if it were a measurement.
 */
export function resolveNpmCli(): string | null {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

export interface RunOptions {
  ws: WorkspaceLayout;
  nodeDir: string;
  argv: [string, ...string[]];
  cwd?: string;
  timeoutSecs?: number;
  /**
   * Observation hardening: open a FOURTH stdio slot (child fd 3) as a pipe
   * and return its bytes in `observation`. Used ONLY for measurement rounds
   * where Canary injected its own observer into the child — the channel is
   * inherited by the spawned process, never by the subject's own tools.
   * 'close' waits for every stdio stream, so no post-exit race exists.
   */
  observeChildFd3?: boolean;
  /**
   * Canary-owned observer environment injection for a round that injects its own
   * observer bytes (v1.1 Phase 2). Passed straight through to `sanitizedEnv`,
   * where the variable names are fixed by `kind` and the directory must live
   * inside Canary's workspace root — see `ObserverInjection`.
   */
  observer?: ObserverInjection;
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
  /** Raw fd-3 bytes when observeChildFd3 was set (NDJSON frames; '' if none). */
  observation?: string | undefined;
  /** True if fd-3 bytes exceeded MAX_OBS_CHARS and were cut (⇒ INVALID later). */
  observationTruncated?: boolean | undefined;
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
        stdio: o.observeChildFd3 ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        exitCode: -1, killedByTimeout: false, stdout: '',
        stderr: String((e as Error).message ?? e), durationMs: Date.now() - start,
        argv: [...o.argv], envKeys,
        ...(o.observeChildFd3 ? { observation: '' } : {}),
      });
      return;
    }
    const childPid = child.pid;
    const spawnedAtMs = Date.now();
    let stdout = '';
    let stderr = '';
    let obs = '';
    let obsTruncated = false;
    let killed = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout = cap(stdout + d); });
    child.stderr?.on('data', (d: string) => { stderr = cap(stderr + d); });
    // NOTE (panel I implementation trap): stdio spec ['ignore','pipe','pipe',
    // 'pipe'] makes CHILD fd 3 the fourth entry — on the PARENT side these
    // pipes occupy fds 2/3/4, but child.stdio[] is indexed by CHILD fd, so
    // child.stdio[3] is the observation read-stream. Never hardcode the
    // parent's raw fd number here.
    // The parent end of a 'pipe' stdio entry is a node:stream.Readable at
    // runtime (the ChildProcess typings only promise NodeJS.ReadableStream,
    // which lacks destroy()/destroyed — the members the bye-shortcut and the
    // bounded post-exit window need). One narrowing cast, documented.
    let f3stream: Readable | undefined;
    if (o.observeChildFd3) {
      const f3 = child.stdio[3];
      if (f3 && 'on' in f3) {
        f3stream = f3 as unknown as Readable;
        f3stream.setEncoding('utf8');
        f3stream.on('data', (d: string) => {
          if (obsTruncated) return;
          const room = MAX_OBS_CHARS - obs.length;
          if (d.length > room) { obs += d.slice(0, Math.max(0, room)); obsTruncated = true; } else obs += d;
          // BYE-SHORTCUT: once the terminator arrives as the LAST COMPLETE
          // line (trailing \n required — a chunk boundary mid-frame must not
          // cut a legitimate bye, and junk after bye means no shortcut: the
          // validator's bye-last rule rejects those bytes anyway), destroy
          // our read end so `close` cannot be delayed by an fd-3 holder that
          // outlived the runner.
          if (/\{"k":"bye"[^\n]*\n$/.test(obs)) {
            try { f3stream?.destroy(); } catch { /* already ended */ }
          }
        });
      }
    }

    // POST-EXIT BOUNDED WINDOW (panel I): the child is gone but fd 3 never
    // delivered a complete bye — a descendant is holding the pipe open, or
    // the preload died mid-write. Keep draining for a bounded window, then
    // cut the read end so `close` resolves. No bye ⇒ the validator sees
    // hello-bye-boundary/flood ⇒ INVALID regardless: this window trades a
    // 600s hang for a 2s delay, it cannot forge or rescue anything.
    child.on('exit', () => {
      if (!f3stream || f3stream.destroyed) return;
      setTimeout(() => { try { f3stream?.destroy(); } catch { /* already ended */ } }, POST_EXIT_DRAIN_MS);
    });

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
        ...(o.observeChildFd3 ? { observation: obs, observationTruncated: obsTruncated } : {}),
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
        ...(o.observeChildFd3 ? { observation: obs, observationTruncated: obsTruncated } : {}),
      });
    });
  });
}

const MAX_STREAM_CHARS = 64 * 1024 * 1024;
// FD-3 observation frames are tiny by construction (one short JSON line per
// lifecycle event); 4 MiB is orders of magnitude beyond any honest suite, so
// exceeding it means flood/truncation — the validator turns that INVALID.
const MAX_OBS_CHARS = 4 * 1024 * 1024;
/** Drain window after child exit when no `bye` has arrived (panel I). */
const POST_EXIT_DRAIN_MS = 2000;
function cap(s: string): string {
  return s.length > MAX_STREAM_CHARS ? s.slice(0, MAX_STREAM_CHARS) : s;
}

/** Windows: taskkill /T /F walks the live tree. POSIX: negative pgid (child
 *  was spawned detached => own process group). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // F-6: absolute trusted resolution + sanitized env. The catch below is
      // the fail-safe: an unresolvable taskkill falls to direct SIGKILL, and
      // killTree's whole contract (best-effort) is unchanged.
      spawnSync(resolveSystemTool('taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
        { timeout: 15_000, env: containmentEnv() });
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

/** Row shape collected by both process-table sources (sweep membership). */
export type ProcessRow = { p: number; ppid: number; pgrp: number; sid: number };

/**
 * The `ps` fallback of sweepPosix (hosts without /proc), extracted with a
 * default ARGUMENT so it is testable where /proc always exists: trusted
 * resolution + sanitized env are the production shape. `null` means the tool
 * could not run — the caller reports the sweep as FAILED ("could not look"
 * is never rendered as "no survivors"; audit F5 honesty law unchanged).
 */
export function psTableRows(psBin: string = resolvePsBinary()): ProcessRow[] | null {
  const ps = spawnSync(psBin, ['-o', 'pid=,ppid=,pgid=,sid='],
    { timeout: 10_000, encoding: 'utf8', env: containmentEnv(), shell: false });
  if (ps.error || ps.status !== 0 || typeof ps.stdout !== 'string') return null;
  const rows: ProcessRow[] = [];
  for (const line of ps.stdout.split('\n')) {
    const [p, pp, pg, sd] = line.trim().split(/\s+/).map(Number);
    if (p === undefined || pp === undefined || !Number.isFinite(p) || !Number.isFinite(pp)) continue;
    rows.push({
      p, ppid: pp,
      pgrp: pg !== undefined && Number.isFinite(pg) ? pg : -1,
      sid: sd !== undefined && Number.isFinite(sd) ? sd : -1,
    });
  }
  return rows;
}

function sweepPosix(pid: number): SweepResult {
  const killed: number[] = [];
  // collect: [pid, ppid, pgrp, session]
  const rows: ProcessRow[] = [];
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
    const psRows = psTableRows();
    if (psRows === null) return { killed, failed: true };
    rows.push(...psRows);
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
  // F-6: same trusted absolute System32 resolution (bare-name fail-safe is
  // unchanged), plus the sanitized environment on the spawn below.
  const psExe = resolveSystemTool('WindowsPowerShell', 'v1.0', 'powershell.exe');
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
  const r = spawnSync(psExe,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 30_000, windowsHide: true, encoding: 'utf8', shell: false, env: containmentEnv() });
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

export * from './knownRunners.js';

export class CanaryError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
    this.name = 'CanaryError';
  }
}
