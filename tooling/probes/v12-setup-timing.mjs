#!/usr/bin/env node
/**
 * Timing probe: how long does the guarded arm's PRE-AGENT phase take for cli-exit-codes, and
 * which part of it dominates? Written because a guarded trial timed out at 600s with ZERO tokens
 * — i.e. the agent never started — and that must not be mistaken for model behaviour.
 *
 * Measures, on a real copy of the fixture:
 *   1. the fixture's own visible suite;
 *   2. the hidden oracle;
 *   3. `canary setup --yes`;
 *   4. `canary task` with the fixture's declared requirements.
 *
 * Usage: node tooling/probes/v12-setup-timing.mjs [task]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCaptured } from '../benchmark/capture.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const BENCH = path.join(REPO, 'tooling', 'benchmark');
const TASK = process.argv[2] ?? 'cli-exit-codes';
const FIX = path.join(BENCH, 'fixtures', TASK);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), `canary-timing-${TASK}-`));
const project = path.join(root, 'project');
copyDir(path.join(FIX, 'project'), project);
// v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
// `<root>/.claude` or the operator's `~/.claude`, so without this the timing run measured a
// setup that only succeeds on a machine with Claude Code installed.
fs.mkdirSync(path.join(project, '.claude'), { recursive: true });

const steps = [];
const time = (label, fn) => {
  const started = Date.now();
  const r = fn();
  const secs = Math.round((Date.now() - started) / 100) / 10;
  steps.push({ label, secs, exit: r?.status ?? null });
  console.log(`${String(secs).padStart(7)}s  exit=${String(r?.status ?? 'n/a').padStart(4)}  ${label}`);
  return r;
};

try {
  // git baseline, exactly as the trial runner does it
  time('git init', () => runCaptured('git', ['init', '-b', 'main'], { cwd: project }));
  time('git add -A', () => runCaptured('git', ['add', '-A'], { cwd: project }));
  time('git commit', () => runCaptured('git', ['-c', 'user.email=b@c.d', '-c', 'user.name=Bench', 'commit', '-m', 'initial state'], { cwd: project }));

  time('fixture visible suite (node run-tests.js)', () => runCaptured(process.execPath, ['run-tests.js'], { cwd: project, timeout: 300_000 }));
  time('hidden oracle', () => runCaptured(process.execPath, [path.join(FIX, 'hidden', 'check.cjs'), project], { timeout: 300_000 }));
  time('canary setup --yes', () => runCaptured(process.execPath, [CLI, 'setup', '--yes', project], { cwd: project, timeout: 900_000 }));

  const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'fixture.json'), 'utf8'));
  const reqs = Array.isArray(meta.requirements) ? meta.requirements : [];
  if (reqs.length > 0) {
    const intent = typeof meta.intent === 'string' && meta.intent !== '' ? meta.intent : 'the stated task';
    time(`canary task (${reqs.length} requirements)`, () =>
      runCaptured(process.execPath, [CLI, 'task', intent, ...reqs.flatMap((r) => ['--requirement', r])], { cwd: project, timeout: 300_000 }));
  }

  const total = steps.reduce((a, s) => a + s.secs, 0);
  console.log(`\ntotal pre-agent: ${Math.round(total * 10) / 10}s across ${steps.length} steps`);
  const slowest = [...steps].sort((a, b) => b.secs - a.secs)[0];
  console.log(`slowest: ${slowest.label} (${slowest.secs}s)`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
