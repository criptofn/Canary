// Bounded release audit: production enrollment must work outside the checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const packs = path.join(repo, 'pack/npm');
const archives = fs.readdirSync(packs).filter(f => f.endsWith('.tgz'));
if (archives.length !== 1) throw new Error('Pack first; expected exactly one archive');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary packed provider '));
// Separate reports from the installation fixture and from other native probes.
const evidenceParent = process.env.CANARY_PROBE_REPORT_DIR ?? os.tmpdir();
fs.mkdirSync(evidenceParent, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceParent, 'canary-packed-provider-evidence-'));
const reportFile = path.join(evidence, 'provider.json');
const instrument = path.join(repo, 'tooling/probes/v12-production-authority.mjs');
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (exe, args, cwd = root, shell = false) => spawnSync(exe, args,
  { cwd, shell, windowsHide: true, encoding: 'utf8', timeout: 60000 });
const requireOk = (label, r) => {
  if (r.status !== 0) throw new Error(`${label}: ${r.status}\n${r.stdout}\n${r.stderr}`);
  console.log(`PASS ${label}`);
};
try {
  fs.copyFileSync(path.join(packs, archives[0]), path.join(evidence, 'package.tgz'));
  fs.copyFileSync(instrument, path.join(evidence, 'instrument.mjs'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
  requireOk('install exact local tarball', run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', `"${path.join(packs, archives[0])}"`], root, true));
  const cli = path.join(root, 'node_modules/@canary-rn/cli/dist/main.js');
  const args = [instrument, '--cli', cli, '--report', reportFile];
  const result = spawnSync(process.execPath, args,
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidence, 'stdout.txt'), result.stdout ?? '');
  fs.writeFileSync(path.join(evidence, 'stderr.txt'), result.stderr ?? '');
  fs.writeFileSync(path.join(evidence, 'attempt.json'), JSON.stringify({
    executable: process.execPath, args, cwd: root, exitCode: result.status, signal: result.signal,
    error: result.error?.message ?? null, cliSha256: hash(cli),
    packageSha256: hash(path.join(evidence, 'package.tgz')), instrumentSha256: hash(path.join(evidence, 'instrument.mjs')),
  }, null, 2));
  console.log((result.stdout ?? '') + (result.stderr ?? ''));
  requireOk('installed production authority, custody and attack battery', result);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.cli?.sha256, hash(cli), 'report must describe this installed CLI');
  assert.equal(report.instrumentSha256, hash(path.join(evidence, 'instrument.mjs')), 'report must come from this instrument');
} finally {
  console.log(`PROVIDER EVIDENCE: ${evidence}`);
  fs.rmSync(root, { recursive: true, force: true });
}
