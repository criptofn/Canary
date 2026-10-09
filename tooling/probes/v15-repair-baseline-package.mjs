#!/usr/bin/env node
/** Reconstruct the exact pre-plan commit without building or changing the active checkout. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const i = process.argv.indexOf('--out'), out = process.argv[i + 1];
assert.ok(i > 0 && out && path.isAbsolute(out) && !fs.existsSync(out), 'new absolute --out required');
const root = path.resolve(import.meta.dirname, '../..');
const ref = '2171535496f4fda3af060c03449e6b1a65b6380f';
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-repair-baseline-build-'));
const source = path.join(temp, 'source');
fs.mkdirSync(source); fs.mkdirSync(out, { recursive: true });
const commands = [];
let failure = null, artifact = null;
function run(name, executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true,
    timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, `${name}.out.log`), result.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(out, `${name}.err.log`), result.stderr ?? '', { flag: 'wx' });
  commands.push({ name, executable, args, cwd, exitCode: result.status, error: result.error?.message ?? null });
  assert.equal(result.error, undefined, `${name}: process failed`);
  assert.equal(result.status, 0, `${name}: see raw logs`);
  console.log(`PASS ${name}`);
  return result.stdout ?? '';
}
try {
  assert.equal(run('source-commit', 'git', ['rev-parse', `${ref}^{commit}`], root).trim(), ref);
  run('source-archive', 'git', ['archive', '--format=tar', `--output=${path.join(temp, 'source.tar')}`, ref], root);
  run('source-extract', 'tar', ['-xf', path.join(temp, 'source.tar'), '-C', source], temp);
  run('dependencies', process.execPath, [npm, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  run('build', process.execPath, [npm, 'run', 'build:force'], source);
  run('pack', process.execPath, [path.join(source, 'tooling/pack.mjs')], source);
  const archive = path.join(out, 'baseline.tgz');
  fs.copyFileSync(path.join(source, 'pack/npm/canary-rn-cli-1.5.0.tgz'), archive, fs.constants.COPYFILE_EXCL);
  const installed = path.join(out, 'installed'); fs.mkdirSync(installed);
  // Own manifest + explicit prefix stop npm anchoring at an ancestor workspace.
  fs.writeFileSync(path.join(installed, 'package.json'), '{"name":"canary-repair-baseline-install","private":true}\n', { flag: 'wx' });
  run('install', process.execPath, [npm, 'install', '--prefix', installed, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], installed);
  const cli = path.join(installed, 'node_modules/@canary-rn/cli/dist/main.js');
  const version = run('version', process.execPath, [cli, '--version'], installed).trim();
  assert.equal(version, 'canary 1.5.0');
  artifact = { sourceCommit: ref, package: archive, packageSha256: hash(archive), cli, cliSha256: hash(cli), version };
} catch (error) { failure = error.stack ?? String(error); console.error(failure); }
finally {
  fs.copyFileSync(import.meta.filename, path.join(out, 'instrument.mjs'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify({ sourceCommit: ref, node: process.version,
    instrumentSha256: hash(import.meta.filename), commands, artifact, failure, status: failure ? 'incomplete' : 'complete',
    scope: 'Rebuilt historical comparison package only; the active product and native pilot artifact were not rebuilt.' }, null, 2)}\n`, { flag: 'wx' });
  assert.equal(fs.realpathSync.native(temp), path.join(fs.realpathSync.native(os.tmpdir()), path.basename(temp)));
  fs.rmSync(temp, { recursive: true });
  process.exitCode = failure ? 1 : 0;
}
