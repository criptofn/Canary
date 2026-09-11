/**
 * M4 — EVIDENCE PROVENANCE.
 *
 * A verification bundle must answer: WHAT plan (planDigest) and WHAT task
 * (digest of an optional hook-supplied label), WHICH CODE (baseline +
 * candidate head/tree), WHERE (per-step cwd), WHEN (per-step startedAt/
 * endedAt), WHAT HAPPENED (argv, exit code, raw-byte hashes, artifacts).
 * A verification.sha256 companion binds the bundle — TAMPER-EVIDENCE ONLY,
 * honestly labeled: no signing key exists, so it is never called a signature
 * and nothing claims cryptographic authenticity.
 *
 * The M2/M3 doctrines stand and are pinned here: provenance is recorded,
 * never read back for a verdict; the task label is AGENT_REPORTED (digest
 * only — raw prose never touches disk); pre-M4 configs get baseline:null
 * instead of an invented past.
 *
 * Same harness as m2/m3: pure functions in-process, behavior against the
 * BUILT CLI in throwaway dirs, fixture programs by absolute path.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import { candidateIdentity, planDigest, readConfig, writeConfig, type CanaryConfig } from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const fx = (f: string): string => `node "${path.join(FIXTURES, f)}"`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m4-'));
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

const evidenceDir = (root: string): string => path.join(root, '.canary', 'evidence');
const bundleDir = (root: string, source: string): string => {
  const dirs = fs.readdirSync(evidenceDir(root)).filter((d) => d.endsWith(`-${source}`)).sort();
  assert.ok(dirs.length > 0, `expected a ${source} verification bundle`);
  return path.join(evidenceDir(root), dirs.at(-1)!);
};
const readLatestBundle = (root: string, source: string): any =>
  JSON.parse(fs.readFileSync(path.join(bundleDir(root, source), 'verification.json'), 'utf8'));
const checkpoint = (root: string, extra: Record<string, unknown> = {}) => {
  const r = canary(['checkpoint'], root, JSON.stringify({ cwd: root, ...extra }));
  assert.equal(r.status, 0, `wire contract: checkpoint must exit 0 (got ${r.status})\n${r.output.join('')}`);
  const out = r.stdout ?? '';
  return out.trim() ? JSON.parse(out) : null; // '' = silent pass
};
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

describe('the bundle answers the M4 questions', () => {
  it('setup records planDigest (matching the in-memory plan), baseline, and ordered per-step stamps', () => {
    const root = makeProject('answers');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    const b = readLatestBundle(root, 'setup');
    assert.equal(b.provenance.planDigest, planDigest(cfg.plan));
    assert.match(b.provenance.planDigest, /^[0-9a-f]{64}$/);
    // fake .git: the baseline is honestly UNIDENTIFIED — present `at`, no invented identity
    assert.equal(b.provenance.baseline.resolved, false);
    assert.equal(b.provenance.baseline.head, null);
    assert.equal(b.provenance.baseline.tree, null);
    assert.match(b.provenance.baseline.at, ISO);
    assert.deepEqual(cfg.baseline, b.provenance.baseline); // config stamped it, bundle carried it
    assert.equal(b.candidate.tree, null); // candidate shares the tree field (UNIDENTIFIED here)
    const s = b.steps[0];
    assert.match(s.startedAt, ISO);
    assert.match(s.endedAt, ISO);
    assert.ok(Date.parse(s.startedAt) <= Date.parse(s.endedAt), 'startedAt must not be after endedAt');
    assert.ok(Date.parse(s.endedAt) <= Date.parse(b.at), 'steps happened before the bundle was written');
  });
  it('planDigest is deterministic, order-sensitive, and binds kind AND script', () => {
    const a = planDigest([{ kind: 'tests', script: 'test' }, { kind: 'build', script: 'build' }]);
    assert.equal(a, planDigest([{ kind: 'tests', script: 'test' }, { kind: 'build', script: 'build' }]));
    assert.notEqual(a, planDigest([{ kind: 'build', script: 'build' }, { kind: 'tests', script: 'test' }]));
    assert.notEqual(a, planDigest([{ kind: 'tests', script: 'test' }, { kind: 'typecheck', script: 'build' }]));
    assert.notEqual(a, planDigest([{ kind: 'tests', script: 'test' }]));
  });
});

describe('the task label is a digest with zero verdict authority', () => {
  it('checkpoint records taskDigest on a pass and never stores the prose anywhere', () => {
    const root = makeProject('task-green');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const task = 'Add a parser for RFC 822 headers   ';
    assert.equal(checkpoint(root, { task }), null, 'a task label must not change a silent pass');
    const b = readLatestBundle(root, 'checkpoint');
    assert.equal(b.provenance.taskDigest, sha256(task.trim()));
    for (const f of walk(path.join(root, '.canary'))) {
      assert.ok(!fs.readFileSync(f, 'utf8').includes('RFC 822'), `${f} must not carry raw task prose`);
    }
  });
  it('on a failing plan the block is byte-identical with or without a task label', () => {
    const mk = (name: string) => {
      const root = makeProject(name, { testScript: fx('f-fail-counts.js') });
      canary(['setup', '--yes', root]);
      return root;
    };
    const plainRoot = mk('task-red-plain');
    const labeledRoot = mk('task-red-labeled');
    const plain = checkpoint(plainRoot);
    const labeled = checkpoint(labeledRoot, { task: 'fix the failing tests please' });
    assert.equal(plain.decision, 'block');
    assert.deepEqual(labeled, plain, 'the task label must not alter the verdict or its reason');
    assert.ok(!JSON.stringify(labeled).includes('fix the failing'), 'task prose never rides the wire out');
    assert.equal(readLatestBundle(plainRoot, 'checkpoint').provenance.taskDigest, null);
    assert.equal(readLatestBundle(labeledRoot, 'checkpoint').provenance.taskDigest, sha256('fix the failing tests please'));
  });
  it('absent or empty task yields taskDigest null; an old sender without task still gets full provenance', () => {
    const root = makeProject('task-none');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(checkpoint(root, { task: '   ' }), null);
    assert.equal(readLatestBundle(root, 'checkpoint').provenance.taskDigest, null);
    assert.equal(checkpoint(root), null);
    const b = readLatestBundle(root, 'checkpoint');
    assert.equal(b.provenance.taskDigest, null);
    assert.match(b.provenance.planDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(b.provenance.baseline, null); // wire contract stays additive-compatible
  });
});

describe('the companion hash binds bytes — and says what it is not', () => {
  it('verification.sha256 matches the bundle bytes, detects a one-byte tamper, and is labeled tamper-evidence only', () => {
    const root = makeProject('hashbind');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    checkpoint(root);
    const dir = bundleDir(root, 'checkpoint');
    const jsonPath = path.join(dir, 'verification.json');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'verification.sha256'), 'utf8'));
    assert.equal(rec.file, 'verification.json');
    assert.match(rec.label, /tamper-evidence only/);
    assert.match(rec.label, /NOT a signature/);
    const bytes = fs.readFileSync(jsonPath, 'utf8');
    assert.equal(sha256(bytes), rec.sha256, 'untouched bytes must match the recorded hash');
    fs.writeFileSync(jsonPath, bytes.replace('"status": "pass"', '"status": "XXXX"'));
    assert.notEqual(sha256(fs.readFileSync(jsonPath, 'utf8')), rec.sha256, 'one flipped byte must show');
    // tampered bytes change NOTHING in behavior — they are never read back (M2)
    assert.equal(checkpoint(root), null, 'a tampered bundle must not forge or block a verdict');
  });
});

describe('baseline honesty', () => {
  it('a pre-M4 config (no baseline) yields baseline null, never an invented identity', () => {
    const root = makeProject('pre-m4');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    delete (cfg as { baseline?: unknown }).baseline;
    writeConfig(root, cfg);
    const r = canary(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(readLatestBundle(root, 'doctor').provenance.baseline, null);
    // and candidateIdentity itself stays the pinned honest shape on fake git
    assert.deepEqual(candidateIdentity(root), { resolved: false, head: null, tree: null, dirty: null });
  });
});
