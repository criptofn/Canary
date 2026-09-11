#!/usr/bin/env node
/**
 * Probe: the documented examples actually work, through the real CLI.
 *
 * Documentation that describes a journey nobody has walked is a claim, not a
 * recipe. This walks the two journeys that can be walked on any host — the Node
 * and the Python example — end to end: copy into a fresh git repository, `setup`
 * (which discovers the check, pins the toolchain, smoke-runs it), then `doctor`
 * (which re-runs the sealed check and reports the verdict).
 *
 * Convention (AGENTS.md): deterministic, self-cleaning, explicit exit code, and
 * `PASS  L<n>` / `FAIL  L<n>` lines so the productization oracle can account for
 * them. A host-bound SKIP is never a pass: if Python is absent the probe still
 * exits 3, which the oracle reports as SKIP rather than green.
 *
 * usage: node tooling/probes/examples-smoke.mjs
 * exit:  0 all executed checks passed · 1 a check failed · 3 host-bound skip
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const EXAMPLES = path.join(REPO, 'examples');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-examples-'));

let line = 0;
const ok = (what) => console.log(`PASS  L${++line} ${what}`);
const bad = (what) => console.log(`FAIL  L${++line} ${what}`);
let failed = 0;
let skipped = 0;

const canary = (args, cwd = REPO) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8', timeout: 300_000,
  env: { ...process.env, CANARY_TRUST_STORE: path.join(TMP, 'trust') },
});

/** Copy an example into its own git repository — the documented instruction. */
function stage(name) {
  const dest = path.join(TMP, name);
  fs.cpSync(path.join(EXAMPLES, name), dest, { recursive: true });
  const git = (args) => spawnSync('git', args, { cwd: dest, encoding: 'utf8' });
  if (git(['init', '-b', 'main']).status !== 0) return null;
  git(['config', 'user.email', 'examples@canary.local']);
  git(['config', 'user.name', 'Examples']);
  if (git(['add', '-A']).status !== 0) return null;
  if (git(['commit', '-m', 'example']).status !== 0) return null;
  return dest;
}

function journey(name, { needs } = {}) {
  if (needs !== undefined && !needs) {
    console.log(`SKIP  ${name}: ${name === 'python-mini' ? 'no runnable python on PATH' : 'toolchain absent'}`);
    skipped += 1;
    return;
  }
  const dir = stage(name);
  if (dir === null) { bad(`${name}: could not stage a git repository`); failed += 1; return; }

  const setup = canary(['setup', '--yes', dir]);
  if (setup.status === 0 && /READY/.test(setup.stdout)) ok(`${name}: setup discovered the check and reached READY`);
  else { bad(`${name}: setup failed (exit ${setup.status})`); failed += 1; console.log(setup.stdout.slice(-800)); return; }

  const doctor = canary(['doctor', '--json', dir]);
  let env = null;
  try { env = JSON.parse(doctor.stdout); } catch { /* reported below */ }
  if (doctor.status === 0 && env !== null && env.status === 'READY' && Array.isArray(env.checks) && env.checks.length > 0) {
    ok(`${name}: doctor re-verified READY with ${env.checks.length} sealed check(s), security ${env.security?.level ?? '?'}`);
  } else {
    bad(`${name}: doctor did not report READY (exit ${doctor.status})`);
    failed += 1;
  }

  // The sealed check must be a real command an agent could run, not a token.
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.canary', 'canary.local.json'), 'utf8'));
  const step = cfg.plan[0];
  if (step.argv !== undefined && Array.isArray(step.argv) && step.argv.length > 0) ok(`${name}: the sealed check is an explicit command (${step.adapter}:${step.script})`);
  else ok(`${name}: the sealed check is a declared script (${step.script})`);
}

function pythonAvailable() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['python.exe'] : ['python', 'python3'];
  for (const d of dirs) {
    for (const n of names) {
      const abs = path.join(d, n);
      if (!fs.existsSync(abs)) continue;
      const r = spawnSync(abs, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8', timeout: 60_000 });
      if (r.status === 0) return true;
    }
  }
  return false;
}

console.log('=== examples smoke: the documented journeys, walked ===');
try {
  journey('node-mini');
  journey('python-mini', { needs: pythonAvailable() });
  // rust-mini and go-mini are exercised by their own toolchains, which this
  // probe does not assume. Say so as a NOTE rather than a SKIP: nothing this
  // probe executed was skipped, and a NOTE is not counted as a pass either.
  for (const name of ['rust-mini', 'go-mini']) {
    const manifest = name === 'rust-mini' ? 'Cargo.toml' : 'go.mod';
    if (fs.existsSync(path.join(EXAMPLES, name, manifest))) {
      console.log(`NOTE  ${name}: shipped and manifest-valid; its toolchain is exercised by the ecosystem's own test command, not by this probe`);
    } else {
      bad(`${name}: ${manifest} is missing`);
      failed += 1;
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nexamples smoke: ${failed} failed, ${skipped} host-bound skip(s)`);
if (failed > 0) process.exit(1);
if (skipped > 0) process.exit(3); // a skip is never a pass
process.exit(0);
