/**
 * THE INTEGRITY BOUNDARY — an attempt at a real, non-privileged worker/authority separation.
 *
 * STATUS: Win32 restricted LOW child execution is measured available on this host.
 * This is write integrity only, not a production HARDENED provider.
 *
 * WHY THIS IS A DIFFERENT MECHANISM FROM `boundary.ts`:
 *
 * `provider/boundary.ts` measures an IDENTITY boundary: a second OS account, a service
 * account, a DACL naming that account. Building one needs an administrator, which is why it
 * prints an install plan and executes nothing.
 *
 * This module was written to implement a MANDATORY INTEGRITY CONTROL boundary instead, which in
 * principle needs no privilege at all:
 *
 *   - a user may lower the integrity label of a directory they own (`icacls /setintegritylevel`);
 *   - a user may (in principle) start a process at a lower integrity level (`runas /trustlevel`);
 *   - and then the KERNEL — not Canary, not a check, not a convention — refuses that process
 *     write access to the higher-integrity objects.
 *
 * WHAT WAS HISTORICALLY MEASURED BEFORE THE WIN32 HELPER (`tooling/probes/v12-integrity-boundary.mjs`, which writes its record
 * to the OS temp dir):
 *
 *   - applying the label WORKS: `icacls /setintegritylevel` succeeds on a directory this user owns;
 *   - starting a lowered process does NOT work on this host: `runas.exe` exits 1 with EMPTY stdout
 *     and stderr for EVERY input, including an invalid trust level and `/?`. Its exit code carries
 *     no information, so it must never be used as evidence;
 *   - therefore no confinement was established, no attack was executed, and the battery reports
 *     `ATTACKS BLOCKED: 0/0` rather than a number.
 *
 * A FALSE POSITIVE WAS FOUND AND RETRACTED HERE. The first version of the probe reported a working
 * boundary. It was wrong: its control write and its confined write used the SAME filename, so the
 * control's own success satisfied the confined check — the probe measured itself and called it a
 * boundary. The corrected probe gives every attempt a unique file, requires the CHILD's own pid in
 * the content, and reports a child that never ran as "not evidence of a boundary" rather than as
 * protection. See the audit trail in `docs/V1.2-PLAN.md`.
 *
 * CURRENT MEASUREMENT: the Win32 helper is tried before the historical runas fallback.
 * Its low child executes; the corrected attack battery measures 8/8 denied writes and 2/2
 * useful-work controls. Missing child evidence and ENOENT are never credited as protection.
 *
 * It is deliberately NOT wired into the product's decision path: `provider/boundary.ts` still owns
 * the six controls and `measuredCapabilities` is still the only producer of `HARDENED`. Importing
 * this module changes no verdict, and no product surface claims a level from it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The integrity labels this module can apply, lowest first. */
export type IntegrityLevel = 'untrusted' | 'low' | 'medium';

/** How to start a process at a level, per platform. `argvPrefix` is prepended to a command. */
export interface LevelLauncher {
  level: IntegrityLevel;
  kind: 'runas-trustlevel' | 'powershell-win32-restricted' | 'bwrap' | 'unshare';
  argvPrefix: string[];
}

export interface IntegrityPrimitive {
  /** Can an integrity boundary be established on this host at all? */
  available: boolean;
  /** The label the authority side sits at. Always `medium` — the ordinary, unmodified level. */
  authorityLevel: IntegrityLevel;
  /** The labels a worker can be confined to, strongest first. */
  workerLevels: IntegrityLevel[];
  /** How each worker level is launched, when it is available. */
  launchers: LevelLauncher[];
  /** Raw observations, kept so a human can re-check the reasoning rather than trust a verdict. */
  observations: string[];
  /** Why it is unavailable, when it is. */
  reason: string | null;
}

export interface BoundaryApplication {
  /** The directory whose label was applied (the authority root). */
  target: string;
  applied: boolean;
  level: IntegrityLevel;
  /** The command's own exit code and output, so a failure is inspectable. */
  command: string;
  exitCode: number | null;
  stderr: string;
  reason: string | null;
}

const WIN_TRUSTLEVEL: Record<string, string> = {
  untrusted: '/trustlevel:0x20000',
  low: '/trustlevel:0x10000',
  medium: '/trustlevel:0x100000',
};

