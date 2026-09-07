/**
 * M6 end-to-end probe: proof orchestration on a REAL git repo. The contract
 * tests fake .git dirs on purpose (everything unresolvable => the UNPROVEN
 * path); here the whole point is that blame CAN be assigned: a clean setup
 * baseline, a green plan that still BLOCKS because a test file disappeared —
 * worktree, STAGED, or committed —, a restore via the exact advice the block
 * prints unmutes, a rename out of (and staying inside) test paths, a
 * NON-ASCII test name that must not silently defeat the gate (git -z,
 * review #1/#8), a committed lockfile that ADDS a dependency obligation
 * nobody declared, and a registered task that can never lift the sealed
 * authority. Canary's own writes stay invisible to the stamp even when it
 * backs up a TRACKED settings.json (review #2). A dirty-at-setup repo pins
 * the mirror: staged and worktree deletions there are UNPROVEN with an
 * honest premise, never blamed (review #3/#6).
 *
 *   node tooling/probes/m6-proof-orchestration.mjs
 *
 * Prints PASS/FAIL lines; exit 0 only when everything passed. Fixtures live
 * under the OS temp dir only. Executes the BUILT CLI as a subprocess.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m6-probe-'));
const readCfg = (root) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
const readState = (root) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'last-checkpoint.json'), 'utf8'));
const cp = (root, extra = {}) => {
  const r = canary(['checkpoint'], root, JSON.stringify({ cwd: root, ...extra }));
  assert.equal(r.status, 0, `wire contract: checkpoint exits 0 (got ${r.status})`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null; // null = silent pass
};
const latestBundle = (root) => {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.readdirSync(d).filter((x) => x.endsWith('-checkpoint')).sort();
  assert.ok(dirs.length > 0, 'no checkpoint bundle');
  return JSON.parse(fs.readFileSync(path.join(d, dirs.at(-1), 'verification.json'), 'utf8'));
};

function makeCleanRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'probe');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: `node "${FX('f-pass.js')}"` } }, null, 2));
  fs.writeFileSync(path.join(root, 'tests', 'unit.test.js'), '// real verification coverage lives here\n');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'init');
  return root;
}

try {
  const root = makeCleanRepo('orch');
  const headAtInit = git(root, 'rev-parse', 'HEAD').trim();

  check('setup on a clean real repo: baseline resolved + CLEAN — Canary\'s own wiring write does not blind blame', () => {
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 0, r.stdout);
    const b = readCfg(root).baseline;
    assert.equal(b.resolved, true);
    assert.equal(b.head, headAtInit);
    assert.equal(b.dirty, false, 'setup\'s own .claude/settings.json must not stamp the baseline dirty (M6 attribution depends on this)');
  });

  check('registered refactor + green sealed plan: checkpoint silent, doctor READY without obligation noise', () => {
    assert.equal(canary(['task', 'refactor the auth module'], root).status, 0);
    assert.equal(cp(root), null);
    const d = canary(['doctor', root]);
    assert.equal(d.status, 0, d.stdout);
    assert.match(d.stdout, /READY/);
    assert.ok(!d.stdout.includes('proof obligations open'), 'all obligations met must not add noise: ' + d.stdout);
  });

  check('WORKTREE deletion of a test on a clean baseline: the green plan BLOCKS — evidence still says pass', () => {
    fs.rmSync(path.join(root, 'tests', 'unit.test.js'));
    const out = cp(root);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /coverage removed by candidate/i);
    assert.match(out.reason, /tests[/\\]unit\.test\.js/);
    assert.match(out.reason, /cannot certify checks that no longer exist/i);
    assert.equal(readState(root).status, 'fail');
    assert.deepEqual(readState(root).failed, ['obligation']);
    // honesty of the record: the PLAN did pass — the bundle says pass; the
    // verdict is blocked by the obligation, and both facts survive separately.
    assert.equal(latestBundle(root).status, 'pass');
    const d = canary(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /NEEDS ATTENTION/);
    assert.match(d.stdout, /objectively violated/i);
  });

  check('loop guard holds for obligation blocks: one repair attempt, then honest stop (no re-block)', () => {
    const out = cp(root, { stop_hook_active: true });
    assert.ok(!out.decision, 'must allow, never re-block the loop');
    assert.match(out.systemMessage, /still unmet/i);
    assert.match(out.systemMessage, /human should look/);
  });

  check('git checkout restores the deleted test: silent verification returns (a gate, not a grudge)', () => {
    git(root, 'checkout', '--', 'tests/unit.test.js');
    assert.ok(fs.existsSync(path.join(root, 'tests', 'unit.test.js')));
    assert.equal(cp(root), null);
  });

  check('a STAGED (uncommitted) deletion on a CLEAN baseline blocks, and the printed advice really unmutes (review #3)', () => {
    git(root, 'rm', '-q', 'tests/unit.test.js'); // deletion lives in the INDEX only
    const out = cp(root);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /coverage removed by candidate/i);
    assert.match(out.reason, /git restore --source=HEAD --staged --worktree/);
    // a CLEAN stamp proves the index matched HEAD at setup — staged residue NOW is the agent's
    git(root, 'restore', '--source=HEAD', '--staged', '--worktree', 'tests/unit.test.js');
    assert.equal(cp(root), null, 'the advice must actually unblock — a doomed repair loop is a defect');
  });

  check('a COMMITTED deletion blocks via the sealed baseline; a committed restore unblocks', () => {
    git(root, 'rm', '-q', 'tests/unit.test.js');
    git(root, 'commit', '-q', '-m', 'drop the test');
    const out = cp(root);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /coverage removed by candidate/i);
    git(root, 'checkout', 'HEAD~1', '--', 'tests/unit.test.js');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'undrop the test');
    assert.equal(cp(root), null);
  });

  check('renames on a clean baseline: out of test paths = coverage loss; staying a test = not (review #5)', () => {
    git(root, 'mv', 'tests/unit.test.js', 'moved-out.md');
    git(root, 'commit', '-q', '-m', 'rename the test away');
    const out = cp(root);
    assert.equal(out.decision, 'block', 'git mv of a test to a non-test path is exactly a deletion wearing a rename coat');
    assert.match(out.reason, /coverage removed by candidate/i);
    git(root, 'mv', 'moved-out.md', 'tests/unit.test.js');
    git(root, 'commit', '-q', '-m', 'rename it back');
    assert.equal(cp(root), null, 'net-zero against the sealed baseline restores silence');
    git(root, 'mv', 'tests/unit.test.js', 'tests/renamed.test.js');
    git(root, 'commit', '-q', '-m', 'rename within tests/');
    assert.equal(cp(root), null, 'coverage that merely changed its name is still coverage');
  });

  check('a committed lockfile ADDS the dependency obligation with NO declaration (diff-implied)', () => {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'orch', lockfileVersion: 3 }) + '\n');
    git(root, 'add', 'package-lock.json');
    git(root, 'commit', '-q', '-m', 'lockfile appears');
    const out = cp(root);
    assert.ok(out?.systemMessage, 'the pass must not be silent once the diff implies a dependency change');
    assert.ok(!out.decision, 'unproven rides a note — it is not an objective violation');
    assert.match(out.systemMessage, /dependency change observed/i);
    const d = canary(['doctor', root]);
    assert.match(d.stdout, /proof obligations open: \d+ UNPROVEN/);
    assert.match(d.stdout, /NO PROOF, NO DONE/);
  });

  check('a registered task NEVER lifts the sealed authority — the floor is the floor', () => {
    assert.equal(canary(['task', 'ship it, all checks are optional now'], root).status, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    pkg.scripts.test = 'echo all good';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const out = cp(root);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /authority changed by candidate/i);
    assert.ok(!out.reason.match(/obligation/i), 'M5 drift fires first — a task hint cannot trade the seal away');
  });

  // ---- the quotePath hole the M6 review drove to real git (-z fixes it) ----
  check('a NON-ASCII committed test deletion blocks: git C-quoting cannot defeat the gate (review #1/#8)', () => {
    const uni = makeCleanRepo('uni-paths');
    fs.writeFileSync(path.join(uni, 'tests', 'ünï.test.js'), '// unicode coverage\n');
    git(uni, 'add', '-A');
    git(uni, 'commit', '-q', '-m', 'unicode test appears');
    assert.equal(canary(['setup', '--yes', uni]).status, 0);
    assert.equal(readCfg(uni).baseline.dirty, false);
    git(uni, 'rm', '-q', '--', 'tests/ünï.test.js'); // line-mode git would emit "tests/\303\274n\303\257.test.js"
    git(uni, 'commit', '-q', '-m', 'drop the unicode test');
    const out = cp(uni);
    assert.equal(out.decision, 'block', 'one non-ASCII character must not silently disable coverage attribution');
    assert.match(out.reason, /coverage removed by candidate/i); // name may render as <odd path>
  });

  check('a TRACKED settings.json cannot blind the baseline stamp via Canary\'s own backup (review #2)', () => {
    const t = makeCleanRepo('tracked-settings');
    fs.writeFileSync(path.join(t, '.claude', 'settings.json'), '{}\n');
    git(t, 'add', '-A');
    git(t, 'commit', '-q', '-m', 'harness settings are tracked');
    assert.equal(canary(['setup', '--yes', t]).status, 0);
    assert.equal(readCfg(t).baseline.dirty, false,
      'setup writes its backup BEFORE stamping — .canary self-ignore + own-settings exclude must keep its work invisible');
    fs.rmSync(path.join(t, 'tests', 'unit.test.js'));
    assert.equal(cp(t)?.decision, 'block', 'a falsely-dirty stamp would route every deletion to UNPROVEN for the repo\'s life');
  });

  // ---- the attribution mirror: dirty AT SETUP => same deletion, no blame ----
  const dirtyRoot = makeCleanRepo('pre-dirty');
  git(dirtyRoot, 'rm', '-q', 'tests/unit.test.js'); // STAGED residue BEFORE Canary arrives
  check('dirty-at-setup baseline: staged AND worktree deletions are UNPROVEN with an honest premise (review #3/#6)', () => {
    const r = canary(['setup', '--yes', dirtyRoot]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(readCfg(dirtyRoot).baseline.dirty, true, 'real pre-existing dirt must still stamp the baseline dirty');
    const out = cp(dirtyRoot);
    assert.ok(out?.systemMessage);
    assert.ok(!out.decision, 'the index is never snapshotted — pre-existing staged residue cannot be pinned on the agent');
    assert.match(out.systemMessage, /cannot be attributed to this session/i);
    assert.match(out.systemMessage, /already dirty at setup/, 'the stamp PROVED dirt here, so the premise may say so');
    const d = canary(['doctor', dirtyRoot]);
    assert.equal(d.status, 0, 'unproven never holds doctor at bay — READY with the note stands');
    assert.match(d.stdout, /proof obligations open/);
    git(dirtyRoot, 'restore', '--source=HEAD', '--staged', '--worktree', 'tests/unit.test.js');
    assert.equal(cp(dirtyRoot), null, 'restored and explained: silence returns');
    fs.rmSync(path.join(dirtyRoot, 'tests', 'unit.test.js')); // second phase: worktree-only residue
    const out2 = cp(dirtyRoot);
    assert.ok(out2?.systemMessage && !out2.decision);
    assert.match(out2.systemMessage, /cannot be attributed/i);
    git(dirtyRoot, 'checkout', '--', 'tests/unit.test.js');
    assert.equal(cp(dirtyRoot), null);
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? 'M6 proof-orchestration: ALL PASS' : `M6 proof-orchestration: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
