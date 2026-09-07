/**
 * M3 end-to-end probe: evidence trust classes on a REAL git repo. The contract
 * tests use fake .git dirs; here the stamped bundles must coexist with real
 * candidate identity, and the copy-to-promote attack is run against the
 * product exactly as an operator would see it (setup -> forge -> checkpoint ->
 * doctor).
 *
 *   node tooling/probes/m3-trust-classes.mjs
 *
 * Prints PASS/FAIL lines; exit 0 only when everything passed. Fixtures live
 * under the OS temp dir only. Executes the BUILT CLI as a subprocess; project
 * scripts point at repo fixture files by absolute path (no inline interpreters).
 */
import assert from 'node:assert/strict';
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m3-probe-'));
const bundleDirs = (root) => {
  const d = path.join(root, '.canary', 'evidence');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.includes('T')).sort() : [];
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
  // ---- 1. on a real repo the CANARY_OBSERVED stamp sits next to REAL identity
  const root = makeRealGitRepo('observed');
  check('real-repo setup: bundle is CANARY_OBSERVED and bound to the actual HEAD', () => {
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 0, r.stdout);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const b = latestBundle(root, 'setup');
    assert.equal(b.trustClass, 'CANARY_OBSERVED');
    assert.equal(b.candidate.resolved, true);
    assert.equal(b.candidate.head, head);
  });
  check('claim on a real repo: envelope is AGENT_REPORTED with UNTRUSTED HINT authority', () => {
    assert.equal(canary(['claim', 'tests look green'], root).status, 0);
    const c = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'claims', 'latest.json'), 'utf8'));
    assert.equal(c.trustClass, 'AGENT_REPORTED');
    assert.match(c.authority, /UNTRUSTED HINT/);
  });

  // ---- 2. copy-to-promote on a real repo: the full operator-visible chain
  const liar = makeRealGitRepo('promote', `node "${FX('f-liar.js')}"`);
  const fakeDir = path.join(liar, '.canary', 'evidence', '2020-01-01T00-00-00-000Z-checkpoint');
  check('forged CANARY_OBSERVED pass bundle: checkpoint still blocks on exit code alone', () => {
    canary(['setup', '--yes', liar]); // smoke fails, config written
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'verification.json'), JSON.stringify({
      schema: 'canary-verification/1', source: 'checkpoint', status: 'pass',
      trustClass: 'CANARY_OBSERVED', steps: [{ ok: true, exitCode: 0 }],
    }));
    const out = canary(['checkpoint'], liar, JSON.stringify({ cwd: liar }));
    assert.equal(out.status, 0); // wire contract unchanged
    assert.equal(JSON.parse(out.stdout).decision, 'block');
    assert.ok(fs.existsSync(path.join(fakeDir, 'verification.json')), 'kept as inert data, never consulted');
  });
  check('same forged bundle against doctor: re-derivation wins, NEEDS ATTENTION not READY', () => {
    const r = canary(['doctor', liar]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /NEEDS ATTENTION/);
    assert.ok(!r.stdout.includes('READY'));
  });

  // ---- 3. UX: the class vocabulary stays out of the simple path, on a real repo
  const green = makeRealGitRepo('ux');
  canary(['setup', '--yes', green]);
  check('plain doctor shows no trust-class prose; --verbose explains the classes', () => {
    const plain = canary(['doctor', green]);
    assert.equal(plain.status, 0, plain.stdout);
    assert.ok(!plain.stdout.includes('CANARY_OBSERVED'), 'default UX stays simple');
    const verbose = canary(['doctor', '--verbose', green]);
    assert.equal(verbose.status, 0, verbose.stdout);
    assert.match(verbose.stdout, /CANARY_OBSERVED/);
    assert.match(verbose.stdout, /never read back/);
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? 'M3 trust-classes: ALL PASS' : `M3 trust-classes: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
