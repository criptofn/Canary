'use strict';
/**
 * The CLI's test helper: run the REAL process and capture its stdout, stderr and exit code.
 *
 * Output is captured through FILE DESCRIPTORS rather than pipes, deliberately. A pipe needs a
 * named kernel object that a confined/ sandboxed host may refuse to create — measured on this
 * machine: spawning with `stdio: ['ignore','pipe','pipe']` fails with EPERM while the
 * file-descriptor shape succeeds. Using files means this test checks the same three facts
 * (exit code, stdout, stderr) on every host instead of failing for an environment reason.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// This file lives in `tests/support/`, so the project root is two levels up.
const CLI = path.join(__dirname, '..', '..', 'bin', 'configcheck.js');

/**
 * @param {string[]} args arguments for the CLI, e.g. ['--config', '/path/to.json']
 * @returns {{ code: number|null, stdout: string, stderr: string, spawnError: string|null }}
 */
function runCli(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'configcheck-'));
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
      timeout: 30_000,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    code: result.status ?? null,
    stdout,
    stderr,
    spawnError: result.error ? (result.error.code ?? String(result.error)) : null,
  };
}

module.exports = { runCli, CLI };
