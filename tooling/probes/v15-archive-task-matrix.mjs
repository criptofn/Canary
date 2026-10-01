#!/usr/bin/env node
/** Preserve matrix raw evidence outside temporary project copies. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cleanup = process.argv[2] === '--cleanup';
const [sourceArg, outArg] = process.argv.slice(cleanup ? 3 : 2);
assert.ok(sourceArg && outArg && path.isAbsolute(sourceArg) && path.isAbsolute(outArg), 'provide absolute source and new destination');
const source = path.resolve(sourceArg);
const out = path.resolve(outArg);
const relation = path.relative(source, out);
assert.ok(relation && (relation.startsWith('..') || path.isAbsolute(relation)), 'destination must be outside source');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
if (cleanup) {
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'export-manifest.json'), 'utf8'));
  assert.equal(path.resolve(manifest.source), source);
  assert.equal(manifest.captureStatus, 'complete');
  assert.match(path.basename(source), /^canary-(?:(?:release|improved)-six-task|installed-matrix)-/);
  assert.equal(fs.realpathSync.native(source), path.join(fs.realpathSync.native(os.tmpdir()), path.basename(source)),
    'only a direct owned OS-temp directory may be removed');
  const stores = new Set();
  for (const file of manifest.files) {
    const target = path.join(out, file.path);
    const relative = path.relative(out, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const bytes = fs.readFileSync(target);
    assert.equal(sha(bytes), file.sha256, `archive changed: ${file.path}`);
    if (file.path.endsWith('/attempt-result.json')) {
      const attempt = JSON.parse(bytes.toString('utf8'));
      if (attempt.trustStore) {
        const repoRelative = path.relative(source, attempt.repo);
        assert.ok(repoRelative && !repoRelative.startsWith('..') && !path.isAbsolute(repoRelative));
        const expected = path.join(os.tmpdir(), 'canary-v15-validation-trust', sha(attempt.repo));
        assert.equal(path.resolve(attempt.trustStore), expected);
        if (fs.existsSync(expected)) {
          assert.equal(fs.realpathSync.native(path.dirname(expected)), path.join(fs.realpathSync.native(os.tmpdir()), 'canary-v15-validation-trust'));
          assert.equal(fs.realpathSync.native(expected), path.join(fs.realpathSync.native(path.dirname(expected)), path.basename(expected)));
          stores.add(expected);
        }
      }
    }
  }
  for (const store of stores) fs.rmSync(store, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true });
  console.log(`PASS cleaned owned matrix and ${stores.size} trust directories after verifying ${manifest.files.length} archived files`);
  process.exit(0);
}
assert.ok(!fs.existsSync(out), 'destination already exists');
const summary = JSON.parse(fs.readFileSync(path.join(source, 'summary.json'), 'utf8'));
const copied = [];
fs.mkdirSync(out, { recursive: true });
function copy(file, relative) {
  const bytes = fs.readFileSync(file);
  const target = path.join(out, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  const digest = sha(bytes);
  assert.equal(sha(fs.readFileSync(target)), digest, `copy differs: ${relative}`);
  copied.push({ source: file, path: relative.replaceAll('\\', '/'), sha256: digest, bytes: bytes.length });
}
function walk(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (file === path.join(source, 'prepared/projects')) continue;
    assert.ok(!entry.isSymbolicLink(), `refused evidence link: ${file}`);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) walk(file, relative);
    else if (entry.isFile()) copy(file, relative);
  }
}
walk(source);
for (const instrument of summary.instruments) {
  assert.equal(sha(fs.readFileSync(path.join(out, 'instruments', path.basename(instrument.file)))), instrument.sha256,
    `instrument snapshot differs: ${instrument.file}`);
}
for (const label of ['H1', 'H2', 'H3', 'H5', 'R1', 'S1']) {
  const evidence = path.join(source, 'prepared/projects', label, 'canary/.canary/evidence');
  if (fs.existsSync(evidence)) walk(evidence, path.join('product-evidence', label));
}
for (const input of summary.solutions) {
  assert.equal(sha(fs.readFileSync(input.file)), input.sha256, `input changed since measurement: ${input.file}`);
  copy(input.file, path.join('inputs', `${input.label}.diff`));
}
const preparation = path.join(source, 'solutions/H2/attempt-result.json');
if (fs.existsSync(preparation)) {
  const h2 = JSON.parse(fs.readFileSync(preparation, 'utf8'));
  copy(h2.operation.sourcePath, 'inputs/H2-original-agent.diff');
  // The preparation records its UTF-8 decoded text hash; retain raw bytes separately.
  assert.equal(sha(fs.readFileSync(h2.operation.sourcePath, 'utf8')), h2.candidateSourceSha256);
}
copy(fileURLToPath(import.meta.url), 'instruments/v15-archive-task-matrix.mjs');
fs.writeFileSync(path.join(out, 'export-manifest.json'), `${JSON.stringify({
  source, exportedAt: new Date().toISOString(), captureStatus: summary.status,
  excludes: ['mutable prepared/projects (product output bundles preserved separately)'], files: copied,
}, null, 2)}\n`, { flag: 'wx' });
console.log(`PASS exported ${copied.length} byte-verified evidence files; capture=${summary.status}`);
