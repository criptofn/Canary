/**
 * M4 end-to-end probe: evidence provenance on a REAL git repo. The contract
 * tests use fake .git dirs (identity is honestly UNIDENTIFIED there); only a
 * real repo can pin the things provenance exists to answer — real head AND
 * tree bytes, a baseline that stays put while the candidate moves, the task
 * digest traveling the real hook wire, and the companion hash binding real
 * artifact bytes (and catching a byte flip).
 *
 *   node tooling/probes/m4-provenance.mjs
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

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m4-probe-'));
const bundleDir = (root, source) => {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.readdirSync(d).filter((x) => x.endsWith(`-${source}`)).sort();
  assert.ok(dirs.length > 0, `no ${source} bundle`);
  return path.join(d, dirs.at(-1));
};
const latestBundle = (root, source) =>
  JSON.parse(fs.readFileSync(path.join(bundleDir(root, source), 'verification.json'), 'utf8'));

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
  // ---- 1. real bytes: head AND tree identity, baseline stamped at wiring
  const root = makeRealGitRepo('identity');
  check('setup binds the bundle to the real commit AND tree, baseline = same moment', () => {
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 0, r.stdout);
    const b = latestBundle(root, 'setup');
    assert.equal(b.candidate.resolved, true);
    assert.equal(b.candidate.head, git(root, 'rev-parse', 'HEAD').trim());
    assert.equal(b.candidate.tree, git(root, 'rev-parse', 'HEAD^{tree}').trim());
    assert.match(b.provenance.planDigest, /^[0-9a-f]{64}$/);
    assert.equal(b.provenance.baseline.head, b.candidate.head);
    assert.equal(b.provenance.baseline.tree, b.candidate.tree);
  });
  check('timestamps: steps ordered inside the bundle window', () => {
    const b = latestBundle(root, 'setup');
    for (const s of b.steps) {
      assert.ok(Date.parse(s.startedAt) <= Date.parse(s.endedAt), 'step order');
      assert.ok(Date.parse(s.endedAt) <= Date.parse(b.at), 'bundle written after its steps');
    }
  });

  // ---- 2. the baseline holds while the candidate moves (WHAT baseline vs WHAT candidate)
  check('after a new commit, baseline stays at wiring; candidate tracks the move', () => {
    fs.writeFileSync(path.join(root, 'extra.txt'), 'moved on\n');
    git(root, 'add', 'extra.txt');
    git(root, 'commit', '-m', 'move');
    const out = canary(['checkpoint'], root, JSON.stringify({ cwd: root }));
    assert.equal(out.status, 0);
    assert.ok(!out.stdout.trim(), `expected silent pass, got: ${out.stdout}`);
    const b = latestBundle(root, 'checkpoint');
    const newHead = git(root, 'rev-parse', 'HEAD').trim();
    assert.equal(b.candidate.head, newHead);
    assert.notEqual(b.provenance.baseline.head, newHead, 'baseline must NOT chase the candidate');
    assert.notEqual(b.provenance.baseline.tree, b.candidate.tree);
    assert.ok(Date.parse(b.provenance.baseline.at) <= Date.parse(b.at), 'baseline predates the evidence');
  });

  // ---- 3. task label over the real wire: digest recorded, prose nowhere
  const liar = makeRealGitRepo('wire', `node "${FX('f-liar.js')}"`);
  const task = 'Make the liar fixture honest and ship it';
  check('checkpoint with task: block unchanged, taskDigest stored, prose never stored', () => {
    canary(['setup', '--yes', liar]);
    const out = canary(['checkpoint'], liar, JSON.stringify({ cwd: liar, task }));
    assert.equal(out.status, 0); // wire contract unchanged
    assert.equal(JSON.parse(out.stdout).decision, 'block');
    const b = latestBundle(liar, 'checkpoint');
    assert.equal(b.provenance.taskDigest, sha256(task));
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(path.join(liar, '.canary'))) {
      assert.ok(!fs.readFileSync(f, 'utf8').includes('honest and ship'), `${f} must not carry raw task prose`);
    }
  });

  // ---- 4. the companion hash binds the real bundle and catches a flip
  check('verification.sha256 matches bundle bytes; a flipped byte is detectable and inert', () => {
    const dir = bundleDir(liar, 'checkpoint');
    const jsonPath = path.join(dir, 'verification.json');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'verification.sha256'), 'utf8'));
    assert.match(rec.label, /tamper-evidence only/);
    const bytes = fs.readFileSync(jsonPath, 'utf8');
    assert.equal(sha256(bytes), rec.sha256);
    fs.writeFileSync(jsonPath, bytes.replace('"status": "fail"', '"status": "pass"'));
    assert.notEqual(sha256(fs.readFileSync(jsonPath, 'utf8')), rec.sha256, 'tamper must show');
    // tampered bytes are never read back: the real checkpoint still blocks on execution
    const out = canary(['checkpoint'], liar, JSON.stringify({ cwd: liar }));
    assert.equal(JSON.parse(out.stdout).decision, 'block');
  });

  // ---- 5. doctor carries the same provenance forward
  check('doctor bundle inherits the setup-time baseline from trusted config', () => {
    const r = canary(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
    const b = latestBundle(root, 'doctor');
    assert.deepEqual(b.provenance.baseline, cfg.baseline);
    assert.match(b.provenance.planDigest, /^[0-9a-f]{64}$/);
    assert.equal(b.provenance.taskDigest, null, 'doctor sends no task label');
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? 'M4 provenance: ALL PASS' : `M4 provenance: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
