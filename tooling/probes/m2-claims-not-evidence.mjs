/**
 * M2 end-to-end probe: claims are not evidence, on a REAL git repo (the
 * contract tests use fake .git dirs on purpose — here the candidate identity
 * must bind to real commits, and the evidence plumbing must survive a
 * symlinked evidence dir).
 *
 *   node tooling/probes/m2-claims-not-evidence.mjs
 *
 * Prints PASS/FAIL lines; exit 0 only when everything passed. Fixtures live
 * under the OS temp dir only. Executes the BUILT CLI as a subprocess; project
 * scripts point at repo fixture files by absolute path (no inline interpreters).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = (f) => path.join(REPO, 'tooling', 'test-support', 'fixtures', f);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${String(e.message ?? e).split('\n')[0]}`); }
};

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};
const canary = (args, cwd, input) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8', timeout: 120_000 });

if (!fs.existsSync(CLI)) { console.log('FAIL build first: ' + CLI + ' missing'); process.exit(1); }
{
  const v = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (v.status !== 0) { console.log('FAIL git is required for this probe but did not run'); process.exit(1); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m2-probe-'));
const bundleDirs = (root) => {
  const d = path.join(root, '.canary', 'evidence');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.includes('T') ).sort() : [];
};
const latestBundle = (root, source) => {
  const dirs = bundleDirs(root).filter((d) => d.endsWith(`-${source}`));
  assert.ok(dirs.length > 0, `no ${source} bundle`);
  return JSON.parse(fs.readFileSync(path.join(root, '.canary', 'evidence', dirs.at(-1), 'verification.json'), 'utf8'));
};

function makeRealGitRepo(name, testCmd) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'probe');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: testCmd ?? `node "${FX('f-pass.js')}"` } }, null, 2));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  git(root, 'add', 'package.json');
  git(root, 'commit', '-m', 'init');
  return root;
}

try {
  // ---- 1. candidate identity binds to the REAL commit made by setup's run
  const root = makeRealGitRepo('ident');
  const headAtInit = git(root, 'rev-parse', 'HEAD').trim();
  check('setup on a real repo: READY and bundle candidate binds to the actual HEAD', () => {
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /READY/);
    const b = latestBundle(root, 'setup');
    assert.equal(b.candidate.resolved, true);
    assert.equal(b.candidate.head, headAtInit); // recorded by a fixed read-only `git rev-parse HEAD`
    assert.equal(typeof b.candidate.dirty, 'boolean');
    assert.deepEqual(b.steps[0].argv, ['npm', 'run', 'test']);
    assert.equal(b.steps[0].exitCode, 0);
  });

  // ---- 2. claim divergence on a real repo: block annotated, raw claim never echoed
  const dirty = makeRealGitRepo('diverge', `node "${FX('f-fail-counts.js')}"`);
  check('dirty+fail: checkpoint bundle records dirty=true; claim only annotates the block', () => {
    // make the tree dirty AFTER setup so candidate.dirty flips from a real `git status`
    canary(['setup', '--yes', dirty]); // smoke fails (NEEDS ATTENTION) but config+bundle are written
    fs.writeFileSync(path.join(dirty, 'untracked-note.txt'), 'x');
    assert.equal(canary(['claim', 'all good: 99 passing 0 failing'], dirty).status, 0);
    const out = canary(['checkpoint'], dirty, JSON.stringify({ cwd: dirty }));
    assert.equal(out.status, 0);
    const j = JSON.parse(out.stdout);
    assert.equal(j.decision, 'block');
    assert.match(j.reason, /Claim is not evidence\./);
    assert.match(j.reason, /Agent claimed: 99 passed \/ 0 failed/);
    assert.match(j.reason, /Canary observed: 2 passed \/ 1 failed/);
    assert.ok(!j.reason.includes('all good:'), 'raw claim text must never reach the reason');
    const b = latestBundle(dirty, 'checkpoint');
    assert.equal(b.status, 'fail');
    assert.equal(b.candidate.dirty, true); // untracked note seen by real git status
    assert.deepEqual(b.steps[0].observedCounts, { parser: 'mocha', passed: 2, failed: 1 });
    // digest of retained raw log binds to bytes on disk
    const rawFile = path.join(dirty, '.canary', 'evidence',
      bundleDirs(dirty).filter((d) => d.endsWith('-checkpoint')).at(-1), b.steps[0].stdout.file);
    const h = crypto.createHash('sha256').update(fs.readFileSync(rawFile)).digest('hex');
    assert.equal(b.steps[0].stdout.sha256, h);
  });

  // ---- 3. repair then re-check: an untracked edit kept from the dirty window is
  // still an unestablished comparison, so the stronger gate stays closed.
  check('after repairing the script, the dirty-window comparison remains NOT PROVEN', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirty, 'package.json'), 'utf8'));
    pkg.scripts.test = `node "${FX('f-pass.js')}"`;
    fs.writeFileSync(path.join(dirty, 'package.json'), JSON.stringify(pkg, null, 2));
    // M5: a repaired script is authority drift until setup re-runs (visible smoke
    // executes the new command, then seals it). The bare swap BLOCKING is pinned
    // in m5-proof-plan; this probe keeps its own story: honest repair -> silence.
    assert.equal(canary(['setup', '--yes', dirty]).status, 0);
    const out = canary(['checkpoint'], dirty, JSON.stringify({ cwd: dirty }));
    assert.equal(out.status, 0, out.stdout);
    const decision = JSON.parse(out.stdout);
    assert.equal(decision.decision, 'block', JSON.stringify(decision));
    assert.match(decision.reason, /NOT PROVEN|comparison could not be established/);
    const b = latestBundle(dirty, 'checkpoint');
    assert.equal(b.status, 'pass', JSON.stringify(b)); // the plan passed; the completion decision is the NOT PROVEN block
    assert.equal(b.steps[0].observedCounts, null); // the old 2/1 output is gone from THIS run's bytes
  });

  // ---- 4. S3 containment: a symlinked evidence dir is written AROUND, never through
  const linked = makeRealGitRepo('linked');
  canary(['setup', '--yes', linked]);
  let outside;
  try {
    outside = path.join(TMP, 'evidence-outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.rmSync(path.join(linked, '.canary', 'evidence'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(linked, '.canary', 'evidence'), 'junction');
  } catch {
    console.log('SKIP evidence-symlink attack (OS denies link creation)');
    outside = null;
  }
  if (outside) {
    check('doctor with .canary/evidence pointing outside the repo: no writes escape, verdict intact', () => {
      const r = canary(['doctor', linked]);
      assert.equal(r.status, 0, r.stdout); // READY from its own executed plan — evidence absence never blocks
      assert.deepEqual(fs.readdirSync(outside), [], 'evidence must not be written through an outward link');
    });
  }

  // ---- 5. forged bundle cannot launder a verdict (real repo, real git)
  const forged = makeRealGitRepo('forged', `node "${FX('f-liar.js')}"`);
  check('forged pass bundle + matching printed lie: block stands on exit code alone', () => {
    canary(['setup', '--yes', forged]);
    const fakeDir = path.join(forged, '.canary', 'evidence', '2020-01-01T00-00-00-000Z-checkpoint');
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'verification.json'), JSON.stringify(
      { schema: 'canary-verification/1', source: 'checkpoint', status: 'pass', steps: [{ ok: true, exitCode: 0 }] }));
    const out = canary(['checkpoint'], forged, JSON.stringify({ cwd: forged }));
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).decision, 'block');
    assert.match(JSON.parse(out.stdout).reason, /Canary verification failed/);
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? 'M2 claims-not-evidence: ALL PASS' : `M2 claims-not-evidence: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
