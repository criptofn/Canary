/**
 * v1.4 §C — OpenAI Codex CLI is a SECOND gating adapter, wired by `setup`, pruned by `uninstall`.
 *
 * The risk this file pins is not whether the hook works — the hook IS the same `canary checkpoint`
 * Claude Code already runs, and `tooling/probes/v14-codex-stop-hook.mjs` drives it exactly as Codex
 * documents it. The risk is that gating a second harness makes Canary write ONE MORE FILE into a
 * user's repository, and that `.codex/hooks.json` is a file the USER may already own. So every
 * property the Claude Code writer already has must hold here, and the failure directions matter:
 *
 *   - a stranger's hook, matcher group, event or top-level key is never touched;
 *   - only commands THIS installation recorded for THIS file are ever pruned, so a user's own
 *     `canary checkpoint` line (or another installation's) is not mistaken for ours;
 *   - a re-run is byte-identical and never stacks a second handler;
 *   - a link — the file, or the whole `.codex/` layer — is refused with nothing written;
 *   - `uninstall` removes exactly Canary's handler, and deletes the file only when Canary's entry was
 *     the only thing in a file Canary created.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation

import {
  buildHookCommand, codexHooksPath, hasCanaryEntry, installCodexStopHook, ownedCommandsFor,
  uninstallHooks, type CanaryConfig,
} from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);
const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-codex-wiring-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const repo = (): string => {
  const root = path.join(TMP, `repo-${seq++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
};
/** The command under test: built by the SAME builder the Claude Code hook uses (no second shapes). */
const COMMAND = buildHookCommand('C:\\fake\\canary\\main.js') as string;
const OTHER = 'node "C:\\fake\\other\\main.js" checkpoint';
const backups = (root: string): string => path.join(root, '.canary', 'backups');
const read = (root: string): Record<string, unknown> => JSON.parse(fs.readFileSync(codexHooksPath(root), 'utf8')) as Record<string, unknown>;
const write = (root: string, doc: unknown): void => {
  fs.mkdirSync(path.dirname(codexHooksPath(root)), { recursive: true });
  fs.writeFileSync(codexHooksPath(root), JSON.stringify(doc, null, 2) + '\n');
};
/** Every Stop handler in the file, as plain objects (the vendor's event → group → handler shape). */
const stopHandlers = (root: string): Array<Record<string, unknown>> => {
  const hooks = (read(root).hooks ?? {}) as Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
  return (hooks.Stop ?? []).flatMap((g) => g.hooks ?? []);
};
const irrelevant = { command: 'node "C:\\their\\tool.js"', timeout: 5 };
const strangerDoc = (): Record<string, unknown> => ({
  description: 'my own hooks',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node session.js' }] }],
    Stop: [{ hooks: [irrelevant] }],
  },
  somethingElse: { keep: ['me'] },
});

