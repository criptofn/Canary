#!/usr/bin/env node
/**
 * Why does `architecture-closure-mutations.mjs` fail at its baseline spawn?
 *
 * It asserts `baseline.status === 0` and gets `null`, while the baseline probe passes 39/39 when run
 * directly. This isolates the one difference that matters: the SPAWN SHAPE. It runs the same command
 * both ways — piped stdio, which the mutations probe uses, and file-descriptor stdio, which the chain
 * and the newer v1.2 probes use — and reports the exit code each returns.
 *
 * Usage: node tooling/probes/v12-spawn-shape.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const TARGET = 'tooling/probes/architecture-closure.mjs';
const CHILD = ['-e', 'process.stdout.write("ran"); process.exit(7)'];

const results = [];
const report = (name, status, error, extra) => {
  results.push({ name, status, error });
  console.log(`${status === 7 ? 'PASS' : 'FAIL'} ${name} — status=${String(status)} error=${error ?? 'none'}${extra ? ` ${extra}` : ''}`);
};

// Shape 1: piped stdio — what architecture-closure-mutations.mjs uses.
{
  const r = spawnSync(process.execPath, CHILD, { cwd: REPO, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  report('piped stdio (encoding: utf8) returns the child exit code', r.status, r.error ? (r.error.code ?? String(r.error)) : null, `stdout=${JSON.stringify((r.stdout ?? '').slice(0, 16))}`);
}

// Shape 2: file-descriptor stdio — what the chain and the v1.2 probes use.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-shape-'));
  const outPath = path.join(dir, 'out.txt');
  const errPath = path.join(dir, 'err.txt');
  const of = fs.openSync(outPath, 'w');
  const ef = fs.openSync(errPath, 'w');
  const r = spawnSync(process.execPath, CHILD, { cwd: REPO, timeout: 60_000, windowsHide: true, stdio: ['ignore', of, ef] });
  fs.closeSync(of);
  fs.closeSync(ef);
  const out = fs.readFileSync(outPath, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  report('file-descriptor stdio returns the child exit code', r.status, r.error ? (r.error.code ?? String(r.error)) : null, `stdout=${JSON.stringify(out.slice(0, 16))}`);
}

// The real target, both ways, to confirm which shape the failing probe would need.
for (const [label, useFiles] of [['piped', false], ['file-descriptor', true]]) {
  let r;
  if (useFiles) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-shape-real-'));
    const of = fs.openSync(path.join(dir, 'o.txt'), 'w');
    const ef = fs.openSync(path.join(dir, 'e.txt'), 'w');
    r = spawnSync(process.execPath, [TARGET], { cwd: REPO, timeout: 240_000, windowsHide: true, stdio: ['ignore', of, ef] });
    fs.closeSync(of);
    fs.closeSync(ef);
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    r = spawnSync(process.execPath, [TARGET], { cwd: REPO, encoding: 'utf8', timeout: 240_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  }
  console.log(`INFO architecture-closure via ${label} stdio -> status=${String(r.status)} error=${r.error ? (r.error.code ?? String(r.error)) : 'none'}`);
}

const pipedOk = results.find((x) => x.name.startsWith('piped'))?.status === 7;
console.log('');
console.log(pipedOk
  ? 'VERDICT: piped stdio DOES return exit codes here, so the spawn shape is NOT the cause and the earlier hypothesis is wrong.'
  : 'VERDICT: piped stdio returns NO exit code here, matching the spawn shape the failing probe uses — the hypothesis holds and the fix is the file-descriptor shape.');
