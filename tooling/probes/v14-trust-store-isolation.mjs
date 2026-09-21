#!/usr/bin/env node
/**
 * v1.4 — TRUST-STORE ISOLATION REGRESSION.
 *
 * MEASURED DEFECT (the one this closes): M2/M9 passed 33/33 alone and failed inside the
 * productization battery. The reason was NOT a product behaviour. Every suite set
 *
 *     process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`)
 *
 * a path derived from a RECYCLABLE pid and therefore SHARED with an unrelated earlier run. The raw
 * error, obtained only after the suite was made to print setup's `--verbose` output, was:
 *
 *     the trust store refused the record: trust store key material is missing from an
 *     initialized store; operator recovery is required, never silent re-minting
 *
 * i.e. a stale store left by some earlier process (ledger present, keys gone) was picked up by a
 * later process that happened to get the same pid. Because a failing `setup` was discarded by the
 * suite, the symptom surfaced as a misleading `config is unreadable` assertion instead.
 *
 * This probe pins the four properties the fix must have:
 *   A. no test derives its trust store from a recyclable identifier (static guard on the class);
 *   B. an UNRELATED stale store cannot corrupt a new run (fresh store -> setup succeeds);
 *   C. pointing a run AT the damaged store still FAILS CLOSED (the product's refusal is intact —
 *      this is the guard against "fixing" isolation by weakening the store);
 *   D. repeated runs give the SAME verdict (determinism, not luck).
 *
 * Deterministic, self-cleaning, exit 0 only when all four hold.
 *
 * Usage: node tooling/probes/v14-trust-store-isolation.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e)}`); }
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-store-isolation-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* OS temp */ } };
process.on('exit', cleanup);

/** A project whose own check passes, so `setup` can complete. */
function fixture(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name, scripts: { test: `node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', 'f-pass.js')}"` },
  }, null, 2));
  return root;
}
const setup = (root, store) => spawnSync(process.execPath, [CLI, 'setup', '--yes', '--verbose', root],
  { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, CANARY_TRUST_STORE: store } });

console.log('=== A. no test derives its trust store from a recyclable identifier ===');
check('every CANARY_TRUST_STORE in apps/cli/test is a fresh mkdtemp (or an explicit per-test path)', () => {
  const dir = path.join(REPO, 'apps', 'cli', 'test');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.ts'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!/CANARY_TRUST_STORE/.test(line)) continue;
      if (/process\.pid|Date\.now\(\)|os\.hostname\(\)/.test(line)) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `a recyclable id can collide with stale state:\n${offenders.join('\n')}`);
});

console.log('\n=== B/C. a stale store corrupts nothing, and a damaged store still fails closed ===');
// The exact contaminated shape MEASURED: an initialised store whose key material is gone.
const STALE = path.join(TMP, 'stale-store');
fs.mkdirSync(path.join(STALE, 'records'), { recursive: true });
fs.writeFileSync(path.join(STALE, 'ledger.json'), JSON.stringify({ schema: 'canary-authority-ledger/1', lanes: {} }) + '\n');

check('an UNRELATED stale store does not affect a run with its own fresh store', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-'));
  const r = setup(fixture('unrelated-stale'), fresh);
  assert.equal(r.status, 0, `setup must succeed with a fresh store (exit ${r.status})\n${r.stdout}${r.stderr}`);
});
check('pointing a run AT the damaged store still REFUSES (fail-closed preserved)', () => {
  const r = setup(fixture('points-at-stale'), STALE);
  assert.equal(r.status, 2, `a keyless initialised store must be refused (exit ${r.status})`);
  assert.match(r.stdout, /key material is missing|operator recovery/, r.stdout);
});

console.log('\n=== D. repeated runs give the SAME verdict ===');
check('two consecutive M2+M9 runs agree exactly', () => {
  const run = () => {
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=8',
      'apps/cli/dist/test/m2-claims-not-evidence.test.js', 'apps/cli/dist/test/m9-authority.test.js'],
      { cwd: REPO, encoding: 'utf8', timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
    const nums = ['tests', 'pass', 'fail'].map((k) => {
      const m = new RegExp(`^\\u2139 ${k} (\\d+)$`, 'm').exec(r.stdout ?? '');
      return m === null ? null : Number(m[1]);
    });
    return { status: r.status, nums };
  };
  const a = run(); const b = run();
  assert.deepEqual(a, b, `repeated runs disagreed: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert.equal(a.nums[2], 0, `the suites must be green: ${JSON.stringify(a)}`);
});

console.log('');
if (failures > 0) { console.log(`TRUST-STORE-ISOLATION: FAIL (${failures} check(s) failed)`); process.exit(1); }
console.log('TRUST-STORE-ISOLATION: PASS — isolated stores, an unrelated stale store is inert, a damaged store still refuses, and runs are deterministic.');
process.exit(0);
