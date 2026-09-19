import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-git-path-'));
const work = path.join(root, 'self-contained'); fs.mkdirSync(work);
const run = (exe, args) => {
  const r = spawnSync(exe, args, { cwd: work, encoding: 'utf8', windowsHide: true, timeout: 45000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout;
};
try {
  run('git', ['init']);
  run('git', ['config', 'user.name', 'Path diagnostic']); run('git', ['config', 'user.email', 'path@localhost']);
  fs.writeFileSync(path.join(work, 'implementation.txt'), 'base\n');
  run('git', ['add', '.']); run('git', ['commit', '-m', 'self-contained base']);
  assert.ok(fs.statSync(path.join(work, '.git')).isDirectory());
  fs.writeFileSync(path.join(work, 'implementation.txt'), 'implementation change\n');
  run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(repo, 'tooling/test-support/fixtures/git-path-diagnostic.ps1'), '-Work', work, '-Side', path.join(root, 'token.jsonl'), '-Identity', path.join(root, 'identity.json'), '-Node', process.execPath]);
  const control = JSON.parse(fs.readFileSync(path.join(work, 'control.json'), 'utf8'));
  const restricted = JSON.parse(fs.readFileSync(path.join(work, 'restricted.json'), 'utf8'));
  const token = fs.readFileSync(path.join(root, 'token.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x));
  assert.equal(token[0].appContainer, true); assert.equal(token[0].restricted, true); assert.equal(token[0].capabilities, 0); assert.equal(token[1].exit, 0);
  const output = path.join(os.tmpdir(), 'canary-git-path-diagnostic.json');
  const gitControl = JSON.parse(fs.readFileSync(path.join(work, 'git-control.json'), 'utf8'));
  const gitRestricted = JSON.parse(fs.readFileSync(path.join(work, 'git-restricted.json'), 'utf8'));
  const gitToken = fs.readFileSync(path.join(root, 'token.jsonl.git'), 'utf8').split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x));
  assert.equal(gitToken[0].package, token[0].package); assert.equal(gitToken[1].exit, 0);
  assert.ok(gitControl.every(r => r.status === 0), JSON.stringify(gitControl));
  fs.writeFileSync(output, JSON.stringify({ work, control, restricted, token, gitControl, gitRestricted, gitToken }, null, 2));
  console.log('PASS paired native path diagnostics executed on self-contained committed repository');
  for (const row of restricted.filter(r => r.path === work || r.path === 'C:' || r.path?.includes('MountPointManager') || r.path === 'cwd')) console.log(JSON.stringify(row));
  console.log(`Complete per-parent and Git metadata observations: ${output}`);
  for (const result of gitRestricted) console.log(`CONFINED GIT ${JSON.stringify(result)}`);
  // This probe diagnoses, it does not report failed Git operations as a repair.
  console.log(`Git controls: ${gitControl.length}/${gitControl.length} succeed; confined commands: ${gitRestricted.filter(r => r.status === 0).length}/${gitRestricted.length} succeed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
