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

import { instrumentFiles, instrumentFingerprint, productFiles } from './fingerprint.mjs';

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

  it('excludes the benchmark DOCS but keeps fixture task text (documentation is not the instrument)', () => {
    const files = instrumentFiles().map((f) => path.relative(BENCH, f).split(path.sep).join('/'));
    // Writing up a finished matrix must not move the version of a batch that is still running …
    assert.equal(files.some((f) => f === 'RESULTS.md'), false, 'the results narrative is documentation');
    assert.equal(files.some((f) => f === 'BENCHMARKS.md'), false, 'the method narrative is documentation');
    // … while the task text the MODEL reads is instrument, wherever it lives.
    assert.ok(files.some((f) => f === 'fixtures/bug-sum/TASK.md'), 'fixture task text must stay in the fingerprint');
  });

  it('covers the PRODUCT the trials actually execute (the built CLI)', () => {
    // Trials run `canary` from `apps/cli/dist`, so a rebuild changes what was measured. The gap was
    // found by planning a rebuild during a running batch and being unable to tell from the record.
    const p = instrumentFingerprint().product;
    assert.notEqual(p, null, 'the real repository has a built CLI to fingerprint');
    assert.ok(p.files > 20, `expected the built CLI modules to be covered, got ${p.files}`);
    assert.ok(productFiles().length === p.files);
  });

  it('moves the version when the PRODUCT changes, and not when docs do', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fingerprint-product-'));
    try {
      const bench = path.join(root, 'tooling', 'benchmark');
      const dist = path.join(root, 'apps', 'cli', 'dist', 'src');
      fs.mkdirSync(bench, { recursive: true });
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(bench, 'run-trial.mjs'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(bench, 'RESULTS.md'), 'narrative, version one\n');
      fs.writeFileSync(path.join(dist, 'main.js'), 'console.log("product one");\n');

      const first = instrumentFingerprint(bench);
      assert.equal(first.files, 1, 'only the harness module counts in `files`');
      assert.equal(first.product.files, 1, 'the built CLI is counted separately');

      fs.writeFileSync(path.join(bench, 'RESULTS.md'), 'narrative, rewritten\n');
      assert.equal(instrumentFingerprint(bench).version, first.version, 'rewriting the narrative must NOT move the version');

      fs.writeFileSync(path.join(dist, 'main.js'), 'console.log("product two");\n');
      assert.notEqual(instrumentFingerprint(bench).version, first.version, 'rebuilding the CLI MUST move the version');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
