/**
 * 1.1 P0 — trust-store WIRING contract: what `setup` seals outside the repo,
 * what `status`/`doctor` report about that sealed copy, and that the report
 * NEVER steers a v1.0 verdict (gate K: outcomes byte-for-byte unchanged; the
 * store line is a fact, not an input). Setup failing to seal fails closed —
 * no config is written. Every CLI child inherits CANARY_TRUST_STORE, so this
 * whole file runs against a throwaway temp store; the real per-user store is
 * never touched by verification traffic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // isolation default (overridden below)

import { ensureStoreKey, openSealed, projectIdForRoot, sealRecord } from '../src/trust-store.js';
import type { CanaryConfig } from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);
const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const fx = (f: string): string => `node "${path.join(FIXTURES, f)}"`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-wire-'));
const STORE_ROOT = path.join(TMP, 'store');
process.env.CANARY_TRUST_STORE = STORE_ROOT;
const store = { root: STORE_ROOT };
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function makeProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // findRepoRoot only needs .git presence
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts: { test: fx('f-pass.js') } }, null, 2));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}
const canary = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
const cfgFile = (root: string): string => path.join(root, '.canary', 'canary.local.json');
const readCfg = (root: string): CanaryConfig => JSON.parse(fs.readFileSync(cfgFile(root), 'utf8')) as CanaryConfig;

describe('1.1 P0 trust-store wiring', () => {
  const sealRoot = makeProject('wire-seal');

  it('setup seals registration + plan-seal outside the repo, matching the config', () => {
    const r = canary(['setup', '--yes'], sealRoot);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const pid = projectIdForRoot(sealRoot);
    const open = openSealed(store, { projectId: pid, kind: 'plan-seal' });
    assert.equal(open.status, 'valid', open.reason);
    assert.deepEqual(open.envelope!.payload, readCfg(sealRoot).planAuthority);
    assert.equal(open.envelope!.seq, 1);
    const reg = openSealed(store, { projectId: pid, kind: 'registration' });
    assert.equal(reg.status, 'valid', reg.reason);
    assert.deepEqual(reg.envelope!.payload, { root: fs.realpathSync(sealRoot), pm: 'npm', adapter: 'node' });
  });

  it('status/doctor report the sealed copy; the verdict stays the v1.0 one', () => {
    const s = canary(['status', '--verbose'], sealRoot);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.match(s.stdout, /sealed copy: store seq 1 matches this config's sealed authority/);
    assert.match(s.stdout, /level LOCAL/);
    const d = canary(['doctor', '--verbose'], sealRoot);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /sealed copy: store seq 1 matches/);
    assert.match(d.stdout, /READY/);
  });

  it('a divergent but validly sealed record reads MISMATCH — and changes no verdict', () => {
    const root = makeProject('wire-mismatch');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    // act as the trusted sealer re-sealing elsewhere with different bytes:
    // validly signed (so not 'forged'), yet no longer matching this config.
    sealRecord(store, { projectId: projectIdForRoot(root), kind: 'plan-seal', canaryVersion: 'test', payload: { planDigest: 'a'.repeat(64), scriptDigests: {} } });
    const s = canary(['status', '--verbose'], root);
    assert.equal(s.status, 0, 'report-only: sealing divergence never flips the v1.0 verdict');
    assert.match(s.stdout, /sealed copy: MISMATCH/);
  });

  it('every setup re-seals (seq advances) and says LOCAL with the honest ceiling words', () => {
    const root = makeProject('wire-reseal');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const r = canary(['setup', '--yes', '--verbose'], root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /sealed authority copy: .*level LOCAL/);
    assert.match(r.stdout, /sealing detects, it does not prevent; HARDENED requires a broker with a different identity and is NOT claimed/);
    const open = openSealed(store, { projectId: projectIdForRoot(root), kind: 'plan-seal' });
    assert.equal(open.status, 'valid', open.reason);
    assert.equal(open.envelope!.seq, 2);
    assert.deepEqual(open.envelope!.payload, readCfg(root).planAuthority);
  });

  it('a store that cannot mint fails setup closed with NO config written', () => {
    const blocker = path.join(TMP, 'blocked');
    fs.writeFileSync(blocker, 'a file where a store directory must go');
    process.env.CANARY_TRUST_STORE = path.join(blocker, 'store');
    try {
      const root = makeProject('wire-noseal');
      const r = canary(['setup', '--yes'], root);
      assert.equal(r.status, 2);
      assert.match(r.stdout, /NEEDS ATTENTION/);
      // v1.4 §E: translated for the everyday path — same refusal, same exit code, and it still names
      // the actionable thing (the store path / CANARY_TRUST_STORE). The raw reason is behind
      // --verbose. The property this test exists for — setup fails CLOSED and writes no config — is
      // asserted on the next line and is unchanged.
      assert.match(r.stdout, /could not store its verification record/);
      assert.match(r.stdout, /CANARY_TRUST_STORE/);
      assert.ok(!fs.existsSync(cfgFile(root)), 'a failed seal must leave no half-wired config');
    } finally {
      process.env.CANARY_TRUST_STORE = STORE_ROOT;
    }
  });

  it('a steered-empty store fails honest-closed in reading — old records cannot follow the pointer', () => {
    const steered = path.join(TMP, 'empty-store');
    process.env.CANARY_TRUST_STORE = steered;
    try {
      // no key at all: nothing can be certified, and the line says so loudly:
      const s = canary(['status', '--verbose'], sealRoot); // config intact, sealed elsewhere
      assert.equal(s.status, 0, s.stdout + s.stderr); // report-only — verdict unchanged
      assert.match(s.stdout, /sealed copy: UNAVAILABLE — the trust store has no verification key/);
      // a key exists but this project was never sealed here: the plain truth:
      ensureStoreKey({ root: steered });
      const s2 = canary(['status', '--verbose'], sealRoot);
      assert.equal(s2.status, 0);
      assert.match(s2.stdout, /sealed copy: none yet/);
    } finally {
      process.env.CANARY_TRUST_STORE = STORE_ROOT;
    }
  });
});
