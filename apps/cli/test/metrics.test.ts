/**
 * 1.1 §35 — the metrics record.
 *
 * Three properties matter more than the fields themselves, and each has a test:
 * instrumentation is OFF unless asked for; it NEVER changes a verdict (including
 * when the target cannot be written); and it never records free text, paths or
 * flag VALUES — the campaign needs counts and outcomes, not a copy of the
 * user's repository or their task descriptions.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-metrics-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const run = (args: string[], metrics?: string) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: REPO, encoding: 'utf8', timeout: 120_000,
  env: metrics === undefined ? { ...process.env, CANARY_METRICS: '' } : { ...process.env, CANARY_METRICS: metrics },
});
const readRecords = (file: string): Array<Record<string, unknown>> =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('1.1 metrics: off by default, one record per invocation', () => {
  it('writes nothing when CANARY_METRICS is unset or empty', () => {
    const target = path.join(TMP, 'never.jsonl');
    const r = run(['version']);
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(target), false);
    assert.ok(!fs.existsSync(path.join(REPO, 'metrics.jsonl')), 'never inside the repository by default');
  });

  it('appends exactly one record per invocation with the outcome the process reported', () => {
    const target = path.join(TMP, 'one.jsonl');
    const root = fs.mkdtempSync(path.join(TMP, 'proj-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });

    const r = run(['status', root], target);
    const records = readRecords(target);
    assert.equal(records.length, 1, 'one line per invocation');
    const rec = records[0]!;
    assert.equal(rec.schema, 'canary-metrics/1');
    assert.equal(rec.command, 'status');
    assert.deepEqual(rec.flags, []);
    assert.equal(rec.exitCode, r.status);
    assert.equal(rec.ok, r.status === 0);
    assert.equal(typeof rec.durationMs, 'number');
    assert.ok((rec.durationMs as number) >= 0);
    assert.equal(typeof rec.canaryVersion, 'string');
    assert.equal(typeof rec.node, 'string');
    assert.match(String(rec.platform), /^(win32|linux|darwin)\//);
    assert.ok(rec.stdoutBytes === null || typeof rec.stdoutBytes === 'number');
  });

  it('records flag NAMES and never a value, a path, or free text', () => {
    const target = path.join(TMP, 'privacy.jsonl');
    const root = fs.mkdtempSync(path.join(TMP, 'secret-project-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });

    run(['status', '--json', '--verbose', root], target);
    run(['task', 'super-secret-plan-text', root], target);

    const raw = fs.readFileSync(target, 'utf8');
    assert.ok(!raw.includes('secret-project-'), 'a path must never be recorded');
    assert.ok(!raw.includes('super-secret-plan-text'), 'task text must never be recorded');

    const records = readRecords(target);
    assert.deepEqual(records[0]!.flags, ['--json', '--verbose']);
    assert.equal(records[0]!.command, 'status');
    assert.equal(records[1]!.command, 'task');
  });

  it('never changes a verdict — with or without instrumentation, and when the target is unwritable', () => {
    const root = fs.mkdtempSync(path.join(TMP, 'verdict-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const without = run(['status', root]);
    const with_ = run(['status', root], path.join(TMP, 'verdict.jsonl'));
    assert.equal(with_.status, without.status);
    assert.equal(with_.stdout, without.stdout, 'routine output must stay byte-identical');

    // a FILE where a directory must be: every platform refuses to create the path
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const broken = run(['status', root], path.join(blocker, 'nested', 'metrics.jsonl'));
    assert.equal(broken.status, without.status, 'a metrics failure must not become the command failure');
    assert.equal(broken.stdout, without.stdout);
    assert.ok(!broken.stdout.includes('not recorded'), 'and it must stay quiet unless verbose is asked for');
    assert.ok(!broken.stderr.includes('not recorded'));
  });
});
