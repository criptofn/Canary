#!/usr/bin/env node
/** Launch one bounded native observation with durable outer logs, independently of the shell handle. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
assert.equal(process.platform, 'win32', 'this launcher uses the documented Windows Start-Process behavior');
const out = arg('out'), cli = arg('cli'), prepared = arg('prepared-root');
assert.ok(out && path.isAbsolute(out) && !fs.existsSync(out), 'new absolute --out required');
const root = path.resolve(import.meta.dirname, '../..');
const control = process.argv.includes('--control');
const afterGate = process.argv.includes('--after-gate');
assert.ok(!(control && afterGate));
const fixture = path.join(root, 'tooling/test-support/fixtures');
const instrument = control ? path.join(fixture, 'native-job-control.cjs') : path.join(import.meta.dirname, afterGate ? 'v15-after-gate-pilot.mjs' : 'v15-claude-local-preflight.mjs');
const capture = path.join(out, 'capture');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const args = control ? [path.join(out, 'control-result.json')] : afterGate ? ['--out', capture, '--gate-log', arg('gate-log'), '--gate-exit', arg('gate-exit'), '--expected-source', arg('expected-source')] : ['--cli', cli,
  '--claude', 'C:\\Users\\Johannes\\.local\\bin\\claude.exe',
  '--ollama', 'C:\\Users\\Johannes\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
  '--out', capture, '--prepared-root', prepared];
if (!control && !afterGate) {
  assert.ok(cli && prepared && [cli, prepared].every(path.isAbsolute));
  const preparation = JSON.parse(fs.readFileSync(path.join(prepared, 'preparation-summary.json')));
  assert.equal(preparation.status, 'complete'); assert.equal(preparation.cliSha256, sha(cli));
  if (arg('tasks')) args.push('--tasks', arg('tasks'));
}
fs.mkdirSync(out, { recursive: true });
const argumentsFile = path.join(out, 'arguments.json'); fs.writeFileSync(argumentsFile, JSON.stringify(args));
const helper = path.join(fixture, 'native-job-start.ps1');
// Files, not inherited pipe handles: a descendant keeping a pipe open would
// make spawnSync wait for the entire pilot instead of just its launcher.
const launchOut = path.join(out, 'launch.stdout.txt'), launchErr = path.join(out, 'launch.stderr.txt');
const fds = [fs.openSync(launchOut, 'wx'), fs.openSync(launchErr, 'wx')];
let launched;
try {
  launched = spawnSync('powershell.exe', ['-NoProfile', '-File', helper, process.execPath, instrument, argumentsFile, root, out],
    { windowsHide: true, timeout: 30000, stdio: ['ignore', ...fds] });
} finally { for (const fd of fds) fs.closeSync(fd); }
assert.equal(launched.error, undefined); assert.equal(launched.status, 0, fs.readFileSync(launchErr, 'utf8'));
const handle = JSON.parse(fs.readFileSync(launchOut, 'utf8'));
fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify({ ...handle, control, instrument, instrumentSha256: sha(instrument), helperSha256: sha(helper), args, capture,
  caveat: 'A launch is not completion. Inspect process identity and captured terminal output; no restart on observation timeout.' }, null, 2));
console.log(`STARTED ${handle.pid}; durable producer logs: ${out}; completion remains unproven`);
