import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { candidateDiffSignals, collectDiffSignals, discriminationObligation, readConfig } from '../src/onboarding.js';

const CLI = path.resolve(import.meta.dirname, '../src/main.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-discrimination-completion-'));
process.env.CANARY_TRUST_STORE = path.join(TMP, 'store');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SOURCE = "module.exports = n => 'hello ' + n;\n";
const FIXED = "module.exports = n => 'hello ' + n.trimStart();\n";
const TEST = "const {test} = require('node:test'); const assert = require('node:assert/strict'); const greet = require('../greet.cjs'); test('greet', () => assert.equal(greet('Ada'), 'hello Ada'));\n";
const REGRESSION = "test('leading whitespace', () => assert.equal(greet('  Ada'), 'hello Ada'));\n";
function git(root: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function pythonRuns(): boolean {
  const command = process.platform === 'win32' ? 'python.exe' : 'python';
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0;
}
function canary(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}
function commit(root: string) { git(root, 'add', '.'); git(root, 'commit', '--allow-empty', '-m', 'fixture'); }
function write(root: string, file: string, text: string) { fs.writeFileSync(path.join(root, file), text); }
function fixture(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  // v1.4 — the repository declares its harness. `setup` requires a DETECTED harness and
  // refuses (exit 2, correctly) when there is none; detection reads `<root>/.claude` or the
  // operator's `~/.claude`. Without this line the fixture passed only on a machine that has
  // Claude Code installed and failed on every CI runner — a host-dependent test, not a
  // product defect. Every other fixture in this suite already declares `.claude`.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  write(root, 'package.json', JSON.stringify({ name, private: true, scripts: { test: 'node --test tests/greet.test.cjs' } }));
  write(root, 'greet.cjs', SOURCE); write(root, 'tests/greet.test.cjs', TEST);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Canary Regression'); git(root, 'config', 'user.email', 'regression@canary.local'); commit(root);
  assert.equal(canary(root, 'setup', '--yes').code, 0);
  commit(root); assert.equal(canary(root, 'setup', '--yes').code, 0);
  return root;
}
function pythonFixture(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  write(root, 'pyproject.toml', '[project]\nname = "sealed-command-guidance"\nversion = "0.1.0"\nrequires-python = ">=3.8"\n');
  write(root, 'app.py', 'def value():\n    return 1\n');
  write(root, 'tests/__init__.py', '');
  write(root, 'tests/test_app.py', 'import unittest\nfrom app import value\n\nclass AppTests(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(value(), 1)\n');
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Canary Regression'); git(root, 'config', 'user.email', 'regression@canary.local'); commit(root);
  const setup = canary(root, 'setup', '--yes');
  assert.equal(setup.code, 0, setup.out);
  return root;
}
function work(root: string): string {
  const r = canary(root, 'work', 'fix', 'fix greeting whitespace', '--kind', 'bugfix');
  assert.equal(r.code, 0, r.out);
  return (JSON.parse(fs.readFileSync(path.join(root, '.canary/candidates/fix.json'), 'utf8')) as { root: string }).root;
}
function hook(root: string, active = false) {
  const r = spawnSync(process.execPath, [CLI, 'checkpoint'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    input: JSON.stringify({ cwd: root, stop_hook_active: active, hook_event_name: 'Stop' }),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) as { decision?: string; reason?: string; systemMessage?: string } : {};
}
function assertBlocked(root: string, reason: RegExp) {
  const before = git(root, 'rev-parse', 'HEAD');
  for (const args of [['isolate', '--verify', 'fix'], ['isolate', '--promote', 'fix'], ['finish', 'fix']]) {
    const r = canary(root, ...args);
    assert.equal(r.code, 2, r.out); assert.match(r.out, /NOT PROVEN/); assert.match(r.out, reason);
    assert.equal(git(root, 'rev-parse', 'HEAD'), before, 'unproven candidate cannot move the base');
  }
}
function assertDoctorAndHookBlocked(root: string, reason: RegExp) {
  const d = canary(root, 'doctor'); assert.equal(d.code, 2, d.out); assert.match(d.out, /NOT PROVEN/); assert.match(d.out, reason);
  const h = hook(root); assert.equal(h.decision, 'block'); assert.match(h.reason ?? '', reason);
  // The existing one-repair hook policy may stop, but must still disclose NOT PROVEN.
  assert.match(hook(root, true).systemMessage ?? '', /NOT PROVEN/);
}

test('an imported dash-test check is compared and retains worker provenance, while unused or copied assertions cannot prove work', () => {
  const root = fixture('imported-dash-test');
  fs.mkdirSync(path.join(root, 'scripts'));
  write(root, 'greet.cjs', FIXED);
  write(root, 'scripts/greet-regression-test.cjs', "const assert = require('node:assert/strict'); const greet = require('../greet.cjs'); assert.equal(greet('  Ada'), 'hello Ada');\n");
  const cfg = readConfig(root); assert.ok(cfg && cfg !== 'corrupt');
  assert.ok(collectDiffSignals(root, cfg).changes.includes('scripts/greet-regression-test.cjs'));
  assert.ok(candidateDiffSignals(root, cfg.baseline!.head!).changes.includes('scripts/greet-regression-test.cjs'));
  assert.equal(discriminationObligation(root, cfg)?.status, 'unproven', 'an unused file cannot certify work');
  write(root, 'tests/greet.test.cjs', TEST + "require('../scripts/greet-regression-test.cjs');\n");
  const genuine = discriminationObligation(root, cfg);
  assert.equal(genuine?.status, 'met', genuine?.note);
  assert.match(genuine?.caveat ?? '', /greet-regression-test\.cjs.*created by this session/);
  write(root, 'greet.cjs', "module.exports = n => 'hello ' + String(n);\n");
  write(root, 'scripts/greet-regression-test.cjs', "const assert = require('node:assert/strict'); const copied = n => 'hello ' + n.trimStart(); assert.equal(copied('  Ada'), 'hello Ada');\n");
  assert.equal(discriminationObligation(root, cfg)?.status, 'unproven', 'asserting copied logic cannot certify the real implementation');
});

test('an unavailable baseline check dependency remains unproven and its failing output survives temporary-tree cleanup', () => {
  const root = fixture('baseline-output-survives');
  fs.mkdirSync(path.join(root, 'scripts'));
  write(root, 'greet.cjs', FIXED);
  write(root, 'scripts/custom-check.cjs', "const assert = require('node:assert/strict'); const greet = require('../greet.cjs'); assert.equal(greet('  Ada'), 'hello Ada');\n");
  write(root, 'tests/greet.test.cjs', TEST + "require('../scripts/custom-check.cjs');\n");
  const cfg = readConfig(root); assert.ok(cfg && cfg !== 'corrupt');
  const result = discriminationObligation(root, cfg);
  assert.equal(result?.status, 'unproven');
  const output = result?.note.match(/baseline output: (.+?)(?: —|$)/)?.[1];
  assert.ok(output, result?.note);
  const files = fs.readdirSync(output).filter((file) => /\.(?:out|err)\.log$/.test(file));
  assert.ok(files.some((file) => fs.readFileSync(path.join(output, file), 'utf8').includes('custom-check.cjs')),
    'the operator must be able to identify the missing dependency after the comparison tree is removed');
});

test('BLOCKER 1: a comment-only test edit cannot verify, promote, finish, or pass the completion hook', () => {
  const root = fixture('comment-only'); const candidate = work(root);
  write(candidate, 'greet.cjs', FIXED); write(candidate, 'tests/greet.test.cjs', TEST + '// regression coverage reviewed\n'); commit(candidate);
  assertBlocked(root, /base commit too/);
  write(root, 'greet.cjs', FIXED); write(root, 'tests/greet.test.cjs', TEST + '// regression coverage reviewed\n');
  assertDoctorAndHookBlocked(root, /base commit too/);
});

test('BLOCKER 2: helper missing only from baseline cannot improve any completion verdict', () => {
  const root = fixture('missing-helper'); const candidate = work(root);
  write(candidate, 'greet.cjs', FIXED); write(candidate, 'tests/greet.test.cjs', TEST + '// unchanged assertions\n'); commit(candidate);
  assertBlocked(root, /base commit too/);
  write(candidate, 'helper.cjs', 'module.exports = {};\n'); write(candidate, 'tests/greet.test.cjs', "require('../helper.cjs');\n" + TEST); commit(candidate);
  assertBlocked(root, /comparison could not be established/);
  write(root, 'greet.cjs', FIXED); write(root, 'tests/greet.test.cjs', TEST + '// unchanged assertions\n');
  assertDoctorAndHookBlocked(root, /base commit too/);
  write(root, 'helper.cjs', 'module.exports = {};\n'); write(root, 'tests/greet.test.cjs', "require('../helper.cjs');\n" + TEST);
  assertDoctorAndHookBlocked(root, /comparison could not be established/);
});

test('candidate comparison uses isolation base even when setup baseline would discriminate', () => {
  const root = fixture('frozen-base');
  write(root, 'tests/greet.test.cjs', TEST + REGRESSION); commit(root);
  assert.equal(canary(root, 'setup', '--yes').code, 2, 'setup baseline is red');
  write(root, 'greet.cjs', FIXED); commit(root);
  const candidate = work(root);
  write(candidate, 'greet.cjs', FIXED + '// no behavior change\n'); write(candidate, 'tests/greet.test.cjs', TEST + REGRESSION + '// comment\n'); commit(candidate);
  assertBlocked(root, /base commit too/);
});

test('a discriminating check allows the same candidate to finish and promote', () => {
  const root = fixture('positive'); const candidate = work(root);
  write(candidate, 'greet.cjs', FIXED); write(candidate, 'tests/greet.test.cjs', TEST + REGRESSION); commit(candidate);
  const expected = git(candidate, 'rev-parse', 'HEAD');
  const r = canary(root, 'finish', 'fix'); assert.equal(r.code, 0, r.out); assert.equal(git(root, 'rev-parse', 'HEAD'), expected);
  assert.equal(canary(root, 'doctor').code, 0); assert.notEqual(hook(root).decision, 'block');
});

test('a worker check crashing on absent baseline data cannot certify a change', () => {
  const root = fixture('baseline-data-crash');
  const candidate = work(root);
  const helper = path.resolve(import.meta.dirname, '../../../../tooling/test-support/fixtures/f-check-input.cjs');
  for (const target of [candidate, root]) {
    fs.copyFileSync(helper, path.join(target, 'tests/check-input.cjs'));
    write(target, 'greet.cjs', FIXED);
    write(target, 'receipt.txt', 'agent-created input');
    write(target, 'tests/greet.test.cjs', TEST + "require('./check-input.cjs').missingFixture();\n");
  }
  commit(candidate);
  assertBlocked(root, /comparison could not be established/);
  assertDoctorAndHookBlocked(root, /worker-authored check.*same inputs/);

  // Wrapping the same crash in an assertion does not establish input parity.
  write(root, 'tests/greet.test.cjs', TEST + "require('./check-input.cjs').missingFixtureWrapped();\n");
  const stillMissing = canary(root, 'doctor');
  assert.equal(stillMissing.code, 2, stillMissing.out);
  assert.match(stillMissing.out, /same inputs used for the baseline comparison/);

  // A real assertion over defined inputs still proves the fix, with worker provenance.
  write(root, 'tests/greet.test.cjs', TEST + "require('./check-input.cjs').assertExpected();\n");
  const repaired = canary(root, 'doctor');
  assert.equal(repaired.code, 0, repaired.out);
  assert.match(repaired.out, /NOT independent authority/);
  assert.notEqual(hook(root).decision, 'block');
});

test('a genuine old implementation crash remains discriminating when the input control passes', () => {
  const root = fixture('genuine-runtime-fix');
  const old = path.resolve(import.meta.dirname, '../../../../tooling/test-support/fixtures/f-greet-runtime-base.cjs');
  fs.copyFileSync(old, path.join(root, 'greet.cjs'));
  commit(root);
  assert.equal(canary(root, 'setup', '--yes').code, 0);
  write(root, 'greet.cjs', FIXED);
  write(root, 'tests/greet.test.cjs', TEST + REGRESSION);
  const result = canary(root, 'doctor');
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /NOT independent authority/);
});

test('missing regression proof points to the sealed test entry, never a changed script', () => {
  const root = fixture('sealed-test-guidance');
  write(root, 'greet.cjs', FIXED);
  const missing = hook(root);
  assert.equal(missing.decision, 'block');
  assert.match(missing.reason ?? '', /package\.json scripts\.test = "node --test tests\/greet\.test\.cjs"/);
  assert.match(missing.reason ?? '', /a new test file counts only when this entry runs it/);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.scripts.test = 'node unsealed-check.cjs';
  write(root, 'package.json', JSON.stringify(pkg));
  const drift = hook(root);
  assert.equal(drift.decision, 'block');
  assert.doesNotMatch(drift.reason ?? '', /unsealed-check\.cjs/);
});

test('argv-based projects get the exact sealed test command in regression guidance', (t) => {
  if (!pythonRuns()) { t.skip('no Python interpreter on PATH'); return; }
  const root = pythonFixture('sealed-python-test-guidance');
  const cfg = readConfig(root);
  assert.ok(cfg && cfg !== 'corrupt');
  const step = cfg.plan.find((candidate) => candidate.kind === 'tests');
  assert.ok(step?.argv, 'the Python test step must use sealed argv');

  write(root, 'app.py', '# harmless edit; behavior is still covered by the same test\ndef value():\n    return 1\n');
  const result = hook(root);
  assert.equal(result.decision, 'block');
  assert.ok(result.reason?.includes(`The sealed test command is ${JSON.stringify(step.argv)} (entry ${JSON.stringify(step.script)})`), result.reason);
  assert.match(result.reason ?? '', /a new test file counts only if this command runs it/);

  const mutated = JSON.parse(fs.readFileSync(path.join(root, '.canary/canary.local.json'), 'utf8')) as typeof cfg;
  mutated.plan[0]!.argv = ['python', '-c', 'print("unsealed")'];
  write(root, '.canary/canary.local.json', JSON.stringify(mutated, null, 2));
  const drift = hook(root);
  assert.match(drift.reason ?? '', /verification authority changed/);
  assert.doesNotMatch(drift.reason ?? '', /print\("unsealed"\)/);
});

test('doctor visibly labels worker-authored regression evidence as non-independent', () => {
  const root = fixture('worker-authored-evidence');
  write(root, 'greet.cjs', FIXED);
  write(root, 'tests/greet.test.cjs', TEST + REGRESSION);

  const human = canary(root, 'doctor');
  assert.equal(human.code, 0, human.out);
  assert.match(human.out, /READY/);
  assert.match(human.out, /NOT independent authority/);
  assert.match(human.out, /tests\/greet\.test\.cjs \(EXISTING check rewritten by this session\)/);

  const json = spawnSync(process.execPath, [CLI, 'doctor', '--json'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  assert.equal(json.status, 0, json.stderr);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.status, 'READY');
  assert.equal(envelope.proof.registeredRequirements, 0);
  const evidence = envelope.proof.obligations.find((ob: { id: string }) => ob.id === 'regression-evidence');
  assert.equal(evidence.status, 'met');
  assert.match(evidence.caveat, /NOT independent authority/);
  assert.match(json.stderr, /NOT independent authority/);

  assert.notEqual(hook(root).decision, 'block');
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.canary/last-checkpoint.json'), 'utf8'));
  assert.deepEqual(stored.proof, envelope.proof);
  const history = spawnSync(process.execPath, [CLI, 'result', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const recorded = JSON.parse(history.stdout).lastVerification;
  assert.equal(recorded.historical, true);
  assert.deepEqual(recorded.proof, stored.proof);
});

test('JSON proof information does not upgrade an unbound task requirement to READY', () => {
  const root = fixture('proof-unbound-requirement');
  write(root, 'greet.cjs', FIXED);
  write(root, 'tests/greet.test.cjs', TEST + REGRESSION);
  assert.equal(canary(root, 'task', 'fix greeting', '--requirement', 'Preserve the requested whitespace contract').code, 0);
  const result = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 2, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, 'NOT PROVEN');
  assert.equal(envelope.proof.registeredRequirements, 1);
  assert.ok(envelope.proof.obligations.some((ob: { status: string }) => ob.status === 'unproven'));
  const checkpointPath = path.join(root, '.canary/last-checkpoint.json');
  const forged = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  forged.proof = { registeredRequirements: 0, obligations: [] };
  fs.writeFileSync(checkpointPath, JSON.stringify(forged));
  const rechecked = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(rechecked.status, 2, rechecked.stderr);
  assert.equal(JSON.parse(rechecked.stdout).proof.registeredRequirements, 1, 'stored proof summaries never supply verdict authority');
});

test('historical proof retains the supported maximum requirement set and rejects malformed rows', () => {
  const root = fixture('proof-maximum-requirements');
  write(root, 'greet.cjs', FIXED);
  write(root, 'tests/greet.test.cjs', TEST + REGRESSION);
  const requirements = Array.from({ length: 64 }, (_, i) => `Keep runtime below ${i + 1} ms`);
  assert.equal(canary(root, 'task', 'fix greeting', ...requirements.flatMap((text) => ['--requirement', text])).code, 0);
  const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(doctor.status, 2, doctor.stderr);
  const proof = JSON.parse(doctor.stdout).proof;
  assert.equal(proof.registeredRequirements, 64);
  assert.ok(proof.obligations.length > 32, 'this exercises a legitimate large proof, not synthetic cache data');
  assert.ok(proof.obligations.some((ob: { caveat?: string }) => /NOT independent authority/.test(ob.caveat ?? '')));
  const readResult = () => {
    const r = spawnSync(process.execPath, [CLI, 'result', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const historical = readResult();
  assert.equal(historical.status, 'CONNECTED');
  assert.equal(historical.lastVerification.historical, true);
  assert.deepEqual(historical.lastVerification.proof, proof);
  const checkpointPath = path.join(root, '.canary/last-checkpoint.json');
  const malformed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  malformed.proof.obligations[0].status = 'invented-pass';
  fs.writeFileSync(checkpointPath, JSON.stringify(malformed));
  const refused = readResult();
  assert.equal(refused.status, 'CONNECTED');
  assert.equal(refused.lastVerification.historical, true);
  assert.equal(refused.lastVerification.proof, undefined, 'invalid rows cannot be displayed as observed valid proof');
  malformed.proof = { ...proof, registeredRequirements: 65 };
  fs.writeFileSync(checkpointPath, JSON.stringify(malformed));
  assert.equal(readResult().lastVerification.proof, undefined, 'an unsupported requirement count is not a valid observed summary');
});

test('no change and documentation-only changes retain their comparison exemptions', () => {
  const root = fixture('no-change');
  assert.equal(canary(root, 'doctor').code, 0);
  write(root, 'README.md', 'Documentation only.\n');
  assert.equal(canary(root, 'doctor').code, 0); assert.notEqual(hook(root).decision, 'block');
});

test('unavailable base, materialization, and execution remain objective UNPROVEN', (t) => {
  const root = fixture('unavailable'); const cfg = readConfig(root);
  assert.ok(cfg && cfg !== 'corrupt');
  write(root, 'greet.cjs', FIXED); write(root, 'tests/greet.test.cjs', TEST + REGRESSION);
  const missing = discriminationObligation(root, cfg, 10_000, 'a'.repeat(40));
  assert.equal(missing?.status, 'unproven'); assert.equal(missing?.mode, 'objective');
  const create = t.mock.method(fs, 'mkdtempSync', () => { throw new Error('materialization denied'); });
  const failed = discriminationObligation(root, cfg); assert.equal(failed?.status, 'unproven'); assert.match(failed?.note ?? '', /materialization denied/);
  create.mock.restore();
  const unavailable = { ...cfg, plan: [{ ...cfg.plan[0]!, argv: [path.join(TMP, 'missing-program')] }] };
  assert.equal(discriminationObligation(root, unavailable)?.status, 'unproven');
});
