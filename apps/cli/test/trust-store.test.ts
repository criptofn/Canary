/**
 * 1.1 P0 — the trusted authority store must seal honestly and fail closed
 * under every forging route: altered bytes, foreign keys, moved files,
 * replayed records, unsafe ids, unreadable stores. None of these may ever
 * read as 'valid', and the level probe may never report more than it tests.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as store from '../src/trust-store.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const freshStore = (): store.TrustStore => ({ root: path.join(TMP, `store-${n++}`) });
const sealTest = (s: store.TrustStore, kind = 'registration', payload: unknown = { root: '/x' }) =>
  store.sealRecord(s, { projectId: 'proj-a', kind, payload, canaryVersion: 'test' });
const recordFile = (s: store.TrustStore, projectId: string, kind: string): string =>
  path.join(s.root, 'records', projectId, `${kind}.json`);

describe('seal/verify roundtrip', () => {
  it('a sealed record opens as valid and binds its identity', () => {
    const s = freshStore();
    const env = sealTest(s, 'plan-seal', { plan: [{ kind: 'tests', script: 'test' }] });
    assert.equal(env.schema, store.RECORD_SCHEMA);
    assert.equal(env.projectId, 'proj-a');
    assert.equal(env.seq, 1);
    assert.equal(env.canaryVersion, 'test');
    const opened = store.openSealed(s, { projectId: 'proj-a', kind: 'plan-seal' });
    assert.equal(opened.status, 'valid', opened.reason);
    assert.deepEqual(opened.envelope, env);
  });
  it('the public key alone verifies — minting needs the private half', () => {
    const s = freshStore();
    const env = sealTest(s);
    const { publicKey } = store.ensureStoreKey(s);
    assert.equal(store.verifySeal(env, publicKey), true);
    const attacker = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(store.verifySeal(env, attacker as string), false);
  });
});

describe('forging routes all fail closed', () => {
  it('payload bytes edited after sealing → forged', () => {
    const s = freshStore();
    sealTest(s, 'registration', { root: '/x' });
    const file = recordFile(s, 'proj-a', 'registration');
    const env = JSON.parse(fs.readFileSync(file, 'utf8'));
    env.payload.root = '/evil';
    fs.writeFileSync(file, JSON.stringify(env));
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'forged');
  });
  it('a record re-signed by an attacker key → forged', () => {
    const s = freshStore();
    sealTest(s);
    const file = recordFile(s, 'proj-a', 'registration');
    const env = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { signature: _drop, ...body } = env;
    const attacker = crypto.generateKeyPairSync('ed25519').privateKey;
    env.signature = crypto.sign(null, store.signedBytes(body as never), attacker).toString('base64');
    fs.writeFileSync(file, JSON.stringify(env));
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'forged');
  });
  it('copying a valid record onto another project shelf → mismatch', () => {
    const s = freshStore();
    sealTest(s);
    fs.mkdirSync(path.dirname(recordFile(s, 'proj-b', 'registration')), { recursive: true });
    fs.copyFileSync(recordFile(s, 'proj-a', 'registration'), recordFile(s, 'proj-b', 'registration'));
    const opened = store.openSealed(s, { projectId: 'proj-b', kind: 'registration' });
    assert.equal(opened.status, 'mismatch');
    assert.match(opened.reason, /moved file re-binds nothing/);
  });
  it('replaying an older seq after a newer seal → stale', () => {
    const s = freshStore();
    const first = sealTest(s, 'plan-seal', { v: 1 });
    sealTest(s, 'plan-seal', { v: 2 });
    fs.writeFileSync(recordFile(s, 'proj-a', 'plan-seal'), JSON.stringify(first)); // sig still valid
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'plan-seal' }).status, 'stale');
  });
  it('corrupt shapes and foreign schemas → malformed; absent record → missing', () => {
    const s = freshStore();
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'unavailable'); // no key yet
    sealTest(s);
    const file = recordFile(s, 'proj-a', 'registration');
    fs.writeFileSync(file, '{ not json');
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'malformed');
    fs.writeFileSync(file, JSON.stringify({ nope: true }));
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'malformed');
    fs.writeFileSync(file, JSON.stringify(store.sealRecord(freshStore(), { projectId: 'proj-x', kind: 'reg-x', payload: {}, canaryVersion: 'test' })));
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'forged'); // foreign key, valid shape
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schema: 'canary-authority/0' }));
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'malformed');
    fs.rmSync(file);
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: 'registration' }).status, 'missing');
  });
  it('path-ish ids and kinds are refused, never resolved', () => {
    const s = freshStore();
    assert.throws(() => store.sealRecord(s, { projectId: '../evil', kind: 'registration', payload: {}, canaryVersion: 'test' }), /not a safe identifier/);
    assert.equal(store.openSealed(s, { projectId: 'a/b', kind: 'registration' }).status, 'malformed');
    assert.equal(store.openSealed(s, { projectId: 'proj-a', kind: '..' }).status, 'malformed');
  });
  it('a half-written keypair refuses service instead of orphaning records', () => {
    const s = freshStore();
    sealTest(s);
    fs.rmSync(path.join(s.root, 'keys', 'ed25519')); // private half gone
    assert.throws(() => store.ensureStoreKey(s), /key material is incomplete/);
  });
});

describe('the level probe measures, it never inflates', () => {
  it('a writable store reads LOCAL with the same-uid ceiling named', () => {
    const probe = store.probeTrustLevel(freshStore());
    assert.equal(probe.level, 'LOCAL');
    assert(probe.reasons.some((r) => /same uid/.test(r)), probe.reasons.join(' | '));
    assert(probe.reasons.some((r) => /HARDENED/.test(r) && /NOT claimed/.test(r)), probe.reasons.join(' | '));
  });
  it('an unwritable store reads UNSUPPORTED (fails closed, not quieter)', () => {
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'x'); // a FILE where a dir must be: every platform refuses this
    const probe = store.probeTrustLevel({ root: path.join(blocker, 'nested', 'trust') });
    assert.equal(probe.level, 'UNSUPPORTED');
    assert.match(probe.reasons.join(' '), /fail closed/);
  });
  it('default store root is the platform convention under the OS home', () => {
    const root = store.defaultStoreRoot(path.join(TMP, 'home'));
    assert.ok(root.startsWith(path.join(TMP, 'home')), root);
    assert.match(root, /canary/);
    assert.equal(root.includes('.git'), false);
    if (process.platform === 'win32') assert.ok(root.endsWith(path.join('AppData', 'Local', 'canary', 'trust')), root);
    else assert.ok(root.endsWith(path.join('.local', 'share', 'canary', 'trust')), root);
  });
});
