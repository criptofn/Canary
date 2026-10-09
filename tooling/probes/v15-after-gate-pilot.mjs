#!/usr/bin/env node
/** One-shot continuation: verified gate -> installed controls -> twelve frozen local sessions. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const out = arg('out'), gate = arg('gate-log'), exitFile = arg('gate-exit'), gateResult = arg('gate-result'), expectedSource = arg('expected-source');
const unit = arg('unit-log'), unitExit = arg('unit-exit');
assert.ok(Boolean(exitFile) !== Boolean(gateResult), 'provide exactly one --gate-exit or --gate-result');
const terminalFile = exitFile ?? gateResult;
assert.ok([out, gate, terminalFile, unit, unitExit].every((p) => p && path.isAbsolute(p)) && !fs.existsSync(out), 'explicit current unit and gate evidence required');
assert.match(expectedSource ?? '', /^[a-f0-9]{40}$/);
const root = path.resolve(import.meta.dirname, '../..');
const evidence = path.resolve(root, '../../evidence');
const runId = crypto.createHash('sha256').update(out).digest('hex').slice(0, 12);
const prepared = path.join(os.tmpdir(), `canary-native-validation-${runId}`);
const controls = path.join(os.tmpdir(), `canary-improved-six-task-${runId}`);
assert.equal(fs.existsSync(prepared), false, 'do not overwrite any earlier task workspace');
assert.equal(fs.existsSync(controls), false, 'do not overwrite earlier task controls');
fs.mkdirSync(out, { recursive: true });
const commands = []; let failure = null;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const state = (phase) => fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ phase, pid: process.pid, at: new Date().toISOString(), expectedSource, prepared, commands }, null, 2));
function run(name, args, timeout = 600000, env = process.env) {
  state(name);
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, `${name}.stdout.log`), result.stdout ?? '');
  fs.writeFileSync(path.join(out, `${name}.stderr.log`), result.stderr ?? '');
  commands.push({ name, executable: process.execPath, args, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, `${name}: inspect saved logs`);
  console.log(`PASS ${name}`);
}
try {
  state('waiting-for-gate');
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (!fs.existsSync(terminalFile)) {
    assert.ok(Date.now() < deadline, 'gate did not produce a terminal exit record; no package or pilot started');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (gateResult) {
    const result = JSON.parse(fs.readFileSync(gateResult, 'utf8'));
    assert.equal(result.status, 0, 'failed or incomplete gate: do not start pilot');
    assert.equal(result.signal, null); assert.equal(result.error, null);
    assert.deepEqual(result.command, [process.execPath, 'tooling/verify-productization.mjs']);
  } else assert.equal(fs.readFileSync(exitFile, 'utf8').trim(), '0', 'failed or incomplete gate: do not start pilot');
  assert.match(fs.readFileSync(gate, 'utf8'), /VERIFY-PRODUCTIZATION: PASS(?: WITH EXPLICIT SKIPS)? \([^\r\n]+\)\s*$/, 'terminal gate summary required');
  assert.equal(fs.readFileSync(unitExit, 'utf8').trim(), '0', 'current unit suite must have completed successfully');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(git.status, 0); assert.equal(git.stdout.trim(), expectedSource, 'source changed while waiting; do not freeze an unreviewed stand');
  const frozen = path.join(out, 'package');
  run('freeze', [path.join(import.meta.dirname, 'v15-freeze-product-package.mjs'), '--out', frozen]);
  const artifact = JSON.parse(fs.readFileSync(path.join(frozen, 'summary.json'))).artifact;
  assert.equal(artifact.sourceCommit, expectedSource);
  for (const [source, name] of [[unit, 'unit.log'], [unitExit, 'unit.exit.txt'], [gate, 'productization.log'], [terminalFile, gateResult ? 'productization.result.json' : 'productization.exit.txt']]) fs.copyFileSync(source, path.join(frozen, name));
  const before = path.join(evidence, 'completion-workflow-final-20261002/installed/node_modules/@canary-rn/cli/dist/main.js');
  run('installed-comparison', [path.join(import.meta.dirname, 'v15-build-order-comparison.mjs'), before, artifact.cli, path.join(out, 'installed-comparison')]);
  run('installed-regressions', ['--test', '--test-name-pattern=build-dependent tests|colored Vitest|startup context|startup preflight|startup guidance|passing focused check|restores every integration file|setup is idempotent', 'apps/cli/dist/test/onboarding.test.js'], 180000, { ...process.env, CANARY_TEST_CLI: artifact.cli });
  run('six-task-controls', [path.join(import.meta.dirname, 'v15-installed-task-matrix.mjs'), '--cli', artifact.cli, '--package', artifact.package,
    '--out', controls, '--scratch-root', 'C:\\Users\\Johannes\\Desktop\\canary-ws5-scratch',
    '--java-bin', 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot\\bin'], 3600000);
  const controlArchive = path.join(out, 'six-task-controls-archive');
  run('archive-six-task-controls', [path.join(import.meta.dirname, 'v15-archive-task-matrix.mjs'), controls, controlArchive]);
  run('release-six-task-comparison', [path.join(import.meta.dirname, 'v15-release-task-comparison-report.mjs'),
    path.join(evidence, 'release-six-task-20261001-final'), controlArchive, path.join(out, 'release-six-task-comparison.md')]);
  run('cleanup-six-task-controls', [path.join(import.meta.dirname, 'v15-archive-task-matrix.mjs'), '--cleanup', controls, controlArchive]);
  run('prepare-twelve-arms', [path.join(import.meta.dirname, 'v15-pilot-prepare.mjs'), '--out', prepared, '--cli', artifact.cli, '--artifact-sha256', artifact.packageSha256,
    '--scratch-root', 'C:\\Users\\Johannes\\Desktop\\canary-ws5-scratch'], 3600000);
  run('native-twelve-sessions', [path.join(import.meta.dirname, 'v15-claude-local-preflight.mjs'), '--cli', artifact.cli,
    '--claude', 'C:\\Users\\Johannes\\.local\\bin\\claude.exe', '--ollama', 'C:\\Users\\Johannes\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
    '--out', path.join(out, 'native'), '--prepared-root', prepared], 7 * 60 * 60 * 1000);
  assert.equal(hash(artifact.cli), artifact.cliSha256, 'frozen CLI changed');
} catch (error) { failure = error.stack ?? String(error); console.error(failure); process.exitCode = 1; }
finally {
  state(failure ? 'incomplete' : 'captured-awaiting-assessment');
  fs.writeFileSync(path.join(out, 'workflow-result.json'), JSON.stringify({ status: failure ? 'incomplete' : 'captured-awaiting-assessment', failure, expectedSource,
    instrumentSha256: hash(import.meta.filename), commands, caveat: 'A completed capture is not an 8/10 rating. Inspect native correctness, actual Stop events, ledger, controls and product gates.' }, null, 2));
}
