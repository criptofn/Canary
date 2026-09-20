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
  it('an integration claims GATED only for a mechanism Canary has measured, and every other labels itself honestly', () => {
    // v1.4 §C — the gating set is still asserted EXACTLY, and it grew by one because the reason it
    // had one member turned out to be false: Codex's `Stop` contract is the same one Canary already
    // implements, and `tooling/probes/v14-codex-stop-hook.mjs` drives it as the vendor documents.
    // What must never relax is the price of the word GATED: a measurement, and — where the harness
    // still holds the hook at its own trust gate — that step said on the row.
    assert.deepEqual(AGENT_INTEGRATIONS.filter((a) => a.gating).map((a) => a.id), ['claude-code', 'codex']);
    for (const a of AGENT_INTEGRATIONS.filter((x) => x.gating)) {
      assert.notEqual(a.gatingMeasured, false, `${a.id} claims GATED without a measurement`);
      assert.match(a.summary, /hook installed into this project|completion hook installed into this project/,
        `${a.id} must say the hook is installed here, not merely that the harness exists`);
    }
    // The Codex hook does not run until the user trusts it — a summary that omitted that would call a
    // written file protection, which is the one claim this table exists to refuse.
    assert.match(String(AGENT_INTEGRATIONS.find((a) => a.id === 'codex')?.gatingNeedsTrust), /trust/);
    for (const a of AGENT_INTEGRATIONS.filter((x) => !x.gating)) {
      // v1.3 §E — a non-gating integration must say WHICH KIND of not-gating it is: the agent is told
      // and may ignore it (ADVISORY), or the vendor documents a mechanism this project has NOT
      // reproduced (UNMEASURED). The invariant is unchanged and in fact sharpened — an integration may
      // never claim protection, and an unmeasured mechanism may not be quietly called either a yes or
      // a no. Silence, "GATED", and a bare "ADVISORY" over an unmeasured mechanism would all be claims.
      assert.match(a.summary, a.gatingMeasured === false ? /UNMEASURED/ : /ADVISORY/,
        `${a.id} must label itself honestly`);
    }
  });

  it('the advisory text tells an agent what to run and claims no gate', () => {
    const block = advisoryBlock();
    assert.match(block, /canary result --json/);
    assert.match(block, /canary doctor --json/);
    assert.ok(block.startsWith(ADVISORY_BEGIN), 'the block must be marked from its first byte');
    assert.ok(block.trimEnd().endsWith(ADVISORY_END), 'the block must be closed by its marker');
    // v1.3 §A — the instruction that was MEASURED to matter: the `guarded` shape is the only recorded
    // Canary configuration cheaper than plain (92.7 %), while the ceremony shape cost 177.8 %, at equal
    // correctness. Both halves are asserted, because the aggressive half alone is the variant that
    // produced a false done and a false green.
    assert.match(block, /Verification here is AUTOMATIC/);
    assert.match(block, /do not repeat a check you have just run/);
    assert.match(block, /may and should still check/, 'the model keeps the decision to verify');
  });

  it('agents --json lists the integrations with their real capability', () => {
    const root = project('listing');
    const r = canary(['agents', '--json', root]);
    const env = JSON.parse(r.stdout) as { schema: string; command: string; integrations: Array<{ id: string; gating: boolean; gatingMeasured?: boolean; detected: boolean }> };
    assert.equal(env.schema, 'canary-status/1');
    assert.equal(env.command, 'agents');
    const label = (i: { gating: boolean; gatingMeasured?: boolean }) =>
      i.gating ? 'GATED' : i.gatingMeasured === false ? 'UNMEASURED' : 'ADVISORY';
    assert.deepEqual(env.integrations.map((i) => `${i.id}:${label(i)}`),
      ['claude-code:GATED', 'codex:GATED', 'cursor:UNMEASURED', 'generic:ADVISORY']);
    for (const i of env.integrations) assert.equal(typeof i.detected, 'boolean');
  });

  it('v1.3: Cursor is reported as UNMEASURED, never as protection', () => {
    // MEASURED context for this claim: Cursor's own documentation says it imports Claude Code hooks
    // (including Stop) and documents no way to remove its native tools. This project has NOT
    // reproduced the import on a real Cursor install, so the completion-gate question is answered
    // "unmeasured" — and the row must never read as protection.
    const root = project('cursor-here');
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const r = canary(['agents', root]);
    assert.match(r.stdout, /UNMEASURED Cursor — detected/);
    assert.match(r.stdout, /whether this harness honours it is UNMEASURED/);
    assert.doesNotMatch(r.stdout, /GATED\s+Cursor/, 'Cursor must never be reported as gated');
  });
});

