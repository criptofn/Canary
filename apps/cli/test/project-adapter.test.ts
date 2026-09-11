/**
 * 1.1 §1 — the PROJECT ADAPTER seam must not change what Node projects do, and
 * must not be able to loosen anything. Concretely: detection/discovery/digests
 * match the 1.0 functions byte-for-byte; an unregistered adapter id fails
 * closed to 'corrupt' (status 2 / never READY); setup still writes no
 * `project` key, so 1.0 config bytes are stable.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import * as project from '../src/project.js';
import * as onboarding from '../src/onboarding.js';
import { cmdStatus, readConfig, writeConfig } from '../src/onboarding.js';
import type { AuthorityCarrier, PlanAuthority, PlanStep } from '../src/project.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-adapter-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const fx = (f: string): string => `node "${path.join(FIXTURES, f)}"`; // setup's smoke run must genuinely pass

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function dir(name: string, files: Record<string, string>): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true }); // '.git/HEAD' style nested fixtures
    fs.writeFileSync(p, text);
  }
  return root;
}
const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'fx', scripts }, null, 2);
const PLAN: PlanStep[] = [{ kind: 'tests', script: 'test' }];

describe('Node detection/discovery unchanged behind the adapter', () => {
  it('detects package.json presence as the same plain fact 1.0 reported', () => {
    const withPkg = dir('detect-pkg', { 'package.json': pkg({ test: 'node t.js' }) });
    assert.deepEqual(project.nodeAdapter.detect(withPkg), { detected: true, confidence: 'high', reason: 'package.json found' });
    const bare = dir('detect-bare', {});
    assert.deepEqual(project.nodeAdapter.detect(bare), { detected: false, confidence: 'high', reason: 'no package.json' });
  });
  it('discoverChecks answers with the 1.0 pm/note/plan, lockfiles first', () => {
    const none = dir('disc-none', { 'package.json': pkg({ test: 'node t.js' }) });
    const d = project.nodeAdapter.discoverChecks(none);
    assert.equal(d.pm, 'npm');
    assert.equal(d.note, 'no lockfile found — defaulted to npm');
    assert.deepEqual(d.plan, PLAN);
    assert.equal(project.nodeAdapter.discoverChecks(dir('disc-npm', { 'package.json': pkg({}), 'package-lock.json': 'x' })).note, 'package-lock.json found');
    const pnpm = project.nodeAdapter.discoverChecks(dir('disc-pnpm', { 'package.json': pkg({}), 'pnpm-lock.yaml': 'x' }));
    assert.equal(pnpm.pm, 'pnpm');
  });
  it('plan discovery keeps kind ordering and name safety', () => {
    const root = dir('disc-order', { 'package.json': pkg({ build: 'tsc -b', test: 'vitest run', typecheck: 'tsc --noEmit', 'bad name': 'x', 'rm -rf': 'x' }) });
    assert.deepEqual(project.nodeAdapter.discoverChecks(root).plan,
      [{ kind: 'typecheck', script: 'typecheck' }, { kind: 'tests', script: 'test' }, { kind: 'build', script: 'build' }]);
    assert.equal(project.isSafeScriptName('bad name'), false);
  });
  it('the re-exports ARE the moved functions (identity, not a copy)', () => {
    assert.equal(onboarding.detectPm, project.detectPm);
    assert.equal(onboarding.detectPlan, project.detectPlan);
    assert.equal(onboarding.stepArgv, project.stepArgv);
    assert.equal(onboarding.planAuthorityDrift, project.planAuthorityDrift);
    assert.equal(onboarding.sealPlanAuthority, project.sealPlanAuthority);
    assert.deepEqual(project.adapterFor({}), project.nodeAdapter); // absent = node: 1.0 configs keep working
  });
});

describe('seal/drift stay byte-compatible', () => {
  it('planDigest and scriptDigests equal the same sha256 1.0 wrote', () => {
    assert.equal(project.planDigest(PLAN), sha256('[{"kind":"tests","script":"test"}]'));
    const seal = project.sealPlanAuthority(PLAN, { test: 'vitest run' });
    assert.equal(seal.scriptDigests.test, sha256('vitest run'));
    assert.equal(seal.planDigest, project.planDigest(PLAN));
  });
  let seq = 0;
  const sealedRoot = () => dir(`seal-${seq++}`, { 'package.json': pkg({ test: 'vitest run' }) });
  const carrier = (plan: PlanStep[] = PLAN, authority?: PlanAuthority): AuthorityCarrier =>
    ({ plan, ...(authority ? { planAuthority: authority } : {}) });
  it('no seal = nothing to drift from (null)', () => {
    assert.equal(project.nodeAdapter.drift(sealedRoot(), carrier()), null);
  });
  it('script text change is the exact 1.0 sentence', () => {
    const root = sealedRoot();
    const c = carrier(PLAN, project.sealPlanAuthority(PLAN, { test: 'vitest run' }));
    assert.equal(project.nodeAdapter.drift(root, c), null);
    fs.writeFileSync(path.join(root, 'package.json'), pkg({ test: 'echo all good' }));
    assert.equal(project.nodeAdapter.drift(root, c), 'script "test" changed since setup sealed it');
  });
  it('plan edit, removed script, unreadable package.json, malformed seal', () => {
    const root = sealedRoot();
    const authority = project.sealPlanAuthority(PLAN, { test: 'vitest run' });
    assert.equal(project.nodeAdapter.drift(root, carrier([...PLAN, { kind: 'build', script: 'build' }], authority)),
      'the plan no longer matches the sealed plan; script "build" is in the plan but was never sealed');
    fs.writeFileSync(path.join(root, 'package.json'), pkg({}));
    assert.equal(project.nodeAdapter.drift(root, carrier(PLAN, authority)), 'script "test" no longer exists in package.json');
    fs.writeFileSync(path.join(root, 'package.json'), '{ not json');
    assert.equal(project.nodeAdapter.drift(root, carrier(PLAN, authority)), 'package.json cannot be read to compare the sealed scripts');
    assert.equal(project.nodeAdapter.drift(root, carrier(PLAN, { at: 'x', planDigest: 'nope', scriptDigests: {} })),
      'the sealed verification authority in .canary/canary.local.json is malformed (hand-edited?)');
  });
});

describe('fail-closed: the seam cannot create READY or PASS', () => {
  it('an unregistered adapter throws rather than guess', () => {
    assert.throws(() => project.adapterFor({ project: 'python' }),
      /project adapter "python" is not registered in this Canary build/);
  });
  it('a config naming an unregistered project is corrupt — status refuses it', () => {
    const root = dir('wired', { '.git/HEAD': 'ref: refs/heads/main\n', '.claude/keep.json': '{}', 'package.json': pkg({ test: fx('f-pass.js') }) });
    assert.equal(spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { encoding: 'utf8', timeout: 120_000 }).status, 0);
    const cfg = readConfig(root);
    if (cfg === 'corrupt' || cfg === null) assert.fail('setup wrote an unreadable config');
    // 1.0 config bytes: setup still omits the `project` key entirely.
    assert.equal(Object.hasOwn(cfg, 'project'), false, 'setup must not start writing a project key yet');
    assert.deepEqual(cfg.plan, PLAN);
    assert.equal(cfg.pm, 'npm');
    assert.equal(cfg.planAuthority?.scriptDigests.test, sha256(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test));
    // An unknown id is corrupt (fails to NOT CONNECTED, exit 2) — never a
    // silent Node fallback, never a READY the seam invented.
    writeConfig(root, { ...cfg, project: 'python' });
    assert.equal(readConfig(root), 'corrupt');
    assert.equal(cmdStatus([root]), 2);
  });
  it('adapter questions report, they do not certify', () => {
    assert.equal(project.nodeAdapter.validateEnvironment('npm'), null);
    assert.equal(project.nodeAdapter.validateEnvironment('pip'),
      'package manager "pip" is not one Canary can run (npm, pnpm, yarn or bun)');
    assert.deepEqual([...project.nodeAdapter.dependencyPaths], ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);
    const root = dir('plan-problems', { 'package.json': pkg({ build: 'tsc -b' }) });
    assert.deepEqual(project.nodeAdapter.planProblems(root, PLAN),
      ['plan references script "test" which no longer exists in package.json']);
    assert.deepEqual(project.nodeAdapter.planProblems(root, [{ kind: 'build', script: 'build' }]), []);
    assert.throws(() => project.nodeAdapter.stepArgv('npm', { kind: 'tests', script: 'rm -rf' }), /refused unsafe plan step/);
  });
});

// ---------------------------------------------------------------------------
// 1.1 §1 foundation — a plan step can name a non-script ecosystem's command
// WITHOUT changing one byte of what a 1.0 Node project hashes or spawns. The
// digest compatibility below is the load-bearing part: every project sealed
// before 1.1 must keep verifying, so the new fields may only ever ADD to a
// digest, never alter an existing one.
// ---------------------------------------------------------------------------
describe('1.1 plan-step foundation (byte-compatible with 1.0 seals)', () => {
  const legacy: PlanStep[] = [{ kind: 'typecheck', script: 'typecheck' }, { kind: 'tests', script: 'test' }];

  it('a legacy plan digests exactly as 1.0 did, so existing seals stay valid', () => {
    // The 1.0 formula, written out here on purpose: if this ever changes, every
    // project sealed before 1.1 starts reporting drift — that must be a
    // deliberate, visible act, never a side effect of adding a field.
    assert.equal(project.planDigest(legacy),
      sha256(JSON.stringify([{ kind: 'typecheck', script: 'typecheck' }, { kind: 'tests', script: 'test' }])));
  });

  it('legacy steps keep <pm> run <script>; an explicit argv is the command', () => {
    assert.deepEqual(onboarding.stepCommand('npm', { kind: 'tests', script: 'test' }), ['npm', 'run', 'test']);
    assert.deepEqual(
      onboarding.stepCommand('npm', { kind: 'tests', script: 'pytest', adapter: 'python', argv: ['python', '-m', 'pytest', '-q'] }),
      ['python', '-m', 'pytest', '-q']);
  });

  it('an explicit argv is refused unless it can be spawned as sealed authority', () => {
    const bad: Array<[string, unknown]> = [
      ['empty', []],
      ['not an array', 'python -m pytest'],
      ['non-string entry', ['python', 7]],
      ['empty entry', ['python', '']],
      ['relative program', ['./tools/run', 'x']],
      ['parent-relative program', ['../bin/run', 'x']],
      ['NUL byte', ['python', 'a\0b']],
      ['too many arguments', ['python', ...Array.from({ length: 40 }, () => 'x')]],
    ];
    for (const [label, argv] of bad) assert.throws(() => project.assertStepArgv(argv), /plan step/, `${label} must be refused`);
    assert.deepEqual(project.assertStepArgv(['python', '-m', 'pytest']), ['python', '-m', 'pytest']);
    assert.deepEqual(project.assertStepArgv([process.execPath, '--version']), [process.execPath, '--version']);
  });

  it('scoped steps cannot collide: one script name in two scopes seals separately', () => {
    const plan: PlanStep[] = [
      { kind: 'tests', script: 'test', adapter: 'node', scope: 'web' },
      { kind: 'tests', script: 'test', adapter: 'python', scope: 'backend', argv: ['python', '-m', 'pytest'] },
    ];
    const seal = project.sealPlanAuthority(plan, { test: 'node web-test.js' });
    assert.deepEqual(Object.keys(seal.scriptDigests).sort(), ['backend::test', 'web::test']);
    assert.equal(seal.scriptDigests['web::test'], sha256('node web-test.js'));
    assert.equal(seal.scriptDigests['backend::test'], sha256(JSON.stringify(['python', '-m', 'pytest'])));
    assert.notEqual(seal.scriptDigests['web::test'], seal.scriptDigests['backend::test']);
  });

  it('a changed explicit argv is drift, and an unsealed step is drift', () => {
    const root = dir('scoped-drift', { 'package.json': pkg({ test: 'node x.js' }) });
    const plan: PlanStep[] = [{ kind: 'tests', script: 'pytest', adapter: 'python', argv: ['python', '-m', 'pytest'] }];
    const seal = project.sealPlanAuthority(plan, {});
    // unchanged bytes → no drift, and no package.json complaint for an argv-only plan
    assert.equal(project.planAuthorityDrift(root, { plan, planAuthority: seal }), null);
    const moved: PlanStep[] = [{ kind: 'tests', script: 'pytest', adapter: 'python', argv: ['python', '-m', 'pytest', '-k', 'not-slow'] }];
    assert.match(String(project.planAuthorityDrift(root, { plan: moved, planAuthority: seal })), /changed since setup sealed it/);
    const substituted: PlanStep[] = [{ kind: 'tests', script: 'other', adapter: 'python', argv: ['python', '-m', 'pytest'] }];
    assert.match(String(project.planAuthorityDrift(root, { plan: substituted, planAuthority: seal })), /never sealed/);
  });

  it('every registered adapter declares its trusted program directories', () => {
    assert.deepEqual([...project.nodeAdapter.trustedProgramDirs], []);
    for (const a of Object.values(project.ADAPTERS)) assert.ok(Array.isArray(a.trustedProgramDirs), a.id);
  });
});