describe('v1.4 Codex wiring: the Stop hook is written into the project layer, once', () => {
  it('writes exactly one Stop handler running THIS Canary, with a bounded timeout and a status message', () => {
    const root = repo();
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    assert.equal(res.ok, true, res.problem);
    assert.equal(res.touched?.kind, 'codex-hooks', 'the ownership record names the file kind');
    assert.equal(res.touched?.created, true);
    const handlers = stopHandlers(root);
    assert.equal(handlers.length, 1);
    assert.deepEqual(handlers[0], {
      // the same shape Claude Code gets: {type, command, timeout}
      type: 'command',
      command: COMMAND,
      timeout: 1800,
      statusMessage: "Canary is running this project's sealed checks",
    });
    assert.match(COMMAND, /checkpoint$/, 'the hook runs the ONE existing checkpoint entry point');
  });

  it("preserves a user's other hooks, groups and top-level keys untouched, and adds ours beside them", () => {
    const root = repo();
    const before = strangerDoc();
    write(root, before);
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    assert.equal(res.ok, true, res.problem);
    assert.equal(res.touched?.created, false);
    const doc = read(root);
    assert.equal(doc.description, 'my own hooks');
    assert.deepEqual(doc.somethingElse, { keep: ['me'] });
    assert.deepEqual((doc.hooks as Record<string, unknown>).SessionStart, before.hooks && (before.hooks as Record<string, unknown>).SessionStart);
    const handlers = stopHandlers(root);
    assert.equal(handlers.length, 2, 'theirs and ours');
    assert.deepEqual(handlers[0], irrelevant, 'their handler is byte-identical');
    assert.equal(handlers[1]!.command, COMMAND);
  });

  it('a re-run is byte-identical and never stacks a second Canary handler', () => {
    const root = repo();
    write(root, strangerDoc());
    installCodexStopHook(root, COMMAND, new Set(), backups(root));
    const first = fs.readFileSync(codexHooksPath(root), 'utf8');
    const owned = new Set([COMMAND]);
    assert.equal(installCodexStopHook(root, COMMAND, owned, backups(root)).ok, true);
    assert.equal(fs.readFileSync(codexHooksPath(root), 'utf8'), first, 'setup twice changes nothing');
    assert.equal(stopHandlers(root).filter((h) => h.command === COMMAND).length, 1);
  });

  it('an earlier installation command is pruned on re-setup, so a moved CLI never leaves a stale handler', () => {
    const root = repo();
    write(root, { hooks: { Stop: [{ hooks: [{ type: 'command', command: OTHER }] }] } });
    const res = installCodexStopHook(root, COMMAND, new Set([OTHER]), backups(root));
    assert.equal(res.ok, true, res.problem);
    const handlers = stopHandlers(root);
    assert.deepEqual(handlers.map((h) => h.command), [COMMAND]);
  });

  it('refuses invalid JSON, a non-object hooks section and a non-list Stop — writing nothing', () => {
    const bad = repo();
    fs.mkdirSync(path.dirname(codexHooksPath(bad)), { recursive: true });
    fs.writeFileSync(codexHooksPath(bad), '{ not json');
    const r1 = installCodexStopHook(bad, COMMAND, new Set(), backups(bad));
    assert.equal(r1.ok, false);
    assert.match(String(r1.problem), /not valid JSON/);
    assert.equal(fs.readFileSync(codexHooksPath(bad), 'utf8'), '{ not json');

    const shaped = repo();
    write(shaped, { hooks: ['not', 'an', 'object'] });
    const r2 = installCodexStopHook(shaped, COMMAND, new Set(), backups(shaped));
    assert.equal(r2.ok, false);
    assert.match(String(r2.problem), /"hooks"/);

    const stop = repo();
    write(stop, { hooks: { Stop: 'not a list' } });
    const r3 = installCodexStopHook(stop, COMMAND, new Set(), backups(stop));
    assert.equal(r3.ok, false);
    assert.match(String(r3.problem), /"hooks\.Stop"/);
  });

  it('backs up the file it is about to change', () => {
    const root = repo();
    write(root, strangerDoc());
    installCodexStopHook(root, COMMAND, new Set(), backups(root));
    const kept = fs.readdirSync(backups(root));
    assert.equal(kept.length, 1);
    assert.match(kept[0]!, /-hooks\.json$/);
    // the backup is the PREVIOUS bytes, not a copy of what we just wrote
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backups(root), kept[0]!), 'utf8')), strangerDoc());
  });
});

describe('v1.4 Codex wiring: nothing is written through a link, and never outside the repo', () => {
  it('refuses a linked hooks.json', () => {
    const root = repo();
    const outside = path.join(TMP, 'linked-file-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.symlinkSync(outside, codexHooksPath(root), 'junction'); // a junction needs no elevation
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    assert.equal(res.ok, false);
    assert.match(String(res.problem), /symbolic link/);
  });

  it('refuses a linked .codex LAYER, so the hook cannot land outside the repository', () => {
    const root = repo();
    const outside = path.join(TMP, 'linked-layer-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.codex'), 'junction');
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    assert.equal(res.ok, false);
    assert.match(String(res.problem), /resolves outside this repository/);
    assert.equal(fs.existsSync(path.join(outside, 'hooks.json')), false, 'nothing was created outside the repo');
  });

  it('refuses when .codex exists as a plain file instead of a directory', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, '.codex'), 'not a directory');
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    assert.equal(res.ok, false);
    assert.match(String(res.problem), /not a directory/);
    assert.equal(fs.readFileSync(path.join(root, '.codex'), 'utf8'), 'not a directory');
  });
});

