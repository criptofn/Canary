#!/usr/bin/env node
/** Preserve an interrupted producer's bytes and current work without inventing a native result. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [root, out] = process.argv.slice(2);
assert.ok([root, out].every((value) => value && path.isAbsolute(value)) && !fs.existsSync(out));
assert.equal(fs.existsSync(path.join(root, 'summary.json')), false, 'use the regular archive for a finished producer');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const preparation = JSON.parse(fs.readFileSync(path.join(root, 'preparation-summary.json'), 'utf8'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(fs.readFileSync(manifest.cli)), manifest.cliSha256);
const copied = path.join(out, 'interrupted-capture');
fs.mkdirSync(out, { recursive: true }); fs.cpSync(root, copied, { recursive: true });
fs.copyFileSync(import.meta.filename, path.join(out, 'recovery-instrument.mjs'));
const sessions = preparation.records.map((record) => {
  const name = `${record.label}-${record.arm}`;
  assert.ok(fs.existsSync(path.join(root, `${name}-before.json`)), 'do not manufacture an unstarted session');
  const file = path.join(root, name, 'record.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { name, cwd: record.repo, captureComplete: false, terminal: null, nativeUsage: null,
      caveat: 'Filesystem snapshot only; native session result and reconciled usage are missing.' };
});
const summary = { ...manifest, status: 'incomplete', recoveredAt: new Date().toISOString(), sessions,
  failure: 'Producer disappeared without summary; cause unproven. Current files are not a completed native observation.' };
fs.writeFileSync(path.join(copied, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
const archived = path.join(out, 'worker-states');
const archive = spawnSync(process.execPath, [path.join(import.meta.dirname, 'v15-claude-local-archive.mjs'), '--evidence', copied, '--out', archived],
  { encoding: 'utf8', windowsHide: true, timeout: 120000 });
fs.writeFileSync(path.join(out, 'archive.stdout.txt'), archive.stdout ?? '', { flag: 'wx' });
fs.writeFileSync(path.join(out, 'archive.stderr.txt'), archive.stderr ?? '', { flag: 'wx' });
assert.equal(archive.status, 0, `${archive.stdout} ${archive.stderr}`);
const snapshots = preparation.records.map((record) => {
  const file = path.join(record.repo, '.canary/last-checkpoint.json');
  return { name: `${record.label}-${record.arm}`, snapshotCheckpoint: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
});
fs.writeFileSync(path.join(out, 'snapshot-checkpoints.json'), `${JSON.stringify(snapshots, null, 2)}\n`, { flag: 'wx' });
const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, file)).isFile()).sort();
fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${files.map((file) => `${hash(fs.readFileSync(path.join(out, file)))}  ${file.replaceAll('\\', '/')}`).join('\n')}\n`, { flag: 'wx' });
console.log(`PASS preserved ${files.length} interrupted-capture and worker-state files; native capture remains INCOMPLETE`);
