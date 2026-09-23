// Vulnerability reproducer, NOT a security-pass test. No model or hidden oracle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-self-binding-audit-'));
const root = path.join(temp, 'project');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'trust') };
const run = (command, args) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
const git = args => { const r = run('git', args); assert.equal(r.status, 0, r.stderr); };
const canary = args => run(process.execPath, [cli, ...args]);
try {
  fs.cpSync(path.join(repo, 'tooling/benchmark/fixtures/add-validation/project'), root, { recursive: true });
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the reproducer only reproduced
  // on a machine that has Claude Code installed.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(repo, 'tooling/benchmark/fixtures/add-validation/fixture.json'), 'utf8'));
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Trust audit']); git(['config', 'user.email', 'audit@localhost']);
  git(['add', '-A']); git(['commit', '-m', 'baseline']);
  canary(['setup', '--yes']);
  const work = ['work', 'attack', meta.intent ?? 'implement stated validation', ...meta.requirements.flatMap(r => ['--requirement', r])];
  const before = canary(work);
  assert.equal(before.status, 2, before.stdout + before.stderr);
  assert.match(before.stdout, /REQUIREMENT UNBOUND/);
  const digests = [...before.stdout.matchAll(/unbound: ([a-f0-9]{64})/g)].map(m => m[1]);
  assert.equal(digests.length, meta.requirements.length);
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof pkg.scripts.test, 'string');
  // Intentionally adversarial: the same unrestricted identity invents bindings.
  // These are NOT operator-reviewed and must never enter a benchmark fixture.
  pkg.canary = { ...pkg.canary, proofs: Object.fromEntries(digests.map(d => [d, 'test'])) };
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  git(['add', 'package.json']); git(['commit', '-m', 'untrusted worker self-binding attempt']);
  const reseal = canary(['setup', '--yes']);
  const after = canary(work);
  assert.equal(after.status, 0, after.stdout + after.stderr + reseal.stderr);
  assert.doesNotMatch(after.stdout, /REQUIREMENT UNBOUND/);
  console.log(`CONFIRMED RELEASE BLOCKER: same-user worker authored ${digests.length} bindings; setup resealed; previously refused work opened.`);
  console.log('Reproducer succeeded; this is an attack SUCCESS, not a blocked attack or a HARDENED escape claim.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
