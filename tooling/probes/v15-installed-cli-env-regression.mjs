#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installedCliEnvironment } from './v15-installed-cli-env.mjs';
const [cli, out] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok([cli, out].every(p => p && path.isAbsolute(p)) && !fs.existsSync(out));
const env = installedCliEnvironment(cli, process.env);
assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
const bin = env.PATH.split(path.delimiter)[0], rows = [];
fs.mkdirSync(out, { recursive: true });
for (const [name, executable, args, expected] of [
  ['cmd', 'C:/Windows/System32/where.exe', ['canary'], path.join(bin, 'canary.cmd')],
  ['bash', 'C:/Program Files/Git/bin/bash.exe', ['--noprofile', '--norc', path.resolve(import.meta.dirname, '../test-support/fixtures/pilot-cli-resolution.sh')], path.join(bin, 'canary')],
]) {
  const r = spawnSync(executable, args, { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  fs.writeFileSync(path.join(out, name + '.stdout.log'), r.stdout ?? '');
  fs.writeFileSync(path.join(out, name + '.stderr.log'), r.stderr ?? '');
  assert.equal(r.error, undefined); assert.equal(r.status, 0);
  const found = r.stdout.trim().split(/\r?\n/).filter(line => line.toLowerCase().endsWith(path.extname(expected)))[0];
  assert.equal(fs.realpathSync.native(found), fs.realpathSync.native(expected));
  rows.push({ name, executable, args, status: r.status, found });
  console.log(`PASS ${name}: resolves the explicitly installed package`);
}
assert.throws(() => installedCliEnvironment(import.meta.filename, process.env));
console.log('PASS a development file cannot silently fall back to global Canary');
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ rows, cli, cliSha256: crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),
  instrumentSha256: crypto.createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex') }, null, 2));
