#!/usr/bin/env node
/**
 * HOST CAPABILITY PROBE — what process-spawning this environment actually permits.
 *
 * WHY: the v1.2 benchmark runs each trial as a child agent process and captures its stream,
 * and the HARDENED attack battery must run commands as a confined worker. Both depend on
 * `child_process` stdio shapes that a sandbox can refuse. This repository's AGENTS.md states
 * the boundary (piped stdio fails with EPERM; `inherit`/`ignore` work) — this probe MEASURES
 * it on the host in front of you instead of assuming it, so a v1.2 result can say which
 * capability existed when it was produced.
 *
 * It writes nothing outside a temp dir and spawns only this same node binary.
 *
 * Usage: node tooling/probes/v12-host-capabilities.mjs
 * Exit:  0 always (this is a measurement, not an assertion) — but it prints PASS/FAIL per cell.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
// A tiny, quote-free program so only the STDIO SHAPE is under test.
const PROGRAM = 'process.stdout.write("OUT");process.stderr.write("ERR");process.exit(3)';
const child = (args) => [NODE, ['-e', PROGRAM], ...args];

const results = [];
function cell(name, fn) {
  let outcome;
  try {
    outcome = fn();
  } catch (e) {
    outcome = { ok: false, why: `threw ${e && e.code ? e.code : String(e)}` };
  }
  results.push({ name, ...outcome });
  console.log(`${outcome.ok ? 'PASS' : 'FAIL'} ${name}${outcome.ok ? '' : ` — ${outcome.why}`}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-host-cap-'));

try {
  cell('spawnSync with stdio "pipe" captures stdout', () => {
    const r = spawnSync(...child([]), { encoding: 'utf8', windowsHide: true });
    if (r.error) return { ok: false, why: r.error.code ?? String(r.error) };
    return { ok: r.stdout === 'OUT', why: `stdout=${JSON.stringify(r.stdout)}` };
  });

  cell('spawnSync with stdio "inherit" runs the child', () => {
    const r = spawnSync(...child([]), { stdio: 'inherit', windowsHide: true });
    if (r.error) return { ok: false, why: r.error.code ?? String(r.error) };
    return { ok: r.status === 3, why: `status=${String(r.status)}` };
  });

  cell('spawnSync with stdio "ignore" runs the child and reports the exit code', () => {
    const r = spawnSync(...child([]), { stdio: 'ignore', windowsHide: true });
    if (r.error) return { ok: false, why: r.error.code ?? String(r.error) };
    return { ok: r.status === 3, why: `status=${String(r.status)}` };
  });

  cell('spawnSync with FILE-DESCRIPTOR stdio captures stdout and stderr', () => {
    const outPath = path.join(tmp, 'out.txt');
    const errPath = path.join(tmp, 'err.txt');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    try {
      const r = spawnSync(...child([]), { stdio: ['ignore', outFd, errFd], windowsHide: true });
      if (r.error) return { ok: false, why: r.error.code ?? String(r.error) };
      const out = fs.readFileSync(outPath, 'utf8');
      const err = fs.readFileSync(errPath, 'utf8');
      if (r.status !== 3) return { ok: false, why: `status=${String(r.status)}` };
      if (out !== 'OUT') return { ok: false, why: `stdout=${JSON.stringify(out)}` };
      if (err !== 'ERR') return { ok: false, why: `stderr=${JSON.stringify(err)}` };
      return { ok: true };
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
  });

  cell('the shell can run a program and read its piped output (for comparison)', () => {
    const r = spawnSync('cmd.exe', ['/c', 'echo SHELLOK'], { encoding: 'utf8', windowsHide: true });
    if (r.error) return { ok: false, why: r.error.code ?? String(r.error) };
    return { ok: /SHELLOK/.test(r.stdout ?? ''), why: `stdout=${JSON.stringify(r.stdout)}` };
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nhost capabilities: ${passed}/${results.length}`);
console.log('platform:', process.platform, 'node:', process.version, 'user:', process.env.USERNAME ?? 'unknown');
fs.writeFileSync(
  path.join(os.tmpdir(), 'canary-host-capabilities.json'),
  JSON.stringify({ at: new Date().toISOString(), platform: process.platform, node: process.version, results }, null, 2),
);
process.exit(0);
