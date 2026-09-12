/**
 * The instrument fingerprint's tests.
 *
 * The point of the fingerprint is attribution: every result must say which instrument produced
 * it, and it must CHANGE when the instrument changes. A fingerprint that is stable across an
 * edit would silently attribute old data to a new instrument.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { instrumentFiles, instrumentFingerprint } from './fingerprint.mjs';

const BENCH = path.resolve(import.meta.dirname);

describe('instrument fingerprint', () => {
  it('is stable across calls in one process', () => {
    const a = instrumentFingerprint();
    const b = instrumentFingerprint();
    assert.equal(a.version, b.version);
    assert.equal(a.hash, b.hash);
    assert.ok(a.files > 5, `expected the harness modules in the fingerprint, got ${a.files}`);
  });

  it('covers the modules that decide a verdict AND every fixture', () => {
    const files = instrumentFiles().map((f) => path.relative(BENCH, f).split(path.sep).join('/'));
    for (const required of ['run-trial.mjs', 'bench.mjs', 'classify-claim.mjs', 'verdict.mjs']) {
      assert.ok(files.includes(required), `${required} must be part of the instrument fingerprint`);
    }
    assert.ok(files.some((f) => f.startsWith('fixtures/bug-sum/project/')), 'fixture project files must be covered');
    assert.ok(files.some((f) => f.startsWith('fixtures/bug-sum/hidden/')), 'hidden oracles must be covered');
    assert.ok(files.some((f) => f === 'fixtures/bug-sum/TASK.md'), 'the task text must be covered');
    assert.ok(files.some((f) => f === 'fixtures/bug-sum/fixture.json'), 'fixture metadata must be covered');
  });

  it('excludes the instrument OUTPUT, so running a trial does not change the version', () => {
    const files = instrumentFiles().map((f) => path.relative(BENCH, f).split(path.sep).join('/'));
    assert.equal(files.some((f) => f.startsWith('results/')), false, 'results must not be part of the instrument');
    assert.equal(files.some((f) => f.startsWith('scratch/')), false, 'scratch must not be part of the instrument');
  });

  it('CHANGES when a harness file changes (the property that makes attribution honest)', () => {
    // A miniature harness in a temp dir, so the real one is not touched.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fingerprint-'));
    try {
      fs.writeFileSync(path.join(dir, 'run-trial.mjs'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(dir, 'classify-claim.mjs'), 'export const b = 2;\n');
      fs.mkdirSync(path.join(dir, 'results'));
      fs.writeFileSync(path.join(dir, 'results', 'old.json'), '{"ignored":true}\n');
      const first = instrumentFingerprint(dir);
      assert.equal(first.files, 2, 'only the harness modules count');

      fs.writeFileSync(path.join(dir, 'results', 'new.json'), '{"ignored":true}\n');
      assert.equal(instrumentFingerprint(dir).version, first.version, 'writing results must not change the version');

      fs.writeFileSync(path.join(dir, 'classify-claim.mjs'), 'export const b = 3;\n');
      assert.notEqual(instrumentFingerprint(dir).version, first.version, 'editing a classifier MUST change the version');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
