import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { authorityJson, ensureStoreKey, openSealed, sealRecord, verifySeal } from '../src/trust-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-store-attacks-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const want = { projectId: 'project', kind: 'state' };
function fixture() {
  const store = { root: path.join(tmp, String(n++)) };
  const input = { ...want, payload: { allowed: false }, canaryVersion: 'test' };
  const first = sealRecord(store, input);
  return { store, input, first, record: path.join(store.root, 'records', 'project', 'state.json'), ledger: path.join(store.root, 'ledger.json') };
}
for (const attack of ['missing', 'invalid-json', 'empty', 'negative', 'future'] as const) {
  test(`lost/corrupt ledger (${attack}) cannot accept or re-seal history`, () => {
    const f = fixture();
    if (attack === 'missing') fs.unlinkSync(f.ledger);
    else fs.writeFileSync(f.ledger, ({ 'invalid-json': '{', empty: '{}', negative: '{"project/state":-1}', future: '{"project/state":2}' })[attack]);
    assert.notEqual(openSealed(f.store, want).status, 'valid');
    assert.throws(() => sealRecord(f.store, f.input));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.record, 'utf8')), f.first);
  });
}
test('all JSON keys, including __proto__, are signed', () => {
  const f = fixture();
  const env = sealRecord(f.store, { ...f.input, payload: JSON.parse('{"__proto__":{"allow":false}}') });
  const pub = ensureStoreKey(f.store).publicKey;
  assert(verifySeal(env, pub));
  (env.payload as Record<string, { allow: boolean }>).__proto__!.allow = true;
  assert.equal(verifySeal(env, pub), false);
});
test('non-JSON and ambiguous values are refused, without invoking getters', () => {
  let invoked = false;
  for (const value of [undefined, NaN, Infinity, { x: undefined }, new Date(), Array(1), { get x() { invoked = true; return 1; } }]) assert.throws(() => authorityJson(value));
  assert.equal(invoked, false);
  assert.equal(authorityJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
});
test('CAS rejects stale writers without overwriting accepted state', () => {
  const f = fixture();
  const next = sealRecord(f.store, f.input, 1);
  assert.equal(next.seq, 2);
  assert.throws(() => sealRecord(f.store, f.input, 1), /compare-and-swap/);
  assert.deepEqual(openSealed(f.store, want).envelope, next);
});
test('a held writer lock is not stolen or removed', () => {
  const f = fixture(), lock = path.join(f.store.root, '.authority-lock');
  fs.mkdirSync(lock);
  assert.throws(() => sealRecord(f.store, f.input));
  assert(fs.statSync(lock).isDirectory());
  fs.rmdirSync(lock);
});
test('missing or mismatched keypairs cannot silently create a new issuer', () => {
  const f = fixture(), key = path.join(f.store.root, 'keys', 'ed25519');
  fs.writeFileSync(`${key}.pub`, crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => sealRecord(f.store, f.input), /does not match/);
  fs.unlinkSync(key); fs.unlinkSync(`${key}.pub`);
  assert.throws(() => sealRecord(f.store, f.input), /missing/);
});
test('hardlinked authority files and directory junctions are refused', () => {
  const f = fixture(), alias = path.join(tmp, 'record-alias');
  fs.linkSync(f.record, alias);
  assert.notEqual(openSealed(f.store, want).status, 'valid');
  fs.unlinkSync(alias);
  const link = path.join(tmp, 'store-alias');
  fs.symlinkSync(f.store.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => sealRecord({ root: link }, f.input), /linked/);
});
test('Windows device/trailing-dot aliases are refused on every platform', () => {
  const f = fixture();
  for (const projectId of ['con', 'NUL.txt', 'com1', 'project.']) assert.throws(() => sealRecord(f.store, { ...f.input, projectId }), /safe identifier/);
});
test('same-UID full-store replacement remains LOCAL, never mistaken for forgery protection', () => {
  const f = fixture(), attacker = fixture();
  const forged = sealRecord(attacker.store, { ...attacker.input, payload: { allowed: true } });
  fs.cpSync(attacker.store.root, f.store.root, { recursive: true });
  assert.deepEqual(openSealed(f.store, want).envelope, forged); // explicit ceiling witness
});