describe('v1.4 Codex wiring: uninstall undoes exactly what setup did', () => {
  const config = (root: string, touched: CanaryConfig['touched']): CanaryConfig => ({
    version: 'product-0.1', installedAt: '2026-01-01T00:00:00.000Z', pm: 'npm', plan: [],
    cliPath: CLI, hookCommand: COMMAND, hookCommands: [COMMAND], codexHookCommands: [COMMAND], touched,
  });

  it("removes Canary's handler and keeps the user's, leaving the file in place", () => {
    const root = repo();
    write(root, strangerDoc());
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    assert.equal(res.ok, true, res.problem);
    const out = uninstallHooks(root, config(root, [res.touched!]));
    assert.deepEqual(out.problems, []);
    assert.equal(out.removed, 1);
    assert.deepEqual(stopHandlers(root), [irrelevant]);
    assert.equal(read(root).description, 'my own hooks', 'unrelated keys survive');
  });

  it('deletes the file it created when nothing else is left in it', () => {
    const root = repo();
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    const out = uninstallHooks(root, config(root, [res.touched!]));
    assert.equal(out.removed, 1);
    assert.equal(fs.existsSync(codexHooksPath(root)), false, 'a file Canary created and emptied is removed');
  });

  it('keeps a file the USER already had, even when our handler was the only thing in it', () => {
    const root = repo();
    write(root, { hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND }] }] } });
    const res = installCodexStopHook(root, COMMAND, new Set([COMMAND]), backups(root));
    assert.equal(res.touched?.created, false);
    const out = uninstallHooks(root, config(root, [res.touched!]));
    assert.equal(out.removed, 1);
    assert.equal(fs.existsSync(codexHooksPath(root)), true, 'the user authored this file — it stays');
    assert.equal(read(root).hooks, undefined, 'and it is left valid JSON, with no empty hooks section');
  });

  it('ownership is the recorded COMMAND, not the file: a stranger running the same tool is untouched', () => {
    const root = repo();
    // A user's own handler that runs a DIFFERENT canary/checkpoint program must survive; only the
    // exact recorded command is ours. (The `mcp-wiring` file pins the same rule for argv signatures.)
    write(root, { hooks: { Stop: [{ hooks: [{ type: 'command', command: OTHER }] }] } });
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    assert.equal(res.ok, true, res.problem);
    assert.equal(hasCanaryEntry(strangerDoc(), new Set([COMMAND])), false, 'the key name proves nothing');
    const out = uninstallHooks(root, config(root, [res.touched!]));
    assert.equal(out.removed, 1);
    assert.deepEqual(stopHandlers(root).map((h) => h.command), [OTHER]);
  });

  it('a config with no Codex ownership record prunes nothing here (separate list, separate file)', () => {
    const root = repo();
    const res = installCodexStopHook(root, COMMAND, new Set(), backups(root));
    const legacy = { ...config(root, [res.touched!]) } as CanaryConfig;
    delete legacy.codexHookCommands;
    const out = uninstallHooks(root, legacy);
    assert.equal(out.removed, 0, 'a record that never named this file leaves it alone');
    assert.deepEqual(stopHandlers(root).map((h) => h.command), [COMMAND]);
    assert.deepEqual([...ownedCommandsFor(legacy, 'codex-hooks')], [], 'and the ownership set is empty');
  });
});

/**
 * The CLI surface, so the wiring is proven through the PRODUCT and not only through the writer:
 * detection (a project `.codex/` layer is a Codex project on any host), the trust disclosure, the
 * gating report, and the removal path.
 */
