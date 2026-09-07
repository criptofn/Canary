/**
 * M5 end-to-end probe: the trusted verification plan on a REAL git repo. The
 * contract tests pin wire behavior with fake .git dirs; only a real repo can
 * show the full story the seal exists for — a working-tree attack (package.json
 * swapped to "echo all good", which genuinely exits 0) caught BEFORE execution,
 * restoration via `git checkout` returning silent verification, and the
 * candidate's edit being visible in `git status` exactly as M7's protected-
 * surface detection will consume it.
 *
 *   node tooling/probes/m5-proof-plan.mjs
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
const checkpointOut = (root, extra = {}) => {
  const r = canary(['checkpoint'], root, JSON.stringify({ cwd: root, ...extra }));
  assert.equal(r.status, 0, 'wire contract: checkpoint must exit 0');
  return r.stdout.trim() ? JSON.parse(r.stdout) : null; // null = silent pass
};

if (!fs.existsSync(CLI)) { console.log('FAIL build first: ' + CLI + ' missing'); process.exit(1); }
{
  const v = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (v.status !== 0) { console.log('FAIL git is required for this probe but did not run'); process.exit(1); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m5-probe-'));
const cfgOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
const pkgOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const setTest = (root, text) => {
  const pkg = pkgOf(root);
  pkg.scripts.test = text;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
};

function makeRealGitRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'probe');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: `node "${FX('f-pass.js')}"` } }, null, 2));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  git(root, 'add', 'package.json');
  git(root, 'commit', '-m', 'init');
  return root;
}

try {
  // ---- 1. the seal on a real repo binds the real bytes a human approved
  const root = makeRealGitRepo('seal');
  check('setup seals plan + verbatim script text; clean repo verifies silently and doctor is READY', () => {
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const seal = cfgOf(root).planAuthority;
    assert.equal(seal.scriptDigests.test, sha256(pkgOf(root).scripts.test));
    assert.equal(seal.planDigest, sha256(JSON.stringify(cfgOf(root).plan.map((s) => ({ kind: s.kind, script: s.script })))));
    assert.equal(checkpointOut(root), null);
    assert.equal(canary(['doctor', root]).status, 0);
  });

  // ---- 2. THE attack: honest command -> "echo all good" (which really exits 0)
  check('the echo-all-good swap is BLOCKED before execution, though the exit code would say pass', () => {
    const cpBundlesBefore = fs.readdirSync(path.join(root, '.canary', 'evidence')).filter((d) => d.endsWith('-checkpoint')).length;
    setTest(root, 'echo all good');
    const out = checkpointOut(root);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /verification authority changed by candidate/i);
    assert.match(out.reason, /"test" changed since setup sealed it/);
    // refused authority writes NO new bundle (a bundle documents runs, not refusals)
    const cpBundlesAfter = fs.readdirSync(path.join(root, '.canary', 'evidence')).filter((d) => d.endsWith('-checkpoint')).length;
    assert.equal(cpBundlesAfter, cpBundlesBefore, 'the block must not fabricate an executed-checkpoint bundle');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.canary', 'last-checkpoint.json'), 'utf8')).failed, ['authority']);
    // and the candidate\'s edit is plainly visible in the working tree — M7\'s surface
    assert.match(git(root, 'status', '--porcelain'), /package\.json/);
  });

  // ---- 3. real-git restore: exact sealed bytes come back, silent verification returns
  check('git-restoring the sealed file returns silent pass (detection, not a grudge)', () => {
    git(root, 'checkout', '--', 'package.json');
    assert.equal(checkpointOut(root), null);
    assert.equal(canary(['doctor', root]).status, 0);
  });

  // ---- 4. re-seal is a setup act: the smoke test visibly runs the new command first
  check('setup re-run executes the swapped command in smoke and only then seals it; checkpoint passes', () => {
    const r2 = makeRealGitRepo('reseal');
    assert.equal(canary(['setup', '--yes', r2]).status, 0);
    setTest(r2, 'echo all good');
    assert.equal(checkpointOut(r2).decision, 'block');
    assert.equal(canary(['setup', '--yes', r2]).status, 0, 'smoke ran the new command and it exited 0');
    assert.equal(cfgOf(r2).planAuthority.scriptDigests.test, sha256('echo all good'));
    assert.equal(checkpointOut(r2), null, 'deliberately re-sealed authority is authority again');
    const dirs = fs.readdirSync(path.join(r2, '.canary', 'evidence')).filter((d) => d.endsWith('-checkpoint'));
    assert.ok(dirs.length > 0, 'the passed checkpoint must now write its executed bundle');
  });

  // ---- 5. the config file itself: hand-edit the plan, seal untouched -> blocked
  check('hand-editing .canary/canary.local.json plan without re-sealing blocks on authority', () => {
    const r3 = makeRealGitRepo('cfg-edit');
    assert.equal(canary(['setup', '--yes', r3]).status, 0);
    const cfg = cfgOf(r3);
    cfg.plan = [{ kind: 'build', script: 'test' }];
    fs.writeFileSync(path.join(r3, '.canary', 'canary.local.json'), JSON.stringify(cfg, null, 2));
    const out = checkpointOut(r3);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /plan no longer matches the sealed plan/);
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? 'M5 proof-plan: ALL PASS' : `M5 proof-plan: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
