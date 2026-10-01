#!/usr/bin/env node
/** Remove owned pilot copies only after their complete native/source archives verify. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (key) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? null : process.argv[i + 1]; };
const source = arg('source'), evidence = arg('evidence'), archive = arg('archive');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const contained = (root, file) => {
  const relative = path.relative(root, file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'path must stay within its owner');
};
for (const value of [source, evidence, archive]) assert.ok(value && path.isAbsolute(value), 'absolute source/evidence/archive required');
assert.match(path.basename(source), /^canary-native-final-(?:H[1235]|R1|S1)-\d{8}$/);
const temp = fs.realpathSync.native(os.tmpdir());
assert.equal(fs.realpathSync.native(source), path.join(temp, path.basename(source)), 'only a direct owned OS-temp directory may be removed');
for (const directory of [evidence, archive]) {
  const relative = path.relative(source, fs.realpathSync.native(directory));
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'archive must survive source removal');
}
const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
const summary = read(evidence, 'summary.json');
const preparation = read(archive, 'preparation-summary.json');
assert.equal(summary.status, 'complete');
assert.equal(summary.failure, null);
assert.equal(summary.cleanup?.serverStopped, true);
assert.equal(summary.cleanup?.unloaded, true);
assert.equal(path.resolve(summary.preparedRoot), path.resolve(source));
assert.equal(path.resolve(preparation.outRoot), path.resolve(source));
assert.deepEqual(preparation, read(source, 'preparation-summary.json'));
assert.deepEqual(preparation, read(evidence, 'preparation-summary.json'));
assert.equal(summary.sessions.length, preparation.records.length);
let verified = 0;
for (const directory of [evidence, archive]) {
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [, digest, relative] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
    assert.ok(digest && relative);
    const file = path.resolve(directory, relative);
    contained(directory, file);
    assert.equal(hash(fs.readFileSync(file)), digest, `archive changed: ${relative}`);
    verified++;
  }
}
const stores = new Set();
for (const record of preparation.records) {
  contained(source, record.repo);
  const session = summary.sessions.find((item) => item.cwd === record.repo);
  assert.ok(session?.captureComplete, 'every workspace must have a complete captured session');
  assert.ok(fs.statSync(path.join(archive, session.name, 'baseline-to-worker.diff')).isFile());
  const store = path.join(os.tmpdir(), 'canary-v15-validation-trust', hash(record.repo));
  if (fs.existsSync(store)) {
    const parent = path.join(temp, 'canary-v15-validation-trust');
    assert.equal(fs.realpathSync.native(path.dirname(store)), parent);
    assert.equal(fs.realpathSync.native(store), path.join(parent, path.basename(store)));
    stores.add(store);
  }
}
// All targets and archives have been checked before the first filesystem mutation.
for (const store of stores) fs.rmSync(store, { recursive: true });
fs.rmSync(source, { recursive: true });
console.log(`PASS cleaned owned pilot and ${stores.size} trust directories after verifying ${verified} archived files`);