describe('v1.4 Codex wiring: setup wires it, agents reports it honestly, uninstall removes it', () => {
  /**
   * DETECTION MUST NOT DEPEND ON THE OPERATOR'S HOME. `detectHarnesses` reads `<root>/.claude`,
   * `<root>/.codex`, `~/.claude`, `~/.codex` and a trusted-directory executable scan — so every
   * spawn here gets a fresh EMPTY home plus a fixture that declares the harness it is about
   * (`.codex/` for Codex, `.claude/` where Claude Code is wanted). MEASURED while writing this:
   * without it, this host's real `~/.claude` wired Claude Code into the Codex-only fixture and the
   * "setup must not claim the harness that is not here" assertion failed for the wrong reason.
   */
  const HOME = path.join(TMP, 'empty-home');
  fs.mkdirSync(HOME, { recursive: true });
  const canary = (args: string[], cwd: string) => spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, USERPROFILE: HOME, HOME },
  });
  const project = (name: string, opts: { codex?: boolean; claude?: boolean } = {}): string => {
    const root = path.join(TMP, name);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name, scripts: { test: `node "${path.join(FIXTURES, 'f-pass.js')}"` },
    }, null, 2));
    if (opts.codex !== false) fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    if (opts.claude) fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    return root;
  };

  it('setup writes the Codex hook when Codex is the harness, and says the trust step out loud', () => {
    const root = project('codex-only');
    const s = canary(['setup', '--yes'], root);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.equal(stopHandlers(root).filter((h) => h.command === (buildHookCommand(CLI) as string)).length, 1);
    // the trust requirement is REAL friction and is never left implicit
    assert.match(s.stdout, /will NOT run it until you review and trust it once/);
    assert.match(s.stdout, /\/hooks/);
    // and setup must not claim the harness that is not here
    assert.doesNotMatch(s.stdout, /Claude Code will run Canary automatically/);
  });

  it('agents reports GATED with the trust step on the row, and doctor/status stay green', () => {
    const root = project('codex-agents');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const a = canary(['agents'], root);
    assert.equal(a.status, 0, a.stdout);
    assert.match(a.stdout, /GATED\s+OpenAI Codex CLI/);
    assert.match(a.stdout, /hook installed here/);
    assert.match(a.stdout, /one-time review and trust/);
    assert.match(a.stdout, /CONNECTED/);
    const env = JSON.parse(canary(['agents', '--json'], root).stdout) as {
      integrations: Array<{ id: string; gating: boolean; gatingMeasured?: boolean; gatingNeedsTrust?: string }>;
    };
    const codex = env.integrations.find((i) => i.id === 'codex');
    assert.equal(codex?.gating, true);
    assert.equal(codex?.gatingMeasured, true, 'measured, not merely documented');
    assert.match(String(codex?.gatingNeedsTrust), /trust/);
    assert.equal(canary(['status'], root).status, 0);
    assert.equal(canary(['doctor'], root).status, 0);
  });

  it('uninstall removes the handler and the file setup created, and nothing else', () => {
    const root = project('codex-uninstall');
    // a user hook that must survive the whole round trip
    write(root, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } });
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    assert.equal(stopHandlers(root).length, 2);
    const u = canary(['uninstall'], root);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.deepEqual(stopHandlers(root).map((h) => h.command), ['echo user-hook']);
    assert.equal(fs.existsSync(codexHooksPath(root)), true, 'the user had this file before Canary did');
    assert.equal(fs.existsSync(path.join(root, '.canary')), false);
    assert.equal(canary(['uninstall'], root).status, 0, 'a second uninstall is safe');
  });

  /**
   * CLAUDE CODE MUST NOT MOVE. `setup` now wires every integrable harness it finds, so this pins the
   * OLD behaviour for a repository where Codex is simply not present: the Claude settings entry keeps
   * its exact shape, the config gains no Codex record, `.codex/` is not created, and not one line of
   * output mentions Codex. Without this, "Claude Code behaviour is byte-identical" would be a claim
   * nobody measures — and the extra `say()` lines Codex adds would be invisible collateral.
   */
  it('a Claude-only repository is wired exactly as before: no Codex file, no Codex record, no Codex prose', () => {
    const root = path.join(TMP, 'claude-only');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true }); // the harness, declared in the fixture
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'claude-only', scripts: { test: `node "${path.join(FIXTURES, 'f-pass.js')}"` },
    }, null, 2));
    spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    const s = canary(['setup', '--yes'], root);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.equal(fs.existsSync(path.join(root, '.codex')), false, 'no Codex layer may be created for a Codex-less repo');
    assert.doesNotMatch(s.stdout, /Codex/, 'a Claude-only setup must not talk about Codex');
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<Record<string, unknown>> }> };
    };
    assert.deepEqual(doc.hooks.Stop, [{ hooks: [{ type: 'command', command: buildHookCommand(CLI), timeout: 1800 }] }],
      'the Claude entry keeps its exact 1.3 shape');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8')) as CanaryConfig & { codexHookCommands?: string[] };
    assert.equal(cfg.codexHookCommands, undefined, 'no Codex ownership record is written');
    assert.deepEqual(cfg.touched.map((t) => t.kind ?? 'hooks'), ['hooks', 'mcp'], 'exactly the two files 1.3 wrote');
  });
});
