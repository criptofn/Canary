import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ALL_CONTROLS, CONFINED_RECORD_NAME, CONFINED_RECORD_SCHEMA, CONFINED_RECORD_SOURCE,
  DEFAULT_MAX_AGE_MS, readConfinedMeasurement, writeConfinedMeasurement, toolsDigest,
  type ConfinedMeasurementRecord } from '../src/provider/confined-measurement.js';

// Validator counterexamples, not isolation observations. A deliberately known
// attacker key models the earlier disclosure; a signature must not bless prose.
function withRecord(mutate: (record: ConfinedMeasurementRecord) => void, expected: RegExp): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-repair-regression-'));
  try {
    fs.writeFileSync(path.join(root, 'custody-key-material.txt'), 'attacker-knows-the-old-key');
    const record = {
      schema: CONFINED_RECORD_SCHEMA, source: CONFINED_RECORD_SOURCE, platform: process.platform,
      measuredAt: new Date().toISOString(), host: { hostname: os.hostname(), user: os.userInfo().username },
      storeRoot: root, callerPackage: 'S-1-15-2-1', tools: { digest: toolsDigest(), files: [] },
      battery: { pass: 1, fail: 0, inconclusive: 0, durationMs: 1 },
      deployment: { complete: true, failures: [], facts: { required: {} } },
      controls: ALL_CONTROLS.map(control => ({ control, subject: 'claim', positiveControl: 'claim',
        attack: 'claim', denial: 'claim', available: true, observed: { unrelatedField: true } })), signature: '',
    } as unknown as ConfinedMeasurementRecord;
    mutate(record);
    writeConfinedMeasurement(record, root);
    const state = readConfinedMeasurement(root);
    assert.equal(state.valid, false);
    assert.match(state.reason, expected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('signed zero-attack record is refused', () => withRecord(r => { r.battery.pass = 0; }, /battery/));
test('signed future evidence is refused', () => withRecord(r => { r.measuredAt = '2099-01-01T00:00:00Z'; }, /future/));
test('signed failed evidence is refused', () => withRecord(r => { r.battery.fail = 1; }, /battery/));
test('signed inconclusive evidence is refused', () => withRecord(r => { r.battery.inconclusive = 1; }, /battery/));
test('complete flag cannot override deployment failures', () => withRecord(r => { r.deployment.failures = ['failed']; }, /battery/));
test('signed malformed observations refuse without throwing', () => withRecord(r => {
  r.controls[0]!.positiveControl = 7 as unknown as string;
}, /malformed/));
test('host user is checked independently from host name', () => withRecord(r => { r.host.user = 'different-user'; }, /host\/user/));
test('arbitrary claims cannot activate custody', () => withRecord(() => {}, /required fact|observation/));
test('non-finite or enlarged freshness limit cannot disable expiry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-repair-age-'));
  try {
    fs.writeFileSync(path.join(root, CONFINED_RECORD_NAME), JSON.stringify({ schema: CONFINED_RECORD_SCHEMA,
      source: CONFINED_RECORD_SOURCE, platform: process.platform, measuredAt: new Date().toISOString(),
      signature: '', storeRoot: root, callerPackage: '', controls: [] }));
    for (const maxAgeMs of [Infinity, NaN, -1, DEFAULT_MAX_AGE_MS + 1]) {
      const result = readConfinedMeasurement(root, { maxAgeMs });
      assert.equal(result.valid, false);
      assert.match(result.reason, /freshness/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
