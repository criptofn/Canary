#!/usr/bin/env node
/** Replay the naturally observed H2 check crash against two explicit installed CLIs. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const before = arg('before-cli'), after = arg('after-cli'), observed = arg('observed'), source = arg('git-source'), out = arg('out');
const base = '7d0eb49c46d83184638fa093b44a15222feb8c51';
const files = ['src/workflows/fileOrganizer.js', 'scripts/smoke-test.js', 'Receipt_2025.doc', 'Rechnung_2026-03.txt', 'Tax_Report.pptx', 'document.pdf', 'invoice-2026.md', 'notes.txt'];
if (![before, after, observed, source, out].every(value => typeof value === 'string' && path.isAbsolute(value)) || fs.existsSync(out)) {
  throw new Error('use --before-cli, --after-cli, --observed, --git-source and a new --out, all absolute paths');
}
for (const cli of [before, after]) assert.ok(fs.statSync(cli).isFile());
for (const name of files) assert.ok(fs.lstatSync(path.join(observed, name)).isFile(), `missing observed file: ${name}`);
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-worker-crash-replay-'));
const relativeTemp = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(temp));
assert.ok(relativeTemp && !relativeTemp.startsWith('..') && !path.isAbsolute(relativeTemp));
const records = [];
try {
  for (const [arm, cli] of [['before', before], ['after', after]]) {
    const repo = path.join(temp, arm);
    const evidence = path.join(out, arm);
    fs.mkdirSync(repo); fs.mkdirSync(evidence);
    const env = { ...process.env, CANARY_TRUST_STORE: path.join(evidence, 'trust-store') };
    const commands = [];
    function run(name, executable, args, input) {
      const start = Date.now();
      const r = spawnSync(executable, args, { cwd: repo, input, env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
      for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(evidence, `${name}.${stream}.txt`), r[stream] ?? '', { flag: 'wx' });
      commands.push({ name, executable, args, cwd: repo, input: input ?? null, exitCode: r.status, timedOut: r.error?.code === 'ETIMEDOUT', error: r.error?.message ?? null,
        elapsedMs: Date.now() - start, stdoutSha256: hash(r.stdout ?? ''), stderrSha256: hash(r.stderr ?? '') });
      return r;
    }
    function git(name, args) {
      const r = run(name, 'git', args);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return r.stdout.trim();
    }
    git('init', ['init', '-b', 'replay']);
    git('fetch', ['fetch', '--depth=1', source, base]);
    git('checkout', ['reset', '--hard', 'FETCH_HEAD']);
    git('name', ['config', 'user.name', 'Canary Replay']);
    git('email', ['config', 'user.email', 'replay@localhost']);
    const version = run('version', process.execPath, [cli, '--version']);
    assert.equal(version.status, 0);
    const setup = run('setup', process.execPath, [cli, 'setup', '--yes']);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    git('setup-add', ['add', '--all']);
    git('setup-commit', ['commit', '--allow-empty', '-m', 'Replay setup baseline']);
    const sealed = run('seal', process.execPath, [cli, 'setup', '--yes']);
    assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
    const baselineHead = git('head', ['rev-parse', 'HEAD']);
    for (const name of files) fs.copyFileSync(path.join(observed, name), path.join(repo, name));
    const doctor = run('doctor', process.execPath, [cli, 'doctor', '--json']);
    const status = JSON.parse(doctor.stdout).status;
    const checkpoint = run('checkpoint', process.execPath, [cli, 'checkpoint'], JSON.stringify({ cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }));
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    const hook = checkpoint.stdout.trim() ? JSON.parse(checkpoint.stdout) : null;
    const checkpointRecord = JSON.parse(fs.readFileSync(path.join(repo, '.canary/last-checkpoint.json'), 'utf8'));
    if (arm === 'before') {
      assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
      assert.equal(status, 'READY');
      assert.equal(checkpointRecord.status, 'pass');
      assert.match(hook.systemMessage, /with a caveat/);
    } else {
      assert.equal(doctor.status, 2, doctor.stdout + doctor.stderr);
      assert.equal(status, 'NOT PROVEN');
      assert.equal(checkpointRecord.status, 'unproven');
      assert.equal(hook.decision, 'block');
      assert.match(hook.reason, /worker-authored check.*same inputs/);
    }
    fs.cpSync(path.join(repo, '.canary/evidence'), path.join(evidence, 'product-evidence'), { recursive: true, errorOnExist: true, force: false });
    fs.writeFileSync(path.join(evidence, 'checkpoint.json'), `${JSON.stringify(checkpointRecord, null, 2)}\n`, { flag: 'wx' });
    records.push({ arm, cli, cliSha256: hash(fs.readFileSync(cli)), version: version.stdout.trim(), baselineHead, doctorStatus: status, checkpointStatus: checkpointRecord.status, hook, commands });
    console.log(`PASS ${arm}: replay observed doctor ${status}, checkpoint ${checkpointRecord.status}`);
  }
  fs.writeFileSync(path.join(out, 'comparison.json'), `${JSON.stringify({ base, source, observed, node: process.version, probeSha256: hash(fs.readFileSync(import.meta.filename)),
    files: files.map(name => ({ path: name, sha256: hash(fs.readFileSync(path.join(observed, name))) })), records }, null, 2)}\n`, { flag: 'wx' });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
