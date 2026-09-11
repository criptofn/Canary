/**
 * 1.1 §21/§26/§28 — the machine-readable protocol.
 *
 * Two invariants are pinned here, because both are easy to break by accident:
 *   1. `--json` NEVER changes a verdict. Same exit code, same status word, same
 *      decisions — it only moves the human prose to stderr.
 *   2. In JSON mode stdout is EXACTLY ONE JSON object. An agent must never have
 *      to parse around sentences, and the envelope must stay compact: full
 *      evidence is named by path, not pasted into a model's context.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);
const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-protocol-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const canary = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const makeProject = (name: string): string => {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name, scripts: { test: `node "${path.join(FIXTURES, 'f-pass.js')}"` } }, null, 2));
  return root;
};

describe('1.1 protocol: one JSON object, and no verdict changes', () => {
  it('status --json on an unwired project: pure JSON on stdout, prose on stderr', () => {
    const root = makeProject('unwired');
    const r = canary(['status', '--json', root]);
    assert.equal(r.status, 2);
    const env = JSON.parse(r.stdout) as Record<string, unknown>; // stdout must BE the object
    assert.equal(env.schema, 'canary-status/1');
    assert.equal(env.command, 'status');
    assert.equal(env.status, 'NOT CONNECTED');
    assert.equal(env.exitCode, 2);
    assert.ok(same(String(env.root), root), String(env.root));
    assert.match(r.stderr, /NOT CONNECTED/); // the human still gets the words
  });

  it('status --json on a wired project carries checks, the measured level and harness facts', () => {
    const root = makeProject('wired');
    const s = canary(['setup', '--yes', root]);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    const r = canary(['status', '--json', root]);
    assert.equal(r.status, 0, r.stderr);
    const env = JSON.parse(r.stdout) as {
      status: string;
      checks: unknown;
      security: { level: string; reasons: string[] };
      agent: { hooked: boolean; harnesses: Array<{ id: string; gated: boolean }> };
    };
    assert.equal(env.status, 'CONNECTED');
    assert.deepEqual(env.checks, [{ kind: 'tests', script: 'test', adapter: 'node', scope: '', argv: ['npm', 'run', 'test'] }]);
    assert.equal(env.security.level, 'LOCAL');
    assert.ok(env.security.reasons.some((x) => /HARDENED/.test(x)), 'the ceiling must be stated, not implied');
    assert.equal(env.agent.hooked, true);
    assert.ok(env.agent.harnesses.some((h) => h.id === 'claude-code' && h.gated), 'Claude Code must be reported as gating');
  });

  it('the exit code and the status word are identical with and without --json', () => {
    const root = makeProject('parity');
    for (const base of [['status', root], ['doctor', root], ['result', root]]) {
      const human = canary(base);
      const json = canary([...base.slice(0, 1), '--json', ...base.slice(1)]);
      assert.equal(json.status, human.status, `exit codes differ for ${base.join(' ')}`);
      const env = JSON.parse(json.stdout) as { exitCode: number };
      assert.equal(env.exitCode, json.status, 'the envelope must agree with the process exit code');
    }
  });

  it('doctor --json reports problems as a list and keeps stdout to one object', () => {
    const root = makeProject('doctor-json');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'doctor-json', scripts: {} }, null, 2)); // the sealed check is gone
    const r = canary(['doctor', '--json', root]);
    assert.equal(r.status, 2);
    const env = JSON.parse(r.stdout) as { status: string; problems?: string[] };
    assert.equal(env.status, 'NEEDS ATTENTION');
    assert.ok(Array.isArray(env.problems) && env.problems.length > 0, JSON.stringify(env));
  });

  it('result is the free state answer: no plan run, compact, and it names where evidence lives', () => {
    const root = makeProject('result');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfgPath = path.join(root, '.canary', 'canary.local.json');
    const before = fs.readFileSync(cfgPath, 'utf8');
    const stateBefore = fs.readdirSync(path.join(root, '.canary')).sort().join(',');

    const r = canary(['result', '--json', root]);
    assert.equal(r.status, 0, r.stderr);
    const env = JSON.parse(r.stdout) as { schema: string; command: string; status: string; checks: unknown[]; evidencePath: string };
    assert.equal(env.schema, 'canary-result/1');
    assert.equal(env.command, 'result');
    assert.equal(env.status, 'CONNECTED');
    assert.equal(env.checks.length, 1);
    assert.match(env.evidencePath, /\.canary$/, 'the envelope points at the state, it does not paste it');
    assert.ok(r.stdout.length < 4000, `the envelope must stay compact, got ${r.stdout.length} bytes`);
    // and it never executes the plan or writes anything
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before, 'result must not touch the sealed config');
    assert.equal(fs.readdirSync(path.join(root, '.canary')).sort().join(','), stateBefore, 'result must not add state');
  });
});
