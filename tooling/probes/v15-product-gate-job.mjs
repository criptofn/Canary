#!/usr/bin/env node
// Durable capture of the existing required gate; no gate, budget or assertion changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const out = process.argv[2];
assert.ok(out && path.isAbsolute(out) && !fs.existsSync(out), 'new absolute output directory required');
const root = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(out, { recursive: true });
const startedAt = new Date().toISOString();
const command = [process.execPath, 'tooling/verify-productization.mjs'];
fs.writeFileSync(path.join(out, 'started.json'), JSON.stringify({ startedAt, pid: process.pid, root, command,
  npmAlias: 'npm run verify:productization', caveat: 'Start is not completion.' }, null, 2));
const logs = ['stdout.log', 'stderr.log'].map(name => fs.openSync(path.join(out, name), 'wx'));
let result;
try {
  result = spawnSync(command[0], command.slice(1), { cwd: root, windowsHide: true, stdio: ['ignore', ...logs] });
} finally { for (const fd of logs) fs.closeSync(fd); }
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
  command, status: result.status, signal: result.signal, error: result.error?.message ?? null }, null, 2));
process.exit(result.status ?? 1);
