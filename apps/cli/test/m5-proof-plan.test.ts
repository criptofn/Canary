/**
 * M5 — TRUSTED VERIFICATION PLAN.
 *
 * The worker must not redefine success after implementing its solution. Setup
 * seals the plan AND the exact package.json script texts; every checkpoint
 * verifies the seal BEFORE executing. The canonical attack — `"test":
 * "vitest"` swapped for `"test": "echo all good"` — exits 0, so the M2
 * exit-code oracle alone would certify a hollowed-out check; the seal blocks
 * it. Re-sealing is a setup act (visible, re-smoked); a pre-M5 config with no
 * seal verifies exactly as before (additive). Malformed hand-planted seals
 * fail closed.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import { planAuthorityDrift, readConfig, writeConfig, type CanaryConfig } from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const fx = (f: string): string => `node "${path.join(FIXTURES, f)}"`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m5-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makeProject(name: string, opts: { testScript?: string } = {}): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // findRepoRoot only needs .git presence
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, scripts: { test: opts.testScript ?? fx('f-pass.js') } }, null, 2));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}

function canary(args: string[], cwd?: string, input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: 'utf8', timeout: 120_000,
  });
}

const readPkg = (root: string): any => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const setScript = (root: string, name: string, text: string): void => {
  const pkg = readPkg(root);
  pkg.scripts[name] = text;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
};

const checkpoint = (root: string, extra: Record<string, unknown> = {}) => {
  const r = canary(['checkpoint'], root, JSON.stringify({ cwd: root, ...extra }));
  assert.equal(r.status, 0, `wire contract: checkpoint must exit 0 (got ${r.status})\n${r.output.join('')}`);
  const out = r.stdout ?? '';
  return out.trim() ? JSON.parse(out) : null; // '' = silent pass
};
const readState = (root: string): any =>
  JSON.parse(fs.readFileSync(path.join(root, '.canary', 'last-checkpoint.json'), 'utf8'));
const evidenceSources = (root: string): string[] => {
  const d = path.join(root, '.canary', 'evidence');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

describe('setup seals the verification authority', () => {
  it('the seal binds the plan digest and the verbatim text of each script it runs', () => {
    const root = makeProject('seal');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    const seal = cfg.planAuthority!;
    assert.match(seal.at, ISO);
    assert.equal(seal.planDigest, sha256(JSON.stringify([{ kind: 'tests', script: 'test' }])));
    // the digest is over the EXACT text the project's package.json carries
    assert.deepEqual(Object.keys(seal.scriptDigests), ['test']);
    assert.equal(seal.scriptDigests.test, sha256(readPkg(root).scripts.test));
    // an unchanged repo verifies silently, and doctor certifies it
    assert.equal(checkpoint(root), null);
    assert.equal(canary(['doctor', root]).status, 0);
  });
});

describe('the spec attack: honest command -> "echo all good"', () => {
  it('a swapped script text that WOULD pass by exit code is blocked as authority drift', () => {
    const root = makeProject('swap', { testScript: fx('f-pass.js') });
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    setScript(root, 'test', 'echo all good'); // exits 0 on cmd.exe and POSIX sh alike
    const out = checkpoint(root);
    assert.equal(out.decision, 'block', 'an exit-0 hollow command must never certify completion');
    assert.match(out.reason, /verification authority changed by candidate/i);
    assert.match(out.reason, /"test" changed since setup sealed it/);
    assert.ok(!out.reason.includes('all good'), 'the candidate\'s new text never rides the reason out');
    // nothing was executed: no checkpoint bundle exists (a bundle documents runs, not refusals)
    assert.deepEqual(evidenceSources(root).filter((d) => d.endsWith('-checkpoint')), []);
    assert.equal(readState(root).status, 'fail');
    assert.deepEqual(readState(root).failed, ['authority']);
  });
  it('the loop guard holds on authority drift: one repair attempt, then honest stop', () => {
    const root = makeProject('swap-loop');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    setScript(root, 'test', 'echo all good');
    const out = checkpoint(root, { stop_hook_active: true });
    assert.ok(!out.decision, 'the second attempt must allow, never re-block the loop');
    assert.match(out.systemMessage, /authority is still changed/);
    assert.match(out.systemMessage, /human should look/);
  });
  it('restoring the sealed text restores silent verification (drift detection, not a grudge)', () => {
    const root = makeProject('restore');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const honest = readPkg(root).scripts.test;
    setScript(root, 'test', 'echo all good');
    assert.equal(checkpoint(root).decision, 'block');
    setScript(root, 'test', honest);
    assert.equal(checkpoint(root), null);
    assert.equal(canary(['doctor', root]).status, 0);
  });
});

describe('the config side of the same attack', () => {
  it('editing cfg.plan mid-task without re-sealing blocks', () => {
    const root = makeProject('plan-edit');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    cfg.plan = [{ kind: 'build', script: 'test' }]; // same command, re-labeled kind: plan drifts
    writeConfig(root, cfg);
    const out = checkpoint(root);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /the plan no longer matches the sealed plan/);
  });
  it('a malformed hand-planted seal fails closed', () => {
    const root = makeProject('seal-malformed');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    (cfg as { planAuthority?: unknown }).planAuthority = { at: 'x', planDigest: 'nope', scriptDigests: {} };
    writeConfig(root, cfg);
    const out = checkpoint(root);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /malformed/);
  });
  it('a pre-M5 config (no seal) verifies exactly as before — additive', () => {
    const root = makeProject('pre-m5');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    delete (cfg as { planAuthority?: unknown }).planAuthority;
    writeConfig(root, cfg);
    assert.equal(planAuthorityDrift(root, cfg), null, 'no seal, nothing to drift from');
    assert.equal(checkpoint(root), null);
    assert.equal(canary(['doctor', root]).status, 0);
    // and with no seal the swap is NOT an authority block — old posture, exit-code oracle still rules
    setScript(root, 'test', 'echo all good');
    assert.equal(checkpoint(root), null, 'pre-M5 configs keep pre-M5 behavior (until setup re-seals)');
  });
});

describe('re-sealing and visibility', () => {
  it('re-running setup re-seals the new text under a visible smoke; then it verifies', () => {
    const root = makeProject('reseal');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    setScript(root, 'test', 'echo all good');
    assert.equal(checkpoint(root).decision, 'block');
    // setup executes the NEW command as its smoke test — a human-visible act
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    assert.equal(cfg.planAuthority!.scriptDigests.test, sha256('echo all good'));
    assert.equal(checkpoint(root), null, 'after deliberate re-seal the command is the authority again');
  });
  it('doctor refuses READY on drifted authority', () => {
    const root = makeProject('doctor-drift');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    setScript(root, 'test', 'echo all good');
    const r = canary(['doctor', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /authority changed since setup/);
    assert.ok(!r.stdout.includes('READY'), 'doctor must not certify a proof it never sealed');
  });
});
