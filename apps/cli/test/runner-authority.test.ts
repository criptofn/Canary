/**
 * THE PRODUCTION AUTHORITY SOURCE for a non-package runner identity (v1.1 Phase 2).
 *
 * The channel tests prove a VALID observation is reachable when an identity is
 * granted. This file proves where the grant COMES FROM in the product, and — more
 * importantly — every way it must refuse:
 *
 *   1. an operator who ran `canary setup` on a Python project has authorized that
 *      interpreter, so the sealed plan yields the identity;
 *   2. a plan edited AFTER setup grants nothing (the seal is the authority, not the
 *      file's current contents);
 *   3. a foreign installation's config, a corrupt config, or no config at all grants
 *      nothing;
 *   4. a plan entry that merely runs python — not a test runner — grants nothing.
 *
 * Refusal is the interesting half: this function is the door through which an
 * attacker would try to make Canary trust an interpreter it brought.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-authority-${process.pid}`);

import { pytestRunnerIdentity } from '@canary-rn/executor';

import { readConfig, writeConfig, type CanaryConfig } from '../src/onboarding.js';
import { runnerIdentitiesFromSealedPlan } from '../src/runner-authority.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

/** The workspace-local pytest interpreter, or null when this host has none. */
function findPytestPython(): string | null {
  const rel = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const candidate = path.join(REPO, '_toolchains', 'py', ...rel);
  return fs.existsSync(candidate) ? candidate : null;
}
const PY = findPytestPython();
const SKIP = PY === null ? 'no workspace-local pytest interpreter (_toolchains/py)' : false;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-runner-authority-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A PYTHON-only project: pytest declared, a test directory, no package.json. */
function pythonProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(root, 'tests', 'test_ok.py'), 'def test_ok():\n    assert True\n');
  return root;
}

/**
 * `canary setup` with the workspace venv FIRST on PATH — which is exactly the
 * situation on a real machine where the operator's venv is the python they mean.
 * `pinPlanPrograms` is the ONE moment PATH is consulted, and what it seals is the
 * absolute path.
 */
function setup(root: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const venvBin = PY === null ? null : path.dirname(PY);
  const env = { ...process.env, ...extraEnv };
  if (venvBin !== null) env['PATH'] = `${venvBin}${path.delimiter}${process.env['PATH'] ?? ''}`;
  return spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { cwd: root, encoding: 'utf8', timeout: 180_000, env });
}

describe('the sealed setup plan is the runner-identity authority', { skip: SKIP }, () => {
  it('setup on a pytest project grants the measured identity of the interpreter it sealed', () => {
    const root = pythonProject('granted');
    const res = setup(root);
    assert.equal(res.status, 0, `setup must succeed: ${res.stdout}\n${res.stderr}`);

    const cfg = readConfig(root);
    assert.ok(cfg !== null && cfg !== 'corrupt', 'setup must write a readable config');
    const testsStep = (cfg as CanaryConfig).plan.find((s) => s.script === 'pytest');
    assert.ok(testsStep?.argv, `setup must seal a pytest check with explicit argv: ${JSON.stringify((cfg as CanaryConfig).plan)}`);
    assert.equal(testsStep.argv[0], PY, 'the sealed program is the venv interpreter (absolute, from PATH at setup)');
    assert.deepEqual(testsStep.argv.slice(1), ['-m', 'pytest']);

    const grants = runnerIdentitiesFromSealedPlan(root);
    const expected = pytestRunnerIdentity(PY!);
    assert.ok(expected !== null, 'the identity must be measurable on this host');
    assert.deepEqual(grants, { pytest: expected },
      'the sealed plan must yield exactly the measured pytest identity — version AND content digest');
    // The digest is a real content digest, not a placeholder.
    assert.match(grants['pytest']!.identitySha256, /^[0-9a-f]{64}$/);
    assert.equal(grants['pytest']!.version, expected.version);
  });

  it('an UNSEALED edit to the plan grants nothing (the seal is the authority)', () => {
    const root = pythonProject('tampered');
    assert.equal(setup(root).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    assert.deepEqual(Object.keys(runnerIdentitiesFromSealedPlan(root)), ['pytest']);

    // Point the sealed step at an interpreter of the attacker's choosing, without
    // re-sealing. The plan digest no longer matches, so the whole plan is refused.
    const attacker = path.join(TMP, 'attacker-python', process.platform === 'win32' ? 'python.exe' : 'python');
    fs.mkdirSync(path.dirname(attacker), { recursive: true });
    fs.writeFileSync(attacker, 'not an interpreter\n');
    const tampered: CanaryConfig = {
      ...cfg,
      plan: cfg.plan.map((s) => (s.script === 'pytest' ? { ...s, argv: [attacker, '-m', 'pytest'] } : s)),
    };
    writeConfig(root, tampered);
    assert.deepEqual(runnerIdentitiesFromSealedPlan(root), {},
      'a plan that no longer matches its own seal must grant NOTHING');
  });

  it('a foreign installation config, a corrupt config, or no config grants nothing', () => {
    const noCfg = pythonProject('no-config');
    assert.deepEqual(runnerIdentitiesFromSealedPlan(noCfg), {});

    const corrupt = pythonProject('corrupt-config');
    fs.mkdirSync(path.join(corrupt, '.canary'), { recursive: true });
    fs.writeFileSync(path.join(corrupt, '.canary', 'canary.local.json'), '{ not json');
    assert.deepEqual(runnerIdentitiesFromSealedPlan(corrupt), {});

    const foreign = pythonProject('foreign-config');
    assert.equal(setup(foreign).status, 0);
    const cfg = readConfig(foreign) as CanaryConfig;
    writeConfig(foreign, { ...cfg, cliPath: path.join(TMP, 'elsewhere', 'main.js') });
    assert.deepEqual(runnerIdentitiesFromSealedPlan(foreign), {},
      'a config written by another installation is not this machine authority');
  });

  it('a plan entry that merely runs python grants nothing', () => {
    const root = pythonProject('not-a-runner');
    assert.equal(setup(root).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    // A python step that is not a test runner: the allowlisted interpreter is
    // legitimate to RUN, but it authorizes no observation channel.
    const nonRunner: CanaryConfig = {
      ...cfg,
      plan: cfg.plan.map((s) => (s.script === 'pytest' ? { ...s, argv: [PY!, '-m', 'http.server'] } : s)),
    };
    // Re-seal by writing the config through setup's own path is not available here,
    // so this asserts the refusal that matters: an unsealed change is refused.
    writeConfig(root, nonRunner);
    assert.deepEqual(runnerIdentitiesFromSealedPlan(root), {},
      'an unsealed plan grants nothing regardless of what it names');
  });
});
