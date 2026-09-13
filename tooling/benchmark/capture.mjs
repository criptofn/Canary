/**
 * Run a child process and capture its exit code, stdout and stderr — through FILES, not pipes.
 *
 * WHY THIS EXISTS RATHER THAN `spawnSync(..., { encoding: 'utf8' })`:
 *
 * MEASURED, this host, 2026-09 (`tooling/probes/v12-host-capabilities.mjs`): a confined
 * environment refuses piped stdio with EPERM for EVERY command, while the file-descriptor shape
 * succeeds. With pipes, the benchmark could not run a single trial:
 *
 *   - `run-trial.mjs` died at `git init failed:` with an empty stderr;
 *   - `fixtures.test.mjs` reported `status null` and empty output for every state, so it could
 *     not validate a single fixture;
 *   - and Node's own test runner fails the same way, which is why this repository's probes are
 *     plain scripts.
 *
 * This is a PORTABILITY change, not a measurement change: none of these call sites consumed a
 * pipe incrementally. They all read the exit code and the complete text after the process
 * closed, which is exactly what a temp file returns — same bytes, same order, same moment.
 *
 * The helper is deliberately sync-only and takes no callback: `spawn` with `stdio: 'inherit'`
 * already exists when a caller wants streaming.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, env?: object}} [opts]
 * @returns {{status: number|null, stdout: string, stderr: string, error: string|null, timedOut: boolean, secs: number}}
 */
export function runCaptured(command, args, opts = {}) {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cap-'));
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout ?? 180_000,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
  } catch (e) {
    result = { error: e };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  const errorCode = result.error ? (result.error.code ?? String(result.error)) : null;
  const captured = {
    status: result.status ?? null,
    stdout: read(outPath),
    stderr: read(errPath),
    error: errorCode,
    timedOut: errorCode === 'ETIMEDOUT',
    secs: Math.round((Date.now() - started) / 100) / 10,
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return captured;
}
