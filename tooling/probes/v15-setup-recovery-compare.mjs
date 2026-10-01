#!/usr/bin/env node
/** Installed-package setup recovery controls, independent of development builds. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const out = arg('out');
const arms = ['before', 'after'].map((name) => ({ name, cli: arg(`${name}-cli`), package: arg(`${name}-package`) }));
assert.ok([out, ...arms.flatMap((arm) => [arm.cli, arm.package])].every((value) => value && path.isAbsolute(value)));
assert.ok(!fs.existsSync(out));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => sha(fs.readFileSync(file));
const fixtureRoot = path.resolve(import.meta.dirname, '../test-support/fixtures');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-setup-recovery-'));
fs.mkdirSync(out, { recursive: true });
const save = (name, data) => fs.writeFileSync(path.join(out, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
const commands = [], rows = [];
const manifest = { startedAt: new Date().toISOString(), instrumentSha256: fileHash(import.meta.filename),
  arms: arms.map((arm) => ({ ...arm, cliSha256: fileHash(arm.cli), packageSha256: fileHash(arm.package) })),
  fixtures: ['f-pass.js', 'f-boom.js'].map((name) => ({ name, sha256: fileHash(path.join(fixtureRoot, name)) })),
  nativeAgentSession: false, manualInterventions: 0 };
save('manifest.json', manifest); save('instrument.mjs', fs.readFileSync(import.meta.filename, 'utf8'));
function run(arm, name, repo, trust, args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [arm.cli, ...args, repo], { encoding: 'utf8', windowsHide: true,
    timeout: 120000, env: { ...process.env, CANARY_TRUST_STORE: trust } });
  save(`${arm.name}-${name}.out.log`, result.stdout ?? ''); save(`${arm.name}-${name}.err.log`, result.stderr ?? '');
  commands.push({ arm: arm.name, name, executable: process.execPath, args: [arm.cli, ...args, repo],
    startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message ?? null });
  assert.equal(result.error, undefined);
  return result;
}
function project(name, fail = false) {
  const repo = path.join(temp, name); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude')); fs.mkdirSync(path.join(repo, '.codex'));
  const fixture = path.join(fixtureRoot, fail ? 'f-boom.js' : 'f-pass.js');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name, scripts: { test: `node "${fixture}"` } }));
  fs.writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }));
  fs.writeFileSync(path.join(repo, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-codex' }] }] } }));
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { teammate: { command: 'node', args: ['teammate.js'] } } }));
  return repo;
}
const integrations = ['.claude/settings.json', '.codex/hooks.json', '.mcp.json'];
function preservedAndUnique(repo) {
  const settings = JSON.parse(fs.readFileSync(path.join(repo, integrations[0]), 'utf8'));
  assert.equal(settings.theme, 'dark');
  for (const [file, user] of [[integrations[0], 'echo user-hook'], [integrations[1], 'echo user-codex']]) {
    const doc = JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
    const hooks = doc.hooks.Stop.flatMap((group) => group.hooks);
    assert.equal(hooks.filter((hook) => hook.command === user).length, 1);
    assert.equal(hooks.filter((hook) => hook.command?.includes('checkpoint')).length, 1);
  }
  const mcp = JSON.parse(fs.readFileSync(path.join(repo, integrations[2]), 'utf8'));
  assert.deepEqual(mcp.mcpServers.teammate, { command: 'node', args: ['teammate.js'] });
  assert.ok(mcp.mcpServers.canary);
}
let failure = null;
try {
  for (const arm of arms) {
    const repo = project(`${arm.name}-recovery`), trust = path.join(temp, `${arm.name}-trust`);
    const blockedStore = path.join(temp, `${arm.name}-blocked-store`); fs.writeFileSync(blockedStore, 'not a directory');
    const before = integrations.map((file) => fileHash(path.join(repo, file)));
    const aborted = run(arm, 'late-failure', repo, blockedStore, ['setup', '--yes']);
    assert.equal(aborted.status, 2);
    const restored = integrations.every((file, index) => fileHash(path.join(repo, file)) === before[index]);
    const activeConfigLeft = fs.existsSync(path.join(repo, '.canary/canary.local.json'));
    if (arm.name === 'after') { assert.ok(restored); assert.equal(activeConfigLeft, false); }
    rows.push({ arm: arm.name, control: 'late authority-store failure', exitCode: aborted.status, restored, activeConfigLeft });
    for (const n of [1, 2]) { assert.equal(run(arm, `retry-${n}`, repo, trust, ['setup', '--yes']).status, 0); preservedAndUnique(repo); }
    rows.push({ arm: arm.name, control: 'retry twice', preservedUserSettings: true, canaryEntriesPerHarness: 1 });
    const malformed = project(`${arm.name}-malformed`); fs.writeFileSync(path.join(malformed, integrations[0]), '{not json');
    const malformedBefore = integrations.map((file) => fileHash(path.join(malformed, file)));
    assert.equal(run(arm, 'malformed', malformed, trust, ['setup', '--yes']).status, 2);
    const untouched = integrations.every((file, index) => fileHash(path.join(malformed, file)) === malformedBefore[index]);
    if (arm.name === 'after') { assert.ok(untouched); assert.equal(fs.existsSync(path.join(malformed, '.canary/canary.local.json')), false); }
    rows.push({ arm: arm.name, control: 'malformed settings preflight', untouched, activeConfigLeft: fs.existsSync(path.join(malformed, '.canary/canary.local.json')) });
    const red = project(`${arm.name}-red-project`, true);
    assert.equal(run(arm, 'red-project', red, trust, ['setup', '--yes']).status, 2);
    preservedAndUnique(red);
    assert.equal(JSON.parse(fs.readFileSync(path.join(red, '.canary/last-checkpoint.json'), 'utf8')).status, 'fail');
    rows.push({ arm: arm.name, control: 'red project check', integrationRetained: true, checkpoint: 'fail' });
    console.log(`PASS ${arm.name}: setup recovery observations captured`);
  }
  assert.equal(rows.find((row) => row.arm === 'before' && row.control.startsWith('late')).restored, false,
    'the old package must reproduce the rollback defect for this claimed improvement');
} catch (error) { failure = error.stack ?? String(error); console.error(failure); }
finally {
  for (const arm of manifest.arms) { assert.equal(fileHash(arm.cli), arm.cliSha256); assert.equal(fileHash(arm.package), arm.packageSha256); }
  save('summary.json', { ...manifest, finishedAt: new Date().toISOString(), status: failure ? 'incomplete' : 'complete', failure, rows, commands });
  const files = fs.readdirSync(out).filter((name) => fs.statSync(path.join(out, name)).isFile()).sort();
  save('SHA256SUMS', `${files.map((name) => `${fileHash(path.join(out, name))}  ${name}`).join('\n')}\n`);
  assert.equal(fs.realpathSync.native(temp), path.join(fs.realpathSync.native(os.tmpdir()), path.basename(temp)));
  fs.rmSync(temp, { recursive: true }); process.exitCode = failure ? 1 : 0;
}
