// v1.3 §D — DOES THE MODEL USE `edit`, OR DOES IT REWRITE THE WHOLE FILE?
//
// This exists because this repository has already made this mistake once. A previous experiment made a
// multi-operation `batch` primitive AVAILABLE and concluded something about efficiency; the model used
// it ZERO times in 50 calls, so the experiment had measured MODEL TOOL CHOICE, not the interface. The
// same trap applies to `edit`: adding a compact primitive proves nothing about whether the model picks
// it. So this probe asks the narrow question directly and cheaply, on a small real task, instead of
// spending a full stress-test pilot on an unvalidated interface.
//
// It runs the REAL confined transport with the REAL model on a tiny repository, then reads the
// transport stream and reports, per tool call:
//   - which primitive was chosen (edit vs write), and how many of each;
//   - the bytes the model put into its OWN message (the term that is re-read on every later turn).
//
// It asserts PLUMBING and CORRECTNESS (the change really landed, checked from the trusted side). It
// REPORTS the choice rather than asserting it: asserting a model's preference would be a flaky test of
// the model, not of the product.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { removeMeasurementAuthority } from '../../apps/cli/dist/src/provider/production-measurement.js';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
const claude = path.join(os.homedir(), '.local/bin/claude.exe');
// `indexOf` returns -1 when the flag is absent, and `argv[-1 + 1]` is argv[0] — the interpreter path.
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
};
const model = argOf('model', 'qwen3.8-flash');
const timeoutMin = Number(argOf('timeout-min', '15')) || 15;
const outPath = path.join(os.tmpdir(), 'canary-edit-choice.json');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-edit-choice-'));
const base = path.join(temp, 'project'), work = path.join(temp, 'candidate'), store = path.join(temp, 'store');
const promptFile = path.join(temp, 'prompt.txt');
let broker = null, failure = null;

