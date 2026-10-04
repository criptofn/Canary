#!/usr/bin/env node
/** Installed CLI comparison: compiled tests must see current, not stale, output. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [before, after, out] = process.argv.slice(2);
assert.ok([before, after, out].every((p) => p && path.isAbsolute(p)));
assert.ok(!fs.existsSync(out), 'use a new evidence directory');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-build-order-'));
fs.mkdirSync(out, { recursive: true });
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fixture = path.resolve(import.meta.dirname, '../test-support/fixtures/build-dependent-check.cjs');
const records = [];
let seq = 0;
const invoke = (cli, root, args, input) => {
  const call = spawnSync(process.execPath, [cli, ...args], { cwd: root, input, encoding: 'utf8', windowsHide: true,
    timeout: 120000, env: { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'trust') } });
  const id = `${++seq}-${path.basename(root)}-${args[0]}`;
  fs.writeFileSync(path.join(out, `${id}.stdout.txt`), call.stdout ?? '');
  fs.writeFileSync(path.join(out, `${id}.stderr.txt`), call.stderr ?? '');
  records.push({ id, cli, cliSha256: hash(fs.readFileSync(cli)), args, input: input ?? null, exitCode: call.status,
    signal: call.signal, error: call.error?.message ?? null });
  assert.equal(call.error, undefined, `${id}: ${call.error}`);
  return call;
};
const project = (name, implementation, artifact) => {
  const root = path.join(temp, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.copyFileSync(fixture, path.join(root, 'checks.cjs'));
  fs.writeFileSync(path.join(root, 'implementation.json'), `${implementation}\n`);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node checks.cjs test', build: 'node checks.cjs build' } }));
  if (artifact !== undefined) {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist/implementation.json'), `${artifact}\n`);
  }
  return root;
};
const checkpoint = (cli, root) => invoke(cli, root, ['checkpoint'], JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: root }));
const outcomes = [];
let failure = null;
try {
  for (const [arm, cli] of [['before', before], ['after', after]]) {
    const clean = project(`${arm}-clean`, true);
    const setup = invoke(cli, clean, ['setup', '--yes']);
    assert.equal(setup.status, arm === 'before' ? 2 : 0, setup.stdout + setup.stderr);
    const setupCheckpoint = JSON.parse(fs.readFileSync(path.join(clean, '.canary/last-checkpoint.json')));
    outcomes.push({ arm, case: 'correct clean setup', exitCode: setup.status, status: setupCheckpoint.status });
    if (arm === 'after') {
      fs.rmSync(path.join(clean, 'dist'), { recursive: true });
      assert.equal(checkpoint(cli, clean).stdout.trim(), '', 'one completion after clean must suffice');
      outcomes.push({ arm, case: 'correct completion after clean', status: 'pass' });
    }
    const stale = project(`${arm}-stale-green`, false, true);
    const result = invoke(cli, stale, ['setup', '--yes']);
    assert.equal(result.status, arm === 'before' ? 0 : 2, result.stdout + result.stderr);
    const cp = JSON.parse(fs.readFileSync(path.join(stale, '.canary/last-checkpoint.json')));
    assert.equal(cp.status, arm === 'before' ? 'pass' : 'fail');
    assert.equal(fs.readFileSync(path.join(stale, 'dist/implementation.json'), 'utf8'), 'false\n');
    outcomes.push({ arm, case: 'broken current source with stale passing artifact', exitCode: result.status, status: cp.status });
    if (arm === 'after') {
      fs.writeFileSync(path.join(stale, 'implementation.json'), 'true\n');
      assert.equal(invoke(cli, stale, ['doctor']).status, 0, 'one repair must rebuild stale failing output');
      fs.writeFileSync(path.join(stale, 'implementation.json'), 'BUILD_ERROR\n');
      assert.equal(JSON.parse(checkpoint(cli, stale).stdout).decision, 'block');
      const failed = JSON.parse(fs.readFileSync(path.join(stale, '.canary/last-checkpoint.json')));
      assert.deepEqual(failed.checks.map((s) => s.ok), [false, true]);
      outcomes.push({ arm, case: 'failed build with stale passing artifact', status: failed.status });
    }
    fs.cpSync(clean, path.join(out, `${arm}-clean-state`), { recursive: true });
    fs.cpSync(stale, path.join(out, `${arm}-stale-state`), { recursive: true });
  }
  const legacy = project('legacy-seal', true, true);
  // Simulate an in-place binary upgrade. A different installation path is
  // deliberately refused by Canary and is not a plan-order compatibility test.
  const upgradeRoot = path.join(temp, 'upgrade-install');
  fs.mkdirSync(upgradeRoot);
  fs.writeFileSync(path.join(upgradeRoot, 'package.json'), '{"type":"module"}\n');
  const legacyCli = path.join(upgradeRoot, 'main.js'); // the bundled CLI owns this exact entry name
  fs.copyFileSync(before, legacyCli);
  assert.equal(invoke(legacyCli, legacy, ['setup', '--yes']).status, 0);
  const configPath = path.join(legacy, '.canary/canary.local.json');
  const original = fs.readFileSync(configPath);
  const plan = JSON.parse(original).plan;
  assert.deepEqual(plan.map((s) => s.kind), ['tests', 'build']);
  fs.writeFileSync(path.join(legacy, 'check-order.txt'), '');
  fs.copyFileSync(after, legacyCli);
  const upgraded = invoke(legacyCli, legacy, ['doctor']);
  assert.equal(upgraded.status, 0, `new CLI must honor old sealed order: ${upgraded.stdout} ${upgraded.stderr}`);
  assert.deepEqual(fs.readFileSync(configPath), original);
  assert.equal(fs.readFileSync(path.join(legacy, 'check-order.txt'), 'utf8'), 'test\nbuild\ntest\n');
  outcomes.push({ case: 'previously installed seal', configByteEqual: true, executionOrder: ['tests', 'build', 'tests'] });
  fs.writeFileSync(path.join(legacy, 'implementation.json'), 'false\n');
  const staleLegacy = invoke(legacyCli, legacy, ['doctor']);
  assert.equal(staleLegacy.status, 2, 'a legacy seal must not certify changed broken source using a stale passing build');
  const staleLegacyCheckpoint = JSON.parse(fs.readFileSync(path.join(legacy, '.canary/last-checkpoint.json')));
  assert.equal(staleLegacyCheckpoint.status, 'fail', 'the rebuilt broken implementation must fail verification');
  assert.deepEqual(staleLegacyCheckpoint.checks.map((step) => step.ok), [true, true, false], 'the post-build test must expose the stale passing test');
  assert.deepEqual(fs.readFileSync(configPath), original, 'checking freshness cannot rewrite sealed authority');
  outcomes.push({ case: 'legacy seal with changed broken source and stale passing artifact', status: 'fail', configByteEqual: true });
  fs.writeFileSync(path.join(legacy, 'dist/implementation.json'), 'true\n');
  assert.equal(JSON.parse(checkpoint(legacyCli, legacy).stdout).decision, 'block', 'completion must reject the same legacy stale-artifact regression');
  const legacyStop = JSON.parse(fs.readFileSync(path.join(legacy, '.canary/last-checkpoint.json')));
  assert.equal(legacyStop.status, 'fail');
  assert.deepEqual(legacyStop.checks.map((step) => step.ok), [true, true, false]);
  outcomes.push({ case: 'legacy completion with stale passing artifact', status: 'fail', hook: 'block' });
  fs.writeFileSync(path.join(legacy, 'implementation.json'), 'true\n');
  assert.equal(invoke(legacyCli, legacy, ['doctor']).status, 2, 'a later passing test cannot waive an earlier failed sealed check');
  const retainedFailure = JSON.parse(fs.readFileSync(path.join(legacy, '.canary/last-checkpoint.json')));
  assert.deepEqual(retainedFailure.checks.map((step) => step.ok), [false, true, true]);
  assert.equal(invoke(legacyCli, legacy, ['doctor']).status, 0, 'a correct current legacy state must still be accepted');
  outcomes.push({ case: 'legacy repair keeps the initial failure, then accepts a fully passing plan', status: 'pass' });
  fs.writeFileSync(path.join(legacy, 'implementation.json'), 'BUILD_ERROR\n');
  assert.equal(invoke(legacyCli, legacy, ['doctor']).status, 2, 'a failed legacy build cannot be waived by passing tests');
  const retainedBuildFailure = JSON.parse(fs.readFileSync(path.join(legacy, '.canary/last-checkpoint.json')));
  assert.deepEqual(retainedBuildFailure.checks.map((step) => step.ok), [true, false, true]);
  assert.deepEqual(fs.readFileSync(configPath), original);
  outcomes.push({ case: 'legacy failed build with passing artifacts remains failed', status: 'fail', configByteEqual: true });
  fs.cpSync(legacy, path.join(out, 'legacy-state'), { recursive: true });
  console.log(`PASS ${outcomes.length} installed-product observations; legacy seal unchanged`);
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(failure); process.exitCode = 1;
} finally {
  fs.copyFileSync(import.meta.filename, path.join(out, 'instrument.mjs'));
  fs.copyFileSync(fixture, path.join(out, 'fixture.cjs'));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ status: failure ? 'incomplete' : 'complete', failure, scope: 'controlled product regression; no model calls',
    instrumentSha256: hash(fs.readFileSync(import.meta.filename)), fixtureSha256: hash(fs.readFileSync(fixture)), outcomes, records }, null, 2));
  const files = fs.readdirSync(out, { recursive: true }).filter((p) => fs.statSync(path.join(out, p)).isFile()).sort();
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${files.map((p) => `${hash(fs.readFileSync(path.join(out, p)))}  ${p.replaceAll('\\', '/')}`).join('\n')}\n`);
  console.log(`${files.length} raw files hashed`);
  fs.rmSync(temp, { recursive: true, force: true });
}