function windowsHelper(): string | null {
  if (process.platform !== 'win32') return null;
  const p = path.resolve(import.meta.dirname, '../../../../../tools/windows-boundary/restricted-runner.ps1');
  return fs.existsSync(p) ? p : null;
}
function quoteArg(value: string): string {
  return value === '' || /[\s"]/.test(value) ? `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"` : value;
}

/**
 * Start a contained process and WAIT for it, then report what it did.
 *
 * WHY FILE EVIDENCE AND NOT A PIPE OR AN EXIT CODE — this is the part that is easy to get wrong,
 * and it was measured wrong first:
 *
 * `runas /trustlevel` launches the command through the Secondary Logon service and hands the
 * caller its OWN exit code, not the child's. Observed on the development host: `runas` reported
 * exit 1 with EMPTY stdout and stderr for a command that in fact STARTED and RAN. Reading that
 * refusal as "no boundary on this host" would have been a false negative — the boundary was there.
 *
 * So the child writes TWO facts: a launch marker (proving it ran at all) and the outcome of its
 * operation, both to files OUTSIDE the protected tree so that a confined child can still report.
 * The presence and content of those files cannot be faked by the launcher's exit code.
 *
 * @returns `{ ran, result, exitCode, output }` — `ran` is true only when the launch marker exists,
 *          which is the one fact that separates "the command ran and was refused" from "the command
 *          never ran". A caller must treat `ran: false` as NO EVIDENCE, never as protection.
 */
export function containedRun(
  level: IntegrityLevel,
  script: string,
  launchEvidencePath: string,
  timeoutMs = 45_000,
  primitive?: IntegrityPrimitive,
): { ran: boolean; result: string; exitCode: number | null; output: string } {
  const p = primitive ?? observeIntegrityPrimitive();
  const launcher = p.launchers.find((l) => l.level === level);
  if (launcher === undefined) return { ran: false, result: 'NO-LAUNCHER', exitCode: null, output: '' };
  // A low-integrity child cannot write a normal medium-integrity temp directory. Make only the
  // launch-evidence parent low-integrity; it is disposable observation plumbing, never authority.
  if (process.platform === 'win32') applyAuthorityLabel(path.dirname(launchEvidencePath), 'low');

  const args = ['-e', script, launchEvidencePath];
  const argv = launcher.kind === 'powershell-win32-restricted'
    ? [...launcher.argvPrefix, '-Integrity', level, '-CommandLine', [process.execPath, ...args].map(quoteArg).join(' ')]
    : [...launcher.argvPrefix, process.execPath, ...args];
  const r = spawnSync(argv[0] as string, argv.slice(1), { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' });

  let result: string;
  let ran = false;
  try {
    result = fs.readFileSync(launchEvidencePath, 'utf8').trim();
    ran = true;
  } catch {
    result = 'NO-EVIDENCE';
  }
  return { ran, result, exitCode: r.status ?? null, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/**
 * Run a command and capture its exit code, stdout and stderr.
 *
 * Captured through FILES rather than pipes. Two independent reasons, both measured on the
 * development host:
 *   - a confined host can refuse piped stdio with EPERM for every command, which would make the
 *     boundary look absent when it is merely unmeasurable;
 *   - `runas` does not reliably forward a child's streams at all.
 * Product code cannot import the benchmark's helper, so the small amount of logic is duplicated
 * deliberately rather than creating a dependency from the product onto `tooling/`.
 */
function run(command: string, args: string[], timeoutMs = 30_000): { exitCode: number | null; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-il-run-'));
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let status: number | null = null;
  let failure = '';
  try {
    const r = spawnSync(command, args, { timeout: timeoutMs, windowsHide: true, stdio: ['ignore', outFd, errFd] });
    status = r.status ?? null;
    if (r.error) failure = r.error.message;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const read = (p: string): string => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  const result = { exitCode: failure === '' ? status : null, stdout: read(outPath), stderr: read(errPath) };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

/**
 * Observe whether the host can establish an integrity boundary.
 *
 * Measured, never assumed, and deliberately NOT by trusting a launcher's exit code: the probe
 * starts a real process at the lowered level and requires the process itself to leave evidence
 * that it ran. A `runas` that exists but cannot start anything leaves no evidence, so it is
 * reported unavailable rather than optimistically available.
 */
export function observeIntegrityPrimitive(platform: NodeJS.Platform = process.platform): IntegrityPrimitive {
  const observations: string[] = [];

  if (platform === 'win32') {
    const icacls = run('where.exe', ['icacls.exe']);
    const hasIcacls = icacls.exitCode === 0;
    observations.push(`icacls: ${hasIcacls ? 'present' : 'MISSING'}`);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-il-observe-'));
    applyAuthorityLabel(scratch, 'low');
    const launchers: LevelLauncher[] = [];
    try {
      const helper = windowsHelper();
      for (const level of ['untrusted', 'low'] as const) {
        if (helper !== null) {
          const evidence = path.join(scratch, `ran-${level}.txt`);
          const argv = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
            '-Integrity', level, '-CommandLine', [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', evidence].map(quoteArg).join(' ')];
          const r = spawnSync(argv[0]!, argv.slice(1), { timeout: 45_000, windowsHide: true, encoding: 'utf8' });
          const ran = fs.existsSync(evidence);
          observations.push(`Win32 restricted ${level}: ran=${ran} (launcher exit ${String(r.status ?? null)}, stderr=${(r.stderr ?? '').trim()})`);
          if (ran) launchers.push({ level, kind: 'powershell-win32-restricted', argvPrefix: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper] });
          continue;
        }
        const token = WIN_TRUSTLEVEL[level];
        if (token === undefined) continue;
        const evidence = path.join(scratch, `ran-${level}.txt`);
        const probe = 'require("node:fs").writeFileSync(process.argv[1], "ran")';
        const argv = ['runas.exe', token, process.execPath, '-e', probe, evidence];
        const r = spawnSync(argv[0] as string, argv.slice(1), { timeout: 45_000, windowsHide: true, encoding: 'utf8' });
        const ran = fs.existsSync(evidence);
        observations.push(`runas ${token}: ran=${ran} (launcher exit ${String(r.status ?? null)})`);
        if (ran) launchers.push({ level, kind: 'runas-trustlevel', argvPrefix: ['runas.exe', token] });
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    return {
      available: hasIcacls && launchers.length > 0,
      authorityLevel: 'medium',
      workerLevels: launchers.map((l) => l.level),
      launchers,
      observations,
      reason: hasIcacls
        ? (launchers.length > 0 ? null : 'the Win32 restricted-token helper and runas /trustlevel could not START a lowered process on this host')
        : 'icacls is not available, so an integrity label cannot be applied',
    };
  }

  // POSIX: an integrity LABEL does not exist, but a mount namespace is a comparable (and
  // stronger) confinement. This is not implemented in v1.2; reported as unavailable rather than
  // silently mapped onto a mechanism whose properties were never measured here.
  observations.push(`platform ${platform}: no integrity-level mechanism is implemented (Linux uses bwrap/unshare, tracked separately)`);
  return {
    available: false,
    authorityLevel: 'medium',
    workerLevels: [],
    launchers: [],
    observations,
    reason: 'integrity levels are a Windows mechanism; on this platform the confinement would have to be a namespace, which v1.2 does not implement',
  };
}

/**
 * Apply the authority label to a directory tree, so a confined worker cannot write it.
 *
 * `medium` is the ordinary level — applying it to a directory the user owns is a no-op for
 * access and exists so the operation is explicit and reversible. The real work is done by the
 * WORKER running BELOW it.
 */
export function applyAuthorityLabel(target: string, level: IntegrityLevel = 'medium', timeoutMs = 30_000): BoundaryApplication {
  if (process.platform !== 'win32') {
    return { target, applied: false, level, command: 'n/a', exitCode: null, stderr: '', reason: 'integrity labels are a Windows mechanism' };
  }
  if (!fs.existsSync(target)) {
    return { target, applied: false, level, command: 'n/a', exitCode: null, stderr: '', reason: `no such path: ${target}` };
  }
  const args = [target, '/setintegritylevel', `(OI)(CI)${level}`, '/T', '/C', '/Q'];
  const r = run('icacls.exe', args, timeoutMs);
  return {
    target,
    applied: r.exitCode === 0,
    level,
    command: `icacls ${args.join(' ')}`,
    exitCode: r.exitCode,
    stderr: r.stderr.trim(),
    reason: r.exitCode === 0 ? null : `icacls exited ${String(r.exitCode)}`,
  };
}

/**
 * The argv that runs `command` under the boundary at `level`.
 *
 * The authority NEVER uses this to run its own work — it exists so the worker can be launched
 * confined, and so the attack battery can attempt, from inside the boundary, the things a hostile
 * worker would attempt.
 */
export function confinedArgv(level: IntegrityLevel, command: string, args: string[], primitive?: IntegrityPrimitive): string[] | null {
  const p = primitive ?? observeIntegrityPrimitive();
  const launcher = p.launchers.find((l) => l.level === level);
  if (launcher === undefined) return null;
  if (launcher.kind === 'runas-trustlevel') return [...launcher.argvPrefix, command, ...args];
  if (launcher.kind === 'powershell-win32-restricted') return [...launcher.argvPrefix, '-Integrity', level, '-CommandLine', [command, ...args].map(quoteArg).join(' ')];
  return [...launcher.argvPrefix, command, ...args];
}

/** A one-line description of what the boundary MEASURABLY protects, for reports. */
export function boundaryScope(primitive?: IntegrityPrimitive): string {
  const p = primitive ?? observeIntegrityPrimitive();
  if (!p.available) return `no integrity boundary on this host (${String(p.reason)})`;
  return `a worker confined to ${p.workerLevels.join('/')} integrity cannot WRITE the ${p.authorityLevel}-integrity authority tree; it can still read it and still write unprotected paths`;
}

/**
 * The directories whose contents are the root of trust, given a project root.
 *
 * This is the list a boundary must actually protect, and naming it here keeps the attack battery
 * and any future provider aligned: the sealed store is the obvious one, but the frozen plan
 * record, the candidate registry and the broker token are just as load-bearing. `.git` is NOT in
 * this list — the worker must be able to commit in its candidate worktree; the base's protection
 * comes from the authority verifying committed bytes, not from write denial.
 */
export function authorityPaths(projectRoot: string, storeRoot: string): string[] {
  return [
    storeRoot,
    path.join(projectRoot, '.canary'),
  ];
}
