import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-preflight-audit-'));
const marker = path.join(temp, 'worker-launches.txt');
const observer = pathToFileURL(path.join(repo, 'tooling/test-support/fixtures/benchmark-worker-tripwire.mjs')).href;
const env = { ...process.env, NODE_OPTIONS: `--import=${observer}`, CANARY_TEST_WORKER_TRIPWIRE: marker,
  CANARY_TRUST_STORE: path.join(temp, 'trust') };
try {
  // Positive control: the observer must actually detect a launch.
  const control = spawnSync(process.execPath, [path.join(repo, 'tooling/test-support/fixtures/benchmark-worker-tripwire-control.mjs')], { env, encoding: 'utf8' });
  assert.notEqual(control.status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'worker launch attempted\n');
  fs.unlinkSync(marker);
  console.log('PASS worker-launch observer positive control');
  for (const [task, stratum, reason] of [
    ...['add-validation', 'cross-file-refactor', 'regression-guard'].map(t => [t, 'B-unbound', 'REQUIREMENT_UNBOUND']),
    ...['bound-requirements', 'bug-sum', 'stateful-replay'].map(t => [t, 'A-executable', 'CONFINED_WORKER_INTEGRATION_UNAVAILABLE']),
  ]) {
    const out = path.join(temp, `${task}.json`);
    const args = [path.join(repo, 'tooling/benchmark/run-trial.mjs'), '--task', task, '--arm', 'workflow', '--out', out];
    const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 300000 });
    assert.equal(result.status, 2, `${task}: ${result.stderr}`);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(record.schema, 'canary-benchmark-preflight/1');
    assert.equal(record.reason, reason, JSON.stringify(record));
    assert.equal(record.stratum, stratum);
    assert.deepEqual(record.worker, { calls: 0, tokens: 0, turns: 0 });
    assert.equal(record.deliveredCorrectness, null);
    assert.equal('agentResult' in record, false);
    assert.equal('hidden' in record, false);
    assert.equal(fs.existsSync(marker), false, 'worker launch was attempted');
    const bytes = fs.readFileSync(out);
    const retry = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(retry.status, 2);
    assert.match(retry.stderr, /refusing to overwrite/);
    assert.deepEqual(fs.readFileSync(out), bytes);
    console.log(`PASS ${task}: ${reason}; zero worker launches; immutable record`);
  }
  console.log('PASS 6 preflight cases, 1 launch-observer positive control; no delivery or HARDENED claim');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