describe('1.1 agents: the advisory integration is marked, idempotent and exactly removable', () => {
  // v1.4 §C — the advisory block is per-PROJECT (it lives in this repo's AGENTS.md and its text is
  // agent-independent), so these tests drive it through a still-advisory integration. They used
  // `codex` while Codex was advisory; Codex now has a real completion hook, `canary agents install
  // codex` is refused on purpose (one owner per hook), and `codex-wiring.test.ts` pins that refusal.
  // Nothing about the block's properties is weakened by naming `generic` instead.
  it('install preserves foreign content; re-install is byte-identical; uninstall removes only the block', () => {
    const root = project('advisory');
    const file = path.join(root, 'AGENTS.md');
    const original = '# Project rules\n\nKeep this line.\n';
    fs.writeFileSync(file, original);

    const r1 = canary(['agents', 'install', 'generic', root]);
    assert.equal(r1.status, 0, r1.stderr);
    const after1 = fs.readFileSync(file, 'utf8');
    assert.ok(after1.startsWith(original), 'existing content must be preserved verbatim');
    assert.ok(after1.includes(ADVISORY_BEGIN) && after1.includes(ADVISORY_END));

    const r2 = canary(['agents', 'install', 'generic', root]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), after1, 'a second install must change nothing');

    const r3 = canary(['agents', 'uninstall', 'generic', root]);
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

  it('the GATING integrations are owned by setup, not by an advisory command', () => {
    for (const id of ['claude-code', 'codex']) {
      const root = project(`gating-${id}`);
      const r = canary(['agents', 'install', id, root]);
      assert.equal(r.status, 2, `${id} must not be installable as an advisory block`);
      assert.match(r.stdout + r.stderr, /GATING integration/);
      assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false, 'a refusal must write nothing');
    }
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
    const r = canary(['agents', 'install', 'generic', root]);
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
    // v1.4 — declare the harness IN THE FIXTURE (see the note in the sibling test above):
    // detection reads `<root>/.claude` or the operator's `~/.claude`, so without this the
    // test asserted exit 0 on a host that happened to have Claude Code installed.
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
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
    // v1.3 §C/§E — the tool registration is announced WITH the one interactive step the harness owns.
    // MEASURED with the real agent CLI: `claude mcp list` reports Canary's entry as "Pending approval"
    // until a human approves the project's MCP server, so both surfaces must say so. Without this a
    // user sees a registered server whose tools never appear and concludes the integration is broken.
    assert.match(s.stdout, /agent tools: registered in \.mcp\.json/);
    assert.match(s.stdout, /approve a project's MCP server once/);
    assert.match(r.stdout, /pending approval/);
  });

  it('v1.4: a Codex project layer with no hook is a capability, never a protected repository', () => {
    // Same question as the Claude Code test above, asked of the second adapter: `.codex/` in the
    // project is what makes this a Codex project (and it is where a project-local hook would load),
    // and detection alone must still not be readable as protection.
    const root = project('codex-no-hook');
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    const r = canary(['agents', root]);
    assert.equal(r.status, 2, `detection alone must not be reported as protection:\n${r.stdout}`);
    assert.match(r.stdout, /GATED\s+OpenAI Codex CLI/);
    assert.match(r.stdout, /hook NOT installed here/);
    assert.doesNotMatch(r.stdout, /CONNECTED/, 'the word CONNECTED is a claim about wiring');
    assert.match(r.stdout, /canary setup/);
  });

  it('v1.4: an installed Codex hook is reported WITH the trust step Canary does not own', () => {
    const root = path.join(TMP, 'codex-hooked');
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true }); // declare the harness in the fixture
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'codex-hooked',
      scripts: { test: `node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', 'f-pass.js')}"` },
    }, null, 2));
    spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'agents@canary.local'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Agents'], { cwd: root });

    const s = canary(['setup', '--yes', root]);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    // The hook file exists and gates nothing until the user trusts it — setup says both halves.
    assert.ok(fs.existsSync(path.join(root, '.codex', 'hooks.json')));
    assert.match(s.stdout, /will NOT run it until you review and trust it once/);
    assert.match(s.stdout, /\/hooks/);

    const r = canary(['agents', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /GATED\s+OpenAI Codex CLI/);
    assert.match(r.stdout, /hook installed here/);
    assert.match(r.stdout, /one-time review and trust/, 'the remaining human step rides the GATED row');
    const env = JSON.parse(canary(['agents', '--json', root]).stdout) as {
      integrations: Array<{ id: string; gating: boolean; gatingNeedsTrust?: string }>;
    };
    const codex = env.integrations.find((i) => i.id === 'codex');
    assert.equal(codex?.gating, true);
    assert.match(String(codex?.gatingNeedsTrust), /trust/);
  });
});
