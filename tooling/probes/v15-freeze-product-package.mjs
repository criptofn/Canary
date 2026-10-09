#!/usr/bin/env node
/** Freeze an already-built clean source commit as an explicitly installed package. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const index = process.argv.indexOf('--out'), out = process.argv[index + 1];
assert.ok(index > 0 && out && path.isAbsolute(out) && !fs.existsSync(out), 'new absolute --out required');
const root = path.resolve(import.meta.dirname, '../..');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(out, { recursive: true });
const commands = []; let failure = null, artifact = null;
function run(name, exe, args, cwd = root) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, `${name}.out.log`), result.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(out, `${name}.err.log`), result.stderr ?? '', { flag: 'wx' });
  commands.push({ name, exe, args, cwd, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message ?? null });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, `${name}: see saved logs`);
  return result.stdout.trim();
}
try {
  assert.equal(run('source-status', 'git', ['status', '--porcelain']), '', 'commit changes before freezing');
  const sourceCommit = run('source-commit', 'git', ['rev-parse', 'HEAD']);
  run('dist-tripwire', process.execPath, [path.join(root, 'tooling/probes/v12-dist-tripwire.mjs')]);
  run('pack', process.execPath, [path.join(root, 'tooling/pack.mjs')]);
  const archive = path.join(out, 'final.tgz');
  fs.copyFileSync(path.join(root, 'pack/npm/canary-rn-cli-1.5.0.tgz'), archive, fs.constants.COPYFILE_EXCL);
  const installed = path.join(out, 'installed'); fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, 'package.json'), '{"name":"canary-product-validation-install","private":true}\n', { flag: 'wx' });
  run('install', process.execPath, [npm, 'install', '--prefix', installed, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], installed);
  const cli = path.join(installed, 'node_modules/@canary-rn/cli/dist/main.js');
  const version = run('version', process.execPath, [cli, '--version'], installed);
  assert.equal(version, 'canary 1.5.0');
  artifact = { sourceCommit, package: archive, packageSha256: hash(archive), cli, cliSha256: hash(cli), version };
  console.log(`PASS frozen package: ${artifact.packageSha256}; CLI ${artifact.cliSha256}`);
} catch (error) { failure = error.stack ?? String(error); console.error(failure); }
finally {
  fs.copyFileSync(import.meta.filename, path.join(out, 'instrument.mjs'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify({ status: failure ? 'incomplete' : 'complete', artifact, failure, commands,
    instrumentSha256: hash(import.meta.filename), node: process.version }, null, 2)}\n`, { flag: 'wx' });
  process.exitCode = failure ? 1 : 0;
}