const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'local-trust') };
const run = (exe, args, cwd = base, expect = 0) => {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  if (expect !== null) assert.equal(r.status, expect, `${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r;
};
const canary = (args, expect = 0) => run(process.execPath, [cli, ...args], base, expect);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A ~2 KB module with ONE seeded defect: `remove` forgets to invalidate the cache. */
const SOURCE = [
  "'use strict';",
  '// A small ledger. `remove` is supposed to leave no trace of the row it removed.',
  'class Ledger {',
  '  constructor() { this.rows = new Map(); this.cache = new Map(); }',
  '',
  '  put(tenant, id, value) {',
  '    const key = `${tenant}:${id}`;',
  '    this.rows.set(key, value);',
  '    this.cache.set(key, value);',
  '    return value;',
  '  }',
  '',
  '  get(tenant, id) {',
  '    const key = `${tenant}:${id}`;',
  '    if (this.cache.has(key)) return this.cache.get(key);',
  '    const value = this.rows.get(key);',
  '    if (value !== undefined) this.cache.set(key, value);',
  '    return value;',
  '  }',
  '',
  '  remove(tenant, id) {',
  '    const key = `${tenant}:${id}`;',
  '    this.rows.delete(key);',
  '    return !this.rows.has(key);',
  '  }',
  ...Array.from({ length: 24 }, (_, i) => `  // padding ${i}: keeps this module at a realistic size for the measurement`),
  '}',
  '',
  'module.exports = { Ledger };',
  '',
].join('\n');

const CHECK = [
  "'use strict';",
  "const assert = require('node:assert/strict');",
  "const { Ledger } = require('./ledger.cjs');",
  'const l = new Ledger();',
  "l.put('a', '1', 'x');",
  "assert.equal(l.get('a', '1'), 'x');",
  "assert.equal(l.remove('a', '1'), true);",
  "assert.equal(l.get('a', '1'), undefined, 'a removed row must not come back from the cache');",
  "console.log('ledger OK');",
  '',
].join('\n');

try {
  fs.mkdirSync(base, { recursive: true });
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'edit-choice', private: true, scripts: { test: 'node run-tests.js' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(base, 'ledger.cjs'), SOURCE);
  fs.writeFileSync(path.join(base, 'run-tests.js'), CHECK);
  run(gitExe, ['init', '-b', 'main']);
  run(gitExe, ['config', 'user.name', 'Choice Probe']);
  run(gitExe, ['config', 'user.email', 'choice@localhost']);
  run(gitExe, ['add', '-A']);
  run(gitExe, ['commit', '-m', 'baseline with a seeded defect']);

  canary(['setup', '--yes'], null); // the plan is RED here, which setup reports and still seals
  assert.ok(fs.existsSync(path.join(base, '.canary', 'canary.local.json')), 'the plan was not sealed');
  canary(['task', 'fix the ledger so a removed row cannot come back from the cache']);
  run(gitExe, ['add', '-A']);
  run(gitExe, ['commit', '--allow-empty', '-m', 'operator wiring']);
  const enrolled = JSON.parse(canary(['provider', 'enroll', base, store]).stdout);

  // The candidate is the same starting bytes, in its own git repo — the workspace the model gets.
  // `.canary` (the sealed authority) and `.git` (the base's history) belong to the trusted side, not
  // to the worker's copy.
  const skipOwn = (p) => !p.split(path.sep).some((seg) => seg === '.canary' || seg === '.git');
  fs.cpSync(base, work, { recursive: true, filter: skipOwn });
  run(gitExe, ['init', '-b', 'main'], work);
  run(gitExe, ['config', 'user.name', 'Worker'], work);
  run(gitExe, ['config', 'user.email', 'worker@localhost'], work);
  run(gitExe, ['add', '-A'], work);
  run(gitExe, ['commit', '-m', 'starting bytes'], work);

  fs.writeFileSync(promptFile, [
    'The project in this workspace has one defect: `node run-tests.js` fails because a removed row',
    'comes back from the cache. Fix it. Change as little as possible. Run the tests to confirm.',
    '',
  ].join('\n'));

  const { challenge } = JSON.parse(canary(['provider', 'measurement-begin', store]).stdout);
  broker = spawn(process.execPath, [cli, 'provider', 'serve-production', store], { cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let brokerLog = ''; broker.stdout.on('data', (x) => brokerLog += x); broker.stderr.on('data', (x) => brokerLog += x);
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await new Promise((resolve) => { const s = net.connect('\\\\.\\pipe\\' + enrolled.pipe); s.on('connect', () => s.write('{"verb":"hello"}\n')); s.on('data', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
    if (!ready) await sleep(250);
  }
  assert.ok(ready, `broker unavailable: ${brokerLog}`);

  const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  const transportEnv = { ...env, ...(settings.env ?? {}) };
  assert.ok(transportEnv.ANTHROPIC_AUTH_TOKEN || transportEnv.ANTHROPIC_API_KEY, 'no model credential in the harness settings');

  const startedAt = Date.now();
  const child = spawn(process.execPath, [cli, 'provider', 'model-transport', store, work, promptFile, model, claude],
    { cwd: temp, env: transportEnv, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (x) => stdout += x); child.stderr.on('data', (x) => stderr += x);
  const code = await Promise.race([new Promise((r) => child.once('exit', r)), sleep(timeoutMin * 60000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill();
  const durationMs = Date.now() - startedAt;
  fs.writeFileSync(path.join(os.tmpdir(), 'canary-edit-choice-transport.log'), stdout + stderr);

  // ── what the model actually sent ──
  const events = stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use'));
  const ops = calls.flatMap((c) => Array.isArray(c.input?.operations) ? c.input.operations : []);
  const byOp = {};
  for (const o of ops) byOp[o?.op ?? '?'] = (byOp[o?.op ?? '?'] ?? 0) + 1;
  const payloadBytes = calls.reduce((n, c) => n + JSON.stringify(c.input ?? {}).length, 0);
  const editBytes = calls.reduce((n, c) => n + (Array.isArray(c.input?.operations) ? c.input.operations.filter((o) => o?.op === 'edit') : []).reduce((m, o) => m + JSON.stringify(o).length, 0), 0);
  const writeBytes = calls.reduce((n, c) => n + (Array.isArray(c.input?.operations) ? c.input.operations.filter((o) => o?.op === 'write') : []).reduce((m, o) => m + JSON.stringify(o).length, 0), 0);
  const resultEvent = [...events].reverse().find((e) => e.type === 'result');
  const u = resultEvent?.usage ?? {};
  const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

  // ── did the change actually land? asked from the TRUSTED side, not from the model's word ──
  const after = fs.existsSync(path.join(work, 'ledger.cjs')) ? fs.readFileSync(path.join(work, 'ledger.cjs'), 'utf8') : '';
  const cacheInvalidated = /remove\s*\([\s\S]{0,200}?this\.cache\.delete\(/.test(after);
  const suite = spawnSync(process.execPath, ['run-tests.js'], { cwd: work, encoding: 'utf8', windowsHide: true, timeout: 60000 });

  const record = {
    schema: 'canary-edit-choice/1', model, startedAt: new Date(startedAt).toISOString(), durationMs,
    transportExit: code === 'timeout' ? 'timeout' : code,
    calls: calls.length, operations: ops.length, byOp, payloadBytes, editBytes, writeBytes, tokens,
    sourceBytes: SOURCE.length,
    landed: { cacheInvalidated, suiteExit: suite.status, suiteStdout: (suite.stdout ?? '').trim().slice(0, 300) },
    authority: 'a tool-choice observation on one small real task; NOT a token benchmark and NOT a release claim',
  };
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');

  console.log(`model ${model}; transport exit ${record.transportExit}; ${calls.length} call(s), ${ops.length} operation(s)`);
  console.log(`operations by kind: ${JSON.stringify(byOp)}`);
  console.log(`bytes the model put in its OWN message: ${payloadBytes} (edit ${editBytes}, write ${writeBytes}) of a ${SOURCE.length} B source file`);
  console.log(`tokens: ${tokens}`);
  console.log(`trusted readback: cache invalidated = ${cacheInvalidated}; suite exit ${suite.status}`);
  console.log(`record: ${outPath}`);

  assert.equal(record.transportExit, 0, `the confined transport must exit cleanly:\n${stderr.slice(0, 1200)}`);
  assert.equal(cacheInvalidated, true, 'the model did not actually fix the defect — the observation is about plumbing, not preference');
  assert.equal(suite.status, 0, `the project suite must pass after the fix:\n${suite.stdout}`);
  console.log('\n=== edit choice: measured (choice REPORTED, correctness ASSERTED) ===');
} catch (e) {
  failure = e;
  console.error(`EDIT-CHOICE FAILED: ${e?.message ?? e}`);
} finally {
  if (broker) broker.kill();
  try { removeMeasurementAuthority(store); } catch { /* absent is fine */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (failure) process.exitCode = 1;
}
