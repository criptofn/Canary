#!/usr/bin/env node
/**
 * AGENT-HARNESS FEASIBILITY PROBE — can a measured benchmark trial actually run here?
 *
 * WHY: the v1.2 benchmark's headline numbers come from running a real coding agent under the
 * repository's own harness (`tooling/benchmark/run-trial.mjs`). That harness spawns the agent
 * CLI with `stdio: ['ignore','pipe','pipe']`, and this host refuses piped stdio (measured by
 * `tooling/probes/v12-host-capabilities.mjs`: EPERM). A benchmark that cannot start its agent
 * produces no evidence, and "we could not run it" must be reported as that — not as a result.
 *
 * This probe answers three questions with measurements, not assumptions:
 *   1. is the agent CLI present, and can it be executed at all from here?
 *   2. does the FILE-DESCRIPTOR stdio shape (the sandbox-safe one) let us capture its output?
 *   3. is there an API credential in the environment for a non-CLI path?
 *
 * It makes no model request unless the CLI answers a version query, and it spawns nothing else.
 *
 * Usage: node tooling/probes/v12-agent-harness-feasibility.mjs
 * Exit:  0 always — this is a measurement.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-feasibility-'));
const report = { at: new Date().toISOString(), platform: process.platform, node: process.version, checks: [] };

function record(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

/** Run a command with output captured to FILES (the sandbox-safe shape), never pipes. */
function runToFiles(command, args, timeoutMs = 60_000) {
  const outPath = path.join(tmp, 'out.txt');
  const errPath = path.join(tmp, 'err.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(command, args, { stdio: ['ignore', outFd, errFd], timeout: timeoutMs, windowsHide: true });
  } catch (e) {
    result = { error: e };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: result.status ?? null,
    error: result.error ? (result.error.code ?? String(result.error)) : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

// 1. Is the agent CLI on PATH, and can this process execute it?
const which = process.platform === 'win32' ? 'where.exe' : 'which';
const located = runToFiles(which, ['claude']);
const claudePath = located.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
record('the agent CLI "claude" is on PATH', claudePath !== null, claudePath ?? `not found (status ${String(located.status)})`);

// 2. Can it be EXECUTED from this process at all?
if (claudePath !== null) {
  const version = runToFiles(claudePath, ['--version'], 60_000);
  const ok = version.status === 0 && /\d+\.\d+/.test(version.stdout);
  record(
    'the agent CLI can be executed with file-descriptor stdio',
    ok,
    ok
      ? `--version -> ${version.stdout.trim().slice(0, 40)}`
      : `status=${String(version.status)} error=${String(version.error)} stderr=${version.stderr.trim().split('\n')[0] ?? ''}`,
  );
} else {
  record('the agent CLI can be executed with file-descriptor stdio', false, 'skipped: the CLI was not found');
}

// 3. Is there a credential for a direct-API path?
const credentialVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'DSH_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const present = credentialVars.filter((name) => typeof process.env[name] === 'string' && process.env[name] !== '');
record(
  'a model API credential is present in the environment',
  present.length > 0,
  present.length > 0 ? `present (not printed): ${present.join(', ')}` : `none of ${credentialVars.join(', ')}`,
);

// 4. The trial runner's own environment, as it would forward it.
const forwarded = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'].filter((k) => process.env[k]);
record('trial-runner credential forwarding would have something to forward', forwarded.length > 0, forwarded.length > 0 ? forwarded.join(', ') : 'nothing to forward');

const verdict =
  report.checks[1]?.ok === true
    ? 'a real agent trial MAY be runnable here (the CLI executes with sandbox-safe stdio; the trial runner would still need its stdio shape adapted)'
    : 'a real agent trial is NOT runnable here as the harness stands';
console.log(`\n${verdict}`);
console.log('host capabilities:', report.checks.filter((c) => c.ok).length, '/', report.checks.length);

fs.writeFileSync(path.join(tmp, 'agent-harness-feasibility.json'), JSON.stringify(report, null, 2));
fs.copyFileSync(path.join(tmp, 'agent-harness-feasibility.json'), path.join(os.tmpdir(), 'canary-agent-harness-feasibility.json'));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
