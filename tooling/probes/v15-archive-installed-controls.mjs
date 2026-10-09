#!/usr/bin/env node
/** Preserve completed installed-toolchain controls before removing owned fixtures. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [root] = process.argv.slice(2);
assert.ok(root && path.isAbsolute(root));
assert.ok(!fs.existsSync(path.join(root, 'export-manifest.json')));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [], sources = [], controls = [];
function walk(directory, prefix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink());
    const target = path.join(directory, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) walk(target, relative);
    else if (entry.isFile()) files.push({ path: relative.replaceAll('\\', '/'), sha256: sha(fs.readFileSync(target)) });
  }
}
for (const arm of ['before', 'after']) {
  assert.equal(fs.readFileSync(path.join(root, `toolchain-${arm}.exit.txt`), 'utf8').trim(), '0');
  const log = fs.readFileSync(path.join(root, `toolchain-${arm}.log`), 'utf8');
  assert.ok(log.includes('SEALED-TOOLCHAIN PROBE PASSED')); assert.ok(!/^FAIL /m.test(log));
  const source = /^artifacts: (.+)$/m.exec(log)?.[1].trim(); assert.ok(source && path.isAbsolute(source));
  assert.match(path.basename(source), /^canary-v15-sealed-toolchain-[A-Za-z0-9]+$/);
  assert.equal(fs.realpathSync.native(source), path.join(fs.realpathSync.native(os.tmpdir()), path.basename(source)));
  const target = path.join(root, `toolchain-${arm}-artifacts`);
  assert.ok(!fs.existsSync(target));
  // Reject links before copying and check every destination byte against its source.
  const sourceFiles = []; const offset = files.length; walk(source, `toolchain-${arm}-artifacts`);
  sourceFiles.push(...files.splice(offset));
  fs.cpSync(source, target, { recursive: true, errorOnExist: true });
  for (const file of sourceFiles) assert.equal(sha(fs.readFileSync(path.join(root, file.path))), file.sha256);
  sources.push(source); controls.push({ arm, passLines: log.match(/^PASS /gm)?.length ?? 0 });
}
assert.equal(fs.readFileSync(path.join(root, 'focused-onboarding-after.exit.txt'), 'utf8').trim(), '0');
const unit = fs.readFileSync(path.join(root, 'focused-onboarding-after.log'), 'utf8');
assert.match(unit, /tests 5/); assert.match(unit, /pass 5/); assert.match(unit, /fail 0/);
const instrumentDir = path.join(root, 'instruments'); fs.mkdirSync(instrumentDir);
for (const file of ['v15-sealed-toolchain.mjs', 'v15-archive-installed-controls.mjs']) fs.copyFileSync(path.join(import.meta.dirname, file), path.join(instrumentDir, file), fs.constants.COPYFILE_EXCL);
walk(root, '');
fs.writeFileSync(path.join(root, 'export-manifest.json'), `${JSON.stringify({ status: 'complete', archivedAt: new Date().toISOString(), controls,
  installedOnboardingTests: { tests: 5, passed: 5, failed: 0 }, sources, files }, null, 2)}\n`, { flag: 'wx' });
for (const source of sources) fs.rmSync(source, { recursive: true });
console.log(`PASS installed controls: ${controls.map((row) => `${row.arm} ${row.passLines} PASS lines`).join(', ')}, 5/5 focused tests; ${files.length} archived files; owned fixtures cleaned`);
