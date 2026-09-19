/**
 * 1.1 §18–21 — the agent capability table and the advisory integration.
 *
 * Pinned here: the table never claims a capability it does not have; the
 * AGENTS.md block is idempotent, exactly removable, leaves foreign content
 * byte-identical, and is never written through a link; and the one GATING
 * integration stays owned by setup.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation

import { ADVISORY_BEGIN, ADVISORY_END, AGENT_INTEGRATIONS, advisoryBlock } from '../src/agents.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-agents-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const canary = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
const project = (name: string): string => {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts: {} }, null, 2));
  return root;
};

describe('1.1 agents: the capability table is honest by construction', () => {
  it('exactly one integration may claim GATED, and every other says ADVISORY', () => {
    assert.deepEqual(AGENT_INTEGRATIONS.filter((a) => a.gating).map((a) => a.id), ['claude-code']);
    for (const a of AGENT_INTEGRATIONS.filter((x) => !x.gating)) {
      assert.match(a.summary, /ADVISORY/, `${a.id} must label itself advisory`);
    }
  });

  it('the advisory text tells an agent what to run and claims no gate', () => {
    const block = advisoryBlock();
    assert.match(block, /canary result --json/);
    assert.match(block, /canary doctor --json/);
    assert.ok(block.startsWith(ADVISORY_BEGIN), 'the block must be marked from its first byte');
    assert.ok(block.trimEnd().endsWith(ADVISORY_END), 'the block must be closed by its marker');
  });

  it('agents --json lists the integrations with their real capability', () => {
    const root = project('listing');
    const r = canary(['agents', '--json', root]);
    const env = JSON.parse(r.stdout) as { schema: string; command: string; integrations: Array<{ id: string; gating: boolean; detected: boolean }> };
    assert.equal(env.schema, 'canary-status/1');
    assert.equal(env.command, 'agents');
    assert.deepEqual(env.integrations.map((i) => `${i.id}:${i.gating ? 'GATED' : 'ADVISORY'}`),
      ['claude-code:GATED', 'codex:ADVISORY', 'generic:ADVISORY']);
    for (const i of env.integrations) assert.equal(typeof i.detected, 'boolean');
  });
});

describe('1.1 agents: the advisory integration is marked, idempotent and exactly removable', () => {
  it('install preserves foreign content; re-install is byte-identical; uninstall removes only the block', () => {
    const root = project('advisory');
    const file = path.join(root, 'AGENTS.md');
    const original = '# Project rules\n\nKeep this line.\n';
    fs.writeFileSync(file, original);

    const r1 = canary(['agents', 'install', 'codex', root]);
    assert.equal(r1.status, 0, r1.stderr);
    const after1 = fs.readFileSync(file, 'utf8');
    assert.ok(after1.startsWith(original), 'existing content must be preserved verbatim');
    assert.ok(after1.includes(ADVISORY_BEGIN) && after1.includes(ADVISORY_END));

    const r2 = canary(['agents', 'install', 'codex', root]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), after1, 'a second install must change nothing');

    const r3 = canary(['agents', 'uninstall', 'codex', root]);
    assert.equal(r3.status, 0, r3.stderr);
    const after3 = fs.readFileSync(file, 'utf8');
    assert.ok(!after3.includes(ADVISORY_BEGIN), 'the block must be gone');
    assert.equal(after3.trim(), original.trim(), 'nothing else may change');
  });

  it('install creates the file when absent, and uninstall tolerates an absent file', () => {
    const root = project('advisory-fresh');
    assert.equal(canary(['agents', 'install', 'generic', root]).status, 0);
    const file = path.join(root, 'AGENTS.md');
    assert.ok(fs.readFileSync(file, 'utf8').includes(ADVISORY_BEGIN));
    assert.equal(canary(['agents', 'uninstall', 'generic', root]).status, 0);
    assert.equal(canary(['agents', 'uninstall', 'generic', root]).status, 0, 'a second uninstall is safe');
  });

  it('the one GATING integration is owned by setup, not by an advisory command', () => {
    const root = project('gating');
    const r = canary(['agents', 'install', 'claude-code', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout + r.stderr, /GATING integration/);
    assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false, 'a refusal must write nothing');
  });

  it('an unknown id is refused and nothing is written', () => {
    const root = project('unknown');
    const r = canary(['agents', 'install', 'copilot', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout + r.stderr, /not an agent integration/);
    assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  });

  it('never writes through a link (a linked AGENTS.md could escape the repo)', () => {
    const root = project('linked');
    const real = path.join(TMP, 'real-agents-dir');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, path.join(root, 'AGENTS.md'), 'junction'); // a directory junction needs no elevation
    const r = canary(['agents', 'install', 'codex', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout + r.stderr, /will not write through links/);
  });
});

/**
 * v1.3, slice 1 — DETECTING AN AGENT IS NOT PROTECTING THE REPOSITORY.
 *
 * MEASURED (tooling/probes/v13-journey-baseline.mjs): a repository whose `.claude/` held nothing but a
 * skill file — no settings.json, no hook — got "CONNECTED — Claude Code can gate completions here."
 * at exit 0 from `agents`, while `status` on the same bytes said NOT CONNECTED and exited 2. The
 * optimistic answer was the successful one, which is the worst possible arrangement: overclaiming
 * protection is the failure this project exists to prevent, and detection cannot see it because
 * `.claude/` existing — or `~/.claude`, present on any machine with Claude Code installed — was the
 * whole test.
 */
describe('v1.3 agents: a detected agent is not a gated repository', () => {
  it('does not claim a completion can be blocked when no hook is installed', () => {
    const root = project('claude-no-hook');
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'demo', 'SKILL.md'), '# a skill, not a hook\n');

    const r = canary(['agents', root]);
    assert.equal(r.status, 2, `detection alone must not be reported as protection:\n${r.stdout}`);
    assert.match(r.stdout, /Claude Code — detected/);
    assert.match(r.stdout, /hook NOT installed here/);
    assert.doesNotMatch(r.stdout, /CONNECTED/, 'the word CONNECTED is a claim about wiring');
    assert.match(r.stdout, /canary setup/);

    // and it must agree with the command whose whole job is the wiring question
    const s = canary(['status', root]);
    assert.equal(s.status, 2);
    assert.match(s.stdout, /NOT CONNECTED/);
  });

  it('the machine channel reports the same fact: hooked means the hook is installed', () => {
    const root = project('claude-no-hook-json');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const r = canary(['agents', '--json', root]);
    const env = JSON.parse(r.stdout) as { agent: { hooked: boolean; harnesses: Array<{ id: string; gated: boolean }> } };
    assert.equal(r.status, 2);
    // The integration is still GATED (a capability), but this repository is not hooked (a fact).
    assert.ok(env.agent.harnesses.some((h) => h.id === 'claude-code' && h.gated));
    assert.equal(env.agent.hooked, false, 'a detected agent with no hook is not a hooked repository');
  });

  it('after setup installs the hook, both the claim and the machine channel flip together', () => {
    const root = path.join(TMP, 'claude-hooked');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'claude-hooked',
      scripts: { test: `node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', 'f-pass.js')}"` },
    }, null, 2));
    spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'agents@canary.local'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Agents'], { cwd: root });

    const s = canary(['setup', '--yes', root]);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    const r = canary(['agents', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /hook installed here/);
    assert.match(r.stdout, /CONNECTED/);
    const env = JSON.parse(canary(['agents', '--json', root]).stdout) as { agent: { hooked: boolean } };
    assert.equal(env.agent.hooked, true);
  });
});
