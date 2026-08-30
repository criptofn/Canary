/**
 * Sanitized process execution — the security contract of docs/SECURITY.md
 * implemented as the ONLY way Canary spawns external processes.
 *
 * Allowlist by construction: anything not listed is invisible to untrusted
 * fixture code — Anthropic / GitHub / cloud credentials, SSH agents,
 * NODE_OPTIONS, user npm auth — everything not in the list simply does not
 * exist for the child process.
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
    };
  }
  // POSIX analogues
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
}

/**
 * Run a command under the sanitized environment. argv arrays only — `shell`
 * is never enabled, env is fully REPLACED (deny-by-omission; there is
 * deliberately no env-merge option: red-team finding F9 removed the
 * `envExtra` overwrite vector). stdout/stderr captured as UTF-8 strings.
 *
 * Timeout performs a PROCESS-TREE kill (F2): a killed test runner must not
 * leave orphaned grandchildren holding ports/files that would poison later
 * rounds asymmetrically into a false CONFIRMED_REGRESSION.
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
      resolve({
        exitCode: killed ? -1 : (code ?? (signal ? -1 : -1)),
        killedByTimeout: killed,
        stdout, stderr,
        durationMs: Date.now() - start,
        argv: [...o.argv], envKeys,
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
