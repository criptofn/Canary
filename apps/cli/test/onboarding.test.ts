/**
 * Productization contract tests (setup / doctor / uninstall / checkpoint).
 *
 * Mirrors cli.test.ts: pure logic in-process; user-visible behavior against
 * the BUILT CLI as a subprocess in throwaway git repos. Guards the promises
 * the onboarding doctrine makes: READY only with executed proof, exact-match
 * removal of Canary-owned entries only, malformed config never overwritten,
 * checkpoint blocks the agent on failure and never fakes green on infra.
 *
 * Project "scripts" under test reference fixture FILES in
 * tooling/test-support/fixtures by absolute path — never inline `node -e`
 * programs (approval-free workflow rule: automated tests execute known local
 * scripts, not dynamically constructed interpreter snippets).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-')); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import {
  detectPm, detectPlan, planWithFreshTests, isSafeScriptName, stepArgv, buildHookCommand, hasCanaryEntry, containedRealPath,
  writeConfig, readConfig, installStopHook,
  type CanaryConfig,
} from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = process.env.CANARY_TEST_CLI
  ? path.resolve(process.env.CANARY_TEST_CLI)
  : path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const fx = (f: string): string => `node "${path.join(FIXTURES, f)}"`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-onb-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function makeProject(name: string, opts: { testScript?: string; extraScripts?: Record<string, string>; claudeDir?: boolean; settings?: unknown | 'corrupt' } = {}): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // findRepoRoot only needs .git presence
  const scripts: Record<string, string> = { test: opts.testScript ?? fx('f-pass.js'), ...opts.extraScripts };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts }, null, 2));
  if (opts.claudeDir !== false) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    if (opts.settings === 'corrupt') fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{not json');
    else if (opts.settings) fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(opts.settings, null, 2));
  }
  return root;
}

const cfgFile = (root: string): string => path.join(root, '.canary', 'canary.local.json');
const readCfg = (root: string): CanaryConfig => JSON.parse(fs.readFileSync(cfgFile(root), 'utf8')) as CanaryConfig;
const writeCfg = (root: string, cfg: CanaryConfig): void => fs.writeFileSync(cfgFile(root), JSON.stringify(cfg));
const cpFile = (root: string): string => path.join(root, '.canary', 'last-checkpoint.json');

function canary(args: string[], cwd?: string, input?: string, env?: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: 'utf8', timeout: 120_000, env: env ? { ...process.env, ...env } : undefined,
  });
}
const stopCommands = (root: string): string[] => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as {
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  return (doc.hooks?.Stop ?? []).flatMap((g) => g.hooks.map((h) => h.command));
};

describe('detection (pure)', () => {
  it('lockfiles pick the package manager, first match wins in declared order', () => {
    const r = fs.mkdtempSync(path.join(TMP, 'pm-'));
    fs.writeFileSync(path.join(r, 'pnpm-lock.yaml'), '');
    assert.equal(detectPm(r).pm, 'pnpm');
    fs.writeFileSync(path.join(r, 'package-lock.json'), '');
    assert.equal(detectPm(r).pm, 'npm'); // npm-listed first — deterministic
    assert.equal(detectPm(fs.mkdtempSync(path.join(TMP, 'pm0-'))).pm, 'npm'); // no lockfile -> honest default
  });
  it('plan is conservative, ordered, and exact-name only', () => {
    const plan = detectPlan({ build: 'x', test: 'x', lint: 'x', pretest: 'x', 'type-check': 'x' });
    assert.deepEqual(plan.map((s) => s.kind), ['typecheck', 'build', 'tests']);
    assert.deepEqual(detectPlan({ lint: 'x' }), []);
  });
  it('legacy test-before-build plans repeat only their sealed tests after the final build', () => {
    const current = detectPlan({ build: 'x', test: 'x', 'type-check': 'x' });
    assert.deepEqual(planWithFreshTests(current), current, 'current discovery must not add work');
    const tests = current.find((step) => step.kind === 'tests')!;
    const build = current.find((step) => step.kind === 'build')!;
    const legacy = [tests, build];
    assert.deepEqual(planWithFreshTests(legacy), [tests, build, tests]);
    assert.deepEqual(legacy, [tests, build], 'sealed plan remains unchanged');
    assert.deepEqual(planWithFreshTests([tests]), [tests], 'no build means no repeat');
    assert.deepEqual(planWithFreshTests([build, tests, build]), [build, tests, build, tests]);
  });
  it('shell-shaped script names never enter a plan', () => {
    for (const bad of ['te;st', 'a b', 'x&&y', 'q"uote', '']) assert.ok(!isSafeScriptName(bad), bad);
    assert.throws(() => stepArgv('npm', 'rm -rf /'), /refused unsafe/);
    assert.throws(() => stepArgv('bash', 'test'), /refused unsafe/);
    assert.deepEqual(stepArgv('npm', 'test'), ['npm', 'run', 'test']);
  });
  it('a quote-bearing CLI path cannot be embedded — buildHookCommand refuses', () => {
    assert.equal(buildHookCommand('C:\\p"ath\\main.js'), null);
    assert.equal(buildHookCommand('C:\\plain path\\main.js'), 'node "C:\\plain path\\main.js" checkpoint');
  });
  it('containedRealPath: inside stays inside, outside resolves to null (S3 floor)', () => {
    const root = makeProject('contain');
    assert.ok(containedRealPath(root, path.join(root, '.canary', 'not-yet.json'))); // missing tail is safe once ancestor is contained
    assert.equal(containedRealPath(root, path.join(TMP, 'victim-x.json')), null); // exists outside root
    assert.equal(containedRealPath(root, path.join(root, '..', 'escape.json')), null); // outside even if missing
  });
});

describe('setup', () => {
  it('explains the task-scope limit when no acceptance criteria were registered', () => {
    const root = makeProject('setup-no-task-criteria');
    const setup = canary(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    assert.match(setup.stdout, /READY/);
    assert.match(setup.stdout, /no task acceptance criteria are registered/);
    assert.match(setup.stdout, /cannot assess requirements it was never given/);

    const registered = canary(['task', 'fix the behavior', '--requirement', 'preserve the documented result'], root);
    assert.equal(registered.status, 0, `${registered.stdout} ${registered.stderr}`);
    const withRequirement = canary(['setup', '--yes', root]);
    assert.equal(withRequirement.status, 0, `${withRequirement.stdout} ${withRequirement.stderr}`);
    assert.doesNotMatch(withRequirement.stdout, /no task acceptance criteria are registered/);
    assert.match(withRequirement.stdout, /registered 1 requirement/);
  });

  it('build-dependent tests pass on first setup and completion after clean, while compiled regressions stay blocked', () => {
    const root = makeProject('build-dependent', {
      testScript: `${fx('build-dependent-check.cjs')} test`,
      extraScripts: { build: `${fx('build-dependent-check.cjs')} build` },
    });
    fs.writeFileSync(path.join(root, 'implementation.json'), 'true\n');
    const setup = canary(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    assert.deepEqual(readCfg(root).plan.map((s) => s.kind), ['build', 'tests']);
    const orderFile = path.join(root, 'check-order.txt');
    assert.equal(fs.readFileSync(orderFile, 'utf8'), 'build\ntest\n');
    fs.rmSync(path.join(root, 'dist'), { recursive: true });
    const hookInput = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: root });
    assert.equal(canary(['checkpoint'], root, hookInput).stdout.trim(), '');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
    // A stale passing artifact must be rebuilt, then fail the real assertion.
    fs.writeFileSync(path.join(root, 'implementation.json'), 'false\n');
    const blocked = canary(['checkpoint'], root, hookInput);
    assert.equal(JSON.parse(blocked.stdout).decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    assert.equal(fs.readFileSync(path.join(root, 'dist/implementation.json'), 'utf8'), 'false\n');
    fs.writeFileSync(path.join(root, 'implementation.json'), 'true\n');
    assert.equal(canary(['doctor', root]).status, 0, 'repair rebuilds before testing stale failing output');
    // A build failure stays red even if an older artifact passes its tests.
    fs.writeFileSync(path.join(root, 'implementation.json'), 'BUILD_ERROR\n');
    const badBuild = canary(['checkpoint'], root, hookInput);
    assert.equal(JSON.parse(badBuild.stdout).decision, 'block');
    const failed = JSON.parse(fs.readFileSync(cpFile(root), 'utf8'));
    assert.equal(failed.status, 'fail');
    assert.deepEqual(failed.checks.map((s: { ok: boolean }) => s.ok), [false, true]);
    assert.equal(fs.readFileSync(orderFile, 'utf8'), 'build\ntest\n'.repeat(5));
  });

  it('an explicitly ordered test-before-build plan cannot certify stale artifacts at setup, doctor or Stop', () => {
    const root = path.join(TMP, 'declared-legacy-order');
    for (const dir of ['.git', '.claude', 'dist']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const fixture = path.join(FIXTURES, 'build-dependent-check.cjs');
    fs.writeFileSync(path.join(root, 'canary.project.json'), JSON.stringify({
      schema: 'canary-project/1', scopes: [{ path: '.', checks: [
        { name: 'tests', kind: 'tests', argv: [process.execPath, fixture, 'test'] },
        { name: 'build', kind: 'build', argv: [process.execPath, fixture, 'build'] },
      ] }],
    }));
    fs.writeFileSync(path.join(root, 'implementation.json'), 'true\n');
    fs.writeFileSync(path.join(root, 'dist/implementation.json'), 'true\n');
    const setup = canary(['setup', '--yes', root]);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.deepEqual(readCfg(root).plan.map((step) => step.kind), ['tests', 'build']);
    const originalConfig = fs.readFileSync(cfgFile(root));
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).checks.map((step: { ok: boolean }) => step.ok), [true, true, true]);
    fs.writeFileSync(path.join(root, 'implementation.json'), 'false\n');
    const doctor = canary(['doctor', root]);
    assert.equal(doctor.status, 2, doctor.stdout + doctor.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).checks.map((step: { ok: boolean }) => step.ok), [true, true, false]);
    fs.writeFileSync(path.join(root, 'dist/implementation.json'), 'true\n');
    const hook = canary(['checkpoint'], root, JSON.stringify({ cwd: root, stop_hook_active: false }));
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).decision, 'block');
    assert.deepEqual(fs.readFileSync(cfgFile(root)), originalConfig, 'execution cannot reseal the ordered plan');
  });

  it('colored Vitest collection failure reports the missing build and retains a block', () => {
    const root = makeProject('colored-vitest-collection', { testScript: `${fx('vitest-color-check.cjs')} collection` });
    const setup = canary(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    fs.writeFileSync(path.join(root, '.fixture-fail'), 'trigger collection failure');
    const r = canary(['checkpoint'], root, JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: root }));
    assert.equal(r.status, 0, r.stderr);
    const response = JSON.parse(r.stdout);
    assert.equal(response.decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    assert.match(response.reason, /help-drift\.test\.ts \[ tests\/unit\/cli\/help-drift\.test\.ts \]/);
    assert.match(response.reason, /Error: dist CLI not found\. Run npm run build before npm test\./);
    assert.match(response.reason, /help-drift\.test\.ts:37:9/);
    assert.doesNotMatch(response.reason, /expected caught error|passing\.test\.ts/);
  });

  it('colored Vitest completion failure names the test and source location while preserving the red gate and raw log', () => {
    const root = makeProject('colored-vitest-failure', { testScript: fx('vitest-color-check.cjs') });
    const setup = canary(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    fs.writeFileSync(path.join(root, '.fixture-fail'), 'trigger the controlled failure');
    const r = canary(['checkpoint'], root, JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: root }));
    assert.equal(r.status, 0, r.stderr);
    const response = JSON.parse(r.stdout);
    assert.equal(response.decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    assert.match(response.reason, /failure-ids\.test\.ts > extractFailureIds > preserves hyphenated params/);
    assert.match(response.reason, /AssertionError: expected false to be true/);
    assert.match(response.reason, /failure-ids\.test\.ts:42:9/);
    assert.match(response.reason, /doctor --check test/);
    assert.doesNotMatch(response.reason, /passing\.test\.ts/);
    const log = response.reason.split('full output: ')[1]?.split('\n')[0];
    assert.ok(log && fs.existsSync(log));
    assert.ok(fs.readFileSync(log, 'utf8').includes('\x1b[41m'), 'raw evidence keeps the runner color bytes');
  });

  it('startup context gives a finish workflow without executing checks, survives retry and preserves foreign startup hooks', () => {
    const userStart = 'echo user-startup';
    const root = makeProject('startup-context', { settings: { theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: userStart }] }] } } });
    const marker = path.join(root, 'startup-ran-check.txt');
    const runner = path.join(root, 'check.cjs');
    fs.copyFileSync(path.join(FIXTURES, 'setup-check-marker.js'), runner);
    const pkg = { scripts: { test: `node "${runner}" "${marker}"` } };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    for (const n of [1, 2]) { const r = canary(['setup', '--yes', root]); assert.equal(r.status, 0, `setup ${n}: ${r.stdout} ${r.stderr}`); }
    fs.rmSync(marker);
    const before = fs.readFileSync(cpFile(root));
    const invoke = () => canary(['checkpoint', '--session-start'], root, JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }));
    const r = invoke();
    assert.equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /finish.*normally/i);
    assert.match(context, /scripts\.test/);
    assert.match(context, /not a verification result/i);
    assert.match(context, /file or case filter for early feedback/i);
    assert.match(context, /full sealed checks at completion/i);
    assert.ok(context.includes(CLI), 'repair command must name the installed CLI');
    assert.equal(fs.existsSync(marker), false, 'startup must not execute the sealed check');
    assert.deepEqual(fs.readFileSync(cpFile(root)), before, 'startup must not write a verification result');
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    const starts = settings.hooks.SessionStart.flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks);
    assert.equal(starts.filter((hook: { command: string }) => hook.command.endsWith('checkpoint --session-start')).length, 1);
    assert.equal(starts.filter((hook: { command: string }) => hook.command === userStart).length, 1);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node unsealed.js' } }));
    assert.equal(invoke().stdout.trim(), '', 'startup must not advertise a changed command as sealed');
    assert.deepEqual(fs.readFileSync(cpFile(root)), before);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    assert.equal(canary(['uninstall', root]).status, 0);
    const remaining = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    assert.equal(remaining.theme, 'dark');
    assert.deepEqual(remaining.hooks.SessionStart.flatMap((group: { hooks: unknown[] }) => group.hooks), [{ type: 'command', command: userStart }]);
  });

  it('startup preflight refuses malformed SessionStart hooks without replacing user settings', () => {
    const root = makeProject('startup-malformed', { settings: { hooks: { SessionStart: 'not a list' } } });
    const file = path.join(root, '.claude/settings.json'), before = fs.readFileSync(file);
    const result = canary(['setup', '--yes', root]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /SessionStart/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(cfgFile(root)), false);
  });

  it('startup guidance cannot clear a failing completion gate', () => {
    const root = makeProject('startup-red-gate', { testScript: fx('f-boom.js') });
    assert.equal(canary(['setup', '--yes', root]).status, 2);
    const before = fs.readFileSync(cpFile(root));
    const startup = canary(['checkpoint', '--session-start'], root, JSON.stringify({ hook_event_name: 'SessionStart' }));
    assert.equal(JSON.parse(startup.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
    assert.deepEqual(fs.readFileSync(cpFile(root)), before);
    const stopped = canary(['checkpoint'], root, JSON.stringify({ cwd: root, hook_event_name: 'Stop', stop_hook_active: false }));
    assert.equal(JSON.parse(stopped.stdout).decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
  });

  it('setup --check is read-only and never executes the planned project command', () => {
    const root = makeProject('preflight');
    const marker = path.join(root, 'project-command-ran.txt');
    const script = path.join(root, 'setup-check-marker.js');
    fs.copyFileSync(path.join(FIXTURES, 'setup-check-marker.js'), script);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.test = `node "${script}" "${marker}"`;
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    const r = canary(['setup', '--check', '--json', root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const env = JSON.parse(r.stdout) as { schema: string; status: string; setupCheck: { plan: unknown[]; harnesses: unknown[]; limitations: string[] } };
    assert.equal(env.schema, 'canary-setup-check/1');
    assert.equal(env.status, 'SETUP ELIGIBLE');
    assert.equal(env.setupCheck.plan.length, 1);
    assert.ok(env.setupCheck.harnesses.length > 0);
    assert.ok(env.setupCheck.limitations.some((x) => /project command was run/i.test(x)));
    assert.equal(fs.existsSync(marker), false, 'preflight must not run the planned test script');
    assert.equal(fs.existsSync(path.join(root, '.canary')), false, 'preflight must not create Canary state');
    assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.json')), false, 'preflight must not install a hook');
    assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false, 'preflight must not write MCP settings');
  });

  it('setup --check reports hook and MCP merge conflicts without changing either file', () => {
    const root = makeProject('preflight-conflicts', { settings: 'corrupt' });
    const settings = path.join(root, '.claude', 'settings.json');
    const mcp = path.join(root, '.mcp.json');
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { canary: { command: 'node', args: ['foreign.js'] } } }));
    const beforeSettings = fs.readFileSync(settings, 'utf8');
    const beforeMcp = fs.readFileSync(mcp, 'utf8');
    const r = canary(['setup', '--check', '--json', root]);
    assert.equal(r.status, 2);
    const env = JSON.parse(r.stdout) as { status: string; problems: string[] };
    assert.equal(env.status, 'SETUP NEEDS ATTENTION');
    assert.ok(env.problems.some((x) => /Claude Code hook/.test(x)));
    assert.ok(env.problems.some((x) => /MCP tools/.test(x)));
    assert.equal(fs.readFileSync(settings, 'utf8'), beforeSettings);
    assert.equal(fs.readFileSync(mcp, 'utf8'), beforeMcp);
    assert.equal(fs.existsSync(path.join(root, '.canary')), false);
  });

  it('restores every integration file when authority sealing fails after setup writes them', () => {
    const root = makeProject('setup-rollback', { settings: { theme: 'dark' } });
    const codexDir = path.join(root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const codexHooks = path.join(codexDir, 'hooks.json');
    const codexDoc = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-codex' }] }] } };
    fs.writeFileSync(codexHooks, JSON.stringify(codexDoc));
    const settings = path.join(root, '.claude', 'settings.json');
    const mcp = path.join(root, '.mcp.json');
    const mcpDoc = { mcpServers: { teammate: { command: 'node', args: ['teammate.js'] } } };
    fs.writeFileSync(mcp, JSON.stringify(mcpDoc));
    const before = [settings, codexHooks, mcp].map((file) => fs.readFileSync(file));
    const blockedStore = path.join(TMP, 'trust-store-is-a-file');
    fs.writeFileSync(blockedStore, 'not a directory');

    const result = canary(['setup', '--yes', root], undefined, undefined, { CANARY_TRUST_STORE: blockedStore });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /could not store its verification record/i);
    assert.match(result.stdout, /verified NOTHING: no project checks were run/i);
    for (const [index, file] of [settings, codexHooks, mcp].entries()) {
      assert.deepEqual(fs.readFileSync(file), before[index], `${path.basename(file)} must be restored byte-for-byte`);
    }
    assert.equal(fs.existsSync(cfgFile(root)), false, 'failed setup must not leave an active Canary config');
  });

  it('an explicitly selected expert MCP profile survives setup re-runs', () => {
    const root = makeProject('expert-profile');
    const first = canary(['setup', '--mcp-profile', 'expert', '--yes', root]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const mcpPath = path.join(root, '.mcp.json');
    const readProfile = (): string[] => ((JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as {
      mcpServers: { canary: { args: string[] } };
    }).mcpServers.canary.args);
    assert.deepEqual(readProfile().slice(-2), ['--profile', 'expert']);
    const cfg = JSON.parse(fs.readFileSync(cfgFile(root), 'utf8')) as CanaryConfig;
    assert.equal(cfg.mcpProfile, 'expert');
    const second = canary(['setup', '--yes', root]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.deepEqual(readProfile().slice(-2), ['--profile', 'expert']);
  });

  it('happy path: READY, hook registered, evidence written, user repo untouched otherwise', () => {
    const root = makeProject('ok', { extraScripts: { build: fx('f-pass.js') }, settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } } });
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /READY/);
    assert.match(r.stdout, /✓ tests: npm run test/);
    const cmds = stopCommands(root);
    assert.equal(cmds.filter((c) => c.includes('checkpoint')).length, 1);
    assert.equal(cmds.filter((c) => c === 'echo user-hook').length, 1); // merge, not clobber
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
    assert.equal(readCfg(root).mcpProfile, 'everyday');
    const mcpArgs = ((JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: { canary: { args: string[] } };
    }).mcpServers.canary.args);
    assert.deepEqual(mcpArgs.slice(-2), ['--profile', 'everyday']);
    assert.equal(fs.readFileSync(path.join(root, '.canary', '.gitignore'), 'utf8'), '*\n');
  });
  it('re-run is idempotent: one Canary entry, no duplicates, user entry preserved', () => {
    const root = makeProject('idem');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cmds = stopCommands(root);
    assert.equal(cmds.filter((c) => c.includes('checkpoint')).length, 1);
  });
  it('malformed settings.json: refuse, exit NEEDS ATTENTION, bytes untouched', () => {
    const root = makeProject('corrupt', { settings: 'corrupt' });
    const before = fs.readFileSync(path.join(root, '.claude', 'settings.json'));
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /not valid JSON/);
    assert.match(r.stdout, /NEEDS ATTENTION/);
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), before);
  });
  it('S5: valid JSON with a non-list hooks section gets a plain-words refusal, not an internal crash', () => {
    for (const [name, settings] of [['s5a', { hooks: 'nope' }], ['s5b', { hooks: { Stop: 'nope' } }]] as const) {
      const root = makeProject(name, { settings });
      const before = fs.readFileSync(path.join(root, '.claude', 'settings.json'));
      const r = canary(['setup', '--yes', root]);
      assert.equal(r.status, 2, `${name}: expected refusal, got ${r.status}: ${r.output.join('')}`);
      assert.doesNotMatch(r.stderr, /TypeError|not a function/); // was: exit 3 "stop.push is not a function"
      assert.match(r.stdout, name === 's5a' ? /"hooks" section that is not a settings object/ : /"hooks\.Stop" that is not a list/);
      assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), before);
    }
  });
  it('failing project checks never print READY (NO PROOF, NO DONE)', () => {
    const root = makeProject('failing', { testScript: fx('f-boom.js') });
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /NEEDS ATTENTION/);
    assert.doesNotMatch(r.stdout, /^READY/m);
    assert.match(r.stdout, /boom: expected 1, got 2/); // loud, shows why
    assert.match(r.stdout, /your project's own checks did not pass/);
    // the evidence names WHAT failed (M6 pin: never an empty failed list)
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; failed: string[] };
    assert.equal(cp.status, 'fail');
    assert.ok(cp.failed.includes('tests'), `failed kinds: ${JSON.stringify(cp.failed)}`);
    // a repo whose checks fail must never read as protected — doctor agrees
    const d = canary(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /NEEDS ATTENTION/);
    assert.doesNotMatch(d.stdout, /READY/);
    const cp2 = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; failed: string[] };
    assert.equal(cp2.status, 'fail');
    assert.ok(cp2.failed.includes('tests')); // doctor records real kinds too
  });
  it('unattended without --yes: the smoke test RUNS (like doctor always does) — READY only because checks actually passed', () => {
    // Master-pass S1: this branch used to write all state then exit 2 demanding
    // --yes. The flag guarded nothing doctor does not already do unasked.
    const root = makeProject('noyes');
    const r = canary(['setup', root]);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /READY/);
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
    // executing is not forgiving: a failing project still never reads READY
    const bad = makeProject('noyes-fail', { testScript: fx('f-boom.js') });
    const rb = canary(['setup', bad]);
    assert.equal(rb.status, 2);
    assert.doesNotMatch(rb.stdout, /^READY/m);
  });
  it('S4: re-setup under byte-identical authority keeps the stamps; a real script change re-seals with fresh ones', () => {
    const root = makeProject('stamps');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfgPath = path.join(root, '.canary', 'canary.local.json');
    const c1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { installedAt: string; planAuthority: { at: string }; baseline: { at: string } };
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const c2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as typeof c1;
    assert.equal(c2.installedAt, c1.installedAt); // approval timestamps record the APPROVAL, not the last invocation
    assert.equal(c2.planAuthority.at, c1.planAuthority.at);
    assert.equal(c2.baseline.at, c1.baseline.at);
    // sealed script TEXT changes = a genuine re-seal = honest fresh stamps
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.test = fx('f-boom.js');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    assert.equal(canary(['setup', '--yes', root]).status, 2); // boom runs, fails; config was already rewritten
    const c3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as typeof c1;
    assert.notEqual(c3.installedAt, c1.installedAt);
    assert.notEqual(c3.planAuthority.at, c1.planAuthority.at);
  });
  it('no supported harness: explicit message, not a fake integration', () => {
    const root = makeProject('noharness', { claudeDir: false });
    const fakeHome = path.join(TMP, 'empty-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    const env = process.platform === 'win32' ? { USERPROFILE: fakeHome } : { HOME: fakeHome };
    const r = canary(['setup', '--yes', root], undefined, undefined, env);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no supported AI harness/i);
  });
  it('Windows path quoting survives E2E: a project path containing spaces onboards and self-checks', () => {
    const root = path.join(TMP, 'sp ace dir', 'my project');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sp-aced', scripts: { test: fx('f-pass.js') } }, null, 2));
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.match(canary(['doctor', root]).stdout, /READY/);
  });
});

describe('checkpoint (harness entry)', () => {
  const hookInput = (root: string, active = false) => JSON.stringify({ cwd: root, stop_hook_active: active, hook_event_name: 'Stop' });
  it('pass -> silent allow (human never interrupted)', () => {
    const root = makeProject('cp-ok');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const r = canary(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; checks: Array<{ ok: boolean }>; hookResponse: string; sessionEnd: string };
    assert.equal(cp.status, 'pass');
    assert.deepEqual(cp.checks.map((x) => x.ok), [true]);
    assert.equal(cp.hookResponse, 'continued');
    assert.equal(cp.sessionEnd, 'unknown');
  });
  it('failure -> decision:block with the reason (agent gets a repair turn)', () => {
    const root = makeProject('cp-fail', { testScript: fx('f-needs.js') });
    canary(['setup', '--yes', root]);
    const r = canary(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(out.decision, 'block');
    // The reason is the MODEL-VISIBLE repair instruction, and it is bounded on purpose
    // (`failure-payload.ts`): 4000 characters of raw runner output became a compact payload.
    // The assertion therefore pins what the payload PROMISES the model — the failing check,
    // the command and exit code, a repair instruction, and where the full log is — rather
    // than the old prose wording it used to carry.
    assert.match(out.reason, /Canary verification failed/);
    assert.match(out.reason, /tests/);
    assert.match(out.reason, /npm run test/);
    assert.match(out.reason, /exit 1/);
    assert.match(out.reason, /Fix this before finishing/);
    assert.match(out.reason, /canary doctor --check test/);
    assert.match(out.reason, /full output: .+\.log/);
    assert.ok(out.reason.length <= 1200, `the model-visible payload must stay bounded, got ${out.reason.length} chars`);
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; checks: Array<{ ok: boolean }>; hookResponse: string };
    assert.equal(cp.status, 'fail');
    assert.deepEqual(cp.checks.map((x) => x.ok), [false]);
    assert.equal(cp.hookResponse, 'blocked');
  });
  it('loop guard: stop_hook_active allows with an honest systemMessage, never re-blocks', () => {
    const root = makeProject('cp-loop', { testScript: fx('f-fail.js') });
    canary(['setup', '--yes', root]);
    const r = canary(['checkpoint'], root, hookInput(root, true));
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage ?? '', /still failing/);
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; hookResponse: string; sessionEnd: string };
    assert.equal(cp.status, 'fail');
    assert.equal(cp.hookResponse, 'message-and-continue');
    assert.equal(cp.sessionEnd, 'unknown');
  });
  it('scoped failures keep separate logs and recover through PARTIAL rechecks to a full proven completion', () => {
    const root = makeProject('cp-scoped-repair');
    fs.rmSync(path.join(root, 'package.json'));
    const scopes = ['backend', 'front end'];
    for (const scope of scopes) {
      const dir = path.join(root, scope);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: scope.replace(/ /g, '-'), version: '1.0.0', scripts: { test: fx('f-regression.cjs') } }));
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = false;\n');
      fs.writeFileSync(path.join(dir, 'tests', 'regression.expected.json'), 'true\n');
    }
    fs.writeFileSync(path.join(root, 'canary.scopes.json'), JSON.stringify({ schema: 'canary-scopes/1', scopes: scopes.map((path) => ({ path, ecosystem: 'node' })) }));
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Canary Repair'], ['config', 'user.email', 'repair@canary.local'], ['add', '.'], ['commit', '-m', 'baseline']]) {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(canary(['setup', '--yes', root]).status, 2, 'the sealed baseline fails both assertions');
    const first = JSON.parse(canary(['checkpoint'], root, hookInput(root)).stdout) as { decision: string; reason: string };
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /canary doctor --check backend::test/);
    assert.ok(first.reason.includes("canary doctor --check 'front end::test'"), first.reason);
    const logs = [...first.reason.matchAll(/full output: (.+)$/gm)].map((match) => match[1]!);
    assert.equal(new Set(logs).size, 2);
    for (const [i, file] of logs.entries()) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.includes(scopes[i]!.replace(/ /g, '-')), `each pointer must show its own scoped run:\n${text}`);
      assert.match(text, /false !== true/);
    }
    const manifest = path.join(root, 'backend', 'package.json');
    const manifestBefore = fs.readFileSync(manifest);
    const marker = path.join(root, 'unsealed-command-ran');
    const changed = JSON.parse(manifestBefore.toString());
    changed.scripts.test = `${fx('setup-check-marker.js')} "${marker}"`;
    fs.writeFileSync(manifest, JSON.stringify(changed));
    const drift = JSON.parse(canary(['checkpoint'], root, hookInput(root)).stdout);
    assert.equal(drift.decision, 'block');
    assert.match(drift.reason, /verification authority changed/);
    assert.match(drift.reason, /backend::test.*changed since setup sealed it/);
    const unrelated = canary(['doctor', '--check', 'front end::test', '--json', root]);
    assert.equal(unrelated.status, 2, 'a partial recheck must not hide drift in another scoped check');
    assert.notEqual(JSON.parse(unrelated.stdout).status, 'PARTIAL');
    assert.equal(fs.existsSync(marker), false, 'the unsealed command must never run');
    fs.writeFileSync(manifest, manifestBefore);
    fs.writeFileSync(path.join(root, 'backend', 'src', 'app.js'), 'module.exports = true;\n');
    const beforePartial = fs.readFileSync(cpFile(root));
    const partial = canary(['doctor', '--check', 'backend::test', '--json', root]);
    assert.equal(partial.status, 0, partial.stdout + partial.stderr);
    assert.equal(JSON.parse(partial.stdout).status, 'PARTIAL');
    assert.deepEqual(fs.readFileSync(cpFile(root)), beforePartial);
    const stillRed = canary(['doctor', root]);
    assert.equal(stillRed.status, 2, stillRed.stdout + stillRed.stderr);
    assert.ok(stillRed.stdout.includes("canary doctor --check 'front end::test'"));
    const handoff = JSON.parse(canary(['checkpoint'], root, hookInput(root, true)).stdout);
    assert.match(handoff.systemMessage, /still failing/);
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    fs.writeFileSync(path.join(root, 'front end', 'src', 'app.js'), 'module.exports = true;\n');
    const complete = canary(['checkpoint'], root, hookInput(root, true));
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(complete.stdout.trim(), '', 'the real regression check discriminates both fixes');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
  });
  it('repo without Canary wiring: exit 0, silent (stay out of the way)', () => {
    const root = makeProject('cp-none');
    const r = canary(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
  it('S2: a config written by a different installation never executes — loud UNVERIFIED instead', () => {
    const root = makeProject('cp-distrust', { testScript: fx('f-boom.js') });
    assert.equal(canary(['setup', '--yes', root]).status, 2); // plan fails, but config is written
    const cfg = readCfg(root);
    cfg.cliPath = path.join(FIXTURES, 'not-canary.js'); // a clone's / another install's record
    writeCfg(root, cfg);
    const r = canary(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined); // nothing ran, so nothing could fail into a block
    assert.match(out.systemMessage ?? '', /does not trust/);
    assert.match(out.systemMessage ?? '', /UNVERIFIED/);
    assert.doesNotMatch(r.stdout, /boom/); // proof the plan was NOT executed
  });
  it('S7: a parseable-but-wrong-shape config is treated as corrupt everywhere, never a crash', () => {
    const root = makeProject('s7');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    fs.writeFileSync(cfgFile(root), '{}'); // the old TypeError/exit-3 brick
    const d = canary(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /unreadable/);
    assert.doesNotMatch(d.stderr, /TypeError|is not a function/);
    const c = canary(['checkpoint'], root, JSON.stringify({ cwd: root, hook_event_name: 'Stop' }));
    assert.equal(c.status, 0);
    // GLM F-1 changed this pin: a corrupt config is NOT absence — silence here
    // was a silent allow through damaged authority. Must now be loud UNVERIFIED.
    const cout = JSON.parse(c.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(cout.decision, undefined); // never a fake block on unreadable bytes
    assert.match(cout.systemMessage ?? '', /unreadable/);
    assert.match(cout.systemMessage ?? '', /UNVERIFIED/);
    const u = canary(['uninstall', root]);
    assert.equal(u.status, 2);
    assert.match(u.stdout, /unreadable/);
    assert.match(canary(['setup', '--yes', root]).stdout, /READY/); // self-heal: setup rewrites it
  });
  it('F-1: a half-written (truncated) config is loud UNVERIFIED at checkpoint, never silent; doctor stays NEEDS ATTENTION', () => {
    const root = makeProject('cp-trunc');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    fs.writeFileSync(cfgFile(root), '{"version": "product-0.1", "install'); // the interrupted-write shape (F-2's failure mode)
    const r = canary(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined); // no evidence => no fake block; no silence => no silent allow
    assert.match(out.systemMessage ?? '', /unreadable/);
    assert.match(out.systemMessage ?? '', /UNVERIFIED/);
    assert.match(out.systemMessage ?? '', /canary setup/);
    const d = canary(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /NEEDS ATTENTION/);
  });
});

describe('atomic config writes (GLM F-2)', () => {
  const cfgOf = (pm: string): CanaryConfig => ({
    version: 'test-0.1', installedAt: '2026-09-07T00:00:00.000Z', pm,
    plan: [{ kind: 'tests', script: 'test' }], cliPath: CLI, hookCommand: 'h', hookCommands: ['h'], touched: [],
  });
  it('leaves no temp residue and round-trips exactly', () => {
    const root = path.join(TMP, 'atomic-clean');
    writeConfig(root, cfgOf('npm'));
    assert.deepEqual(readConfig(root), cfgOf('npm'));
    assert.deepEqual(fs.readdirSync(path.join(root, '.canary')).filter((f) => f.includes('.canary-tmp')), []);
  });
  it('a crash before the final rename leaves the PREVIOUS config byte-intact, never a corrupt half-file', () => {
    const root = path.join(TMP, 'atomic-crash');
    writeConfig(root, cfgOf('npm'));
    const before = fs.readFileSync(cfgFile(root), 'utf8');
    const realRename = fs.renameSync;
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      // match by ARGUMENT, not call count: survives write-order changes and
      // any extra renames the helper grows (mutation-tested 2026-09-07)
      if (typeof args[0] === 'string' && /canary[.]local[.]json[.][0-9]+[.]canary-tmp$/.test(args[0])) {
        throw new Error('simulated crash before config rename');
      }
      return realRename(...args);
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => writeConfig(root, cfgOf('pnpm')), /simulated crash/);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(fs.readFileSync(cfgFile(root), 'utf8'), before); // old COMPLETE file, not truncated bytes
    assert.notEqual(readConfig(root), 'corrupt'); // the loud-UNVERIFIED path stays reserved for real damage
    assert.deepEqual(fs.readdirSync(path.join(root, '.canary')).filter((f) => f.includes('.canary-tmp')), []); // self-cleaned
  });
  it('every write is fsync-ed BEFORE its publish rename (durable-then-visible order is pinned)', () => {
    const root = path.join(TMP, 'atomic-order');
    const order: string[] = [];
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    fs.fsyncSync = ((fd: number) => { order.push('fsync'); return realFsync(fd); }) as typeof fs.fsyncSync;
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      if (/[.]gitignore$|canary[.]local[.]json$/.test(String(args[1]))) order.push('rename');
      return realRename(...args);
    }) as typeof fs.renameSync;
    try {
      writeConfig(root, cfgOf('npm')); // two atomic writes: .gitignore, then config
    } finally {
      fs.fsyncSync = realFsync;
      fs.renameSync = realRename;
    }
    assert.deepEqual(order, ['fsync', 'rename', 'fsync', 'rename']);
  });
  it('a crash during the settings write surfaces as a problem — original untouched, backup kept, no residue', () => {
    const root = path.join(TMP, 'atomic-settings');
    const settings = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"theme":"user-value"}\n'); // a stranger's file with real content
    const before = fs.readFileSync(settings, 'utf8');
    const realRename = fs.renameSync;
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      if (typeof args[0] === 'string' && /settings[.]json[.][0-9]+[.]canary-tmp$/.test(args[0])) {
        throw new Error('simulated crash before settings rename');
      }
      return realRename(...args);
    }) as typeof fs.renameSync;
    let res: { ok: boolean; problem?: string };
    try {
      res = installStopHook(root, 'canary-hook-cmd', new Set(), path.join(root, '.canary', 'backups'));
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(res.ok, false);
    assert.match(res.problem ?? '', /left exactly as it was/);
    assert.equal(fs.readFileSync(settings, 'utf8'), before); // never truncated, never half-written
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(settings, 'utf8'))).join(), 'theme'); // intact, no hook entry
    assert.deepEqual(fs.readdirSync(path.dirname(settings)).filter((f) => f.includes('.canary-tmp')), []);
    const backups = path.join(root, '.canary', 'backups');
    assert.ok(fs.readdirSync(backups).some((f) => f.endsWith('-settings.json'))); // the claimed backup really exists
  });
});

describe('doctor + uninstall', () => {
  it('a passing focused check reports PARTIAL and leaves the full checkpoint unchanged', () => {
    const root = makeProject('doctor-focused', { extraScripts: { build: 'placeholder' } });
    const buildScript = path.join(root, 'mutable-build.js');
    fs.copyFileSync(path.join(FIXTURES, 'f-pass.js'), buildScript);
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.build = `node "${buildScript}"`;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const checkpointBefore = fs.readFileSync(cpFile(root));

    fs.copyFileSync(path.join(FIXTURES, 'f-boom.js'), buildScript);
    const focused = canary(['doctor', '--check', 'test', '--json', root]);
    assert.equal(focused.status, 0, focused.stdout + focused.stderr);
    const envelope = JSON.parse(focused.stdout) as {
      schema: string; status: string; partialCheck: { id: string; passed: boolean; ran: boolean };
    };
    assert.equal(envelope.schema, 'canary-doctor-partial/1');
    assert.equal(envelope.status, 'PARTIAL');
    assert.deepEqual(envelope.partialCheck, { id: 'test', passed: true, ran: true, exitCode: 0 });
    assert.doesNotMatch(focused.stdout, /READY/);
    assert.deepEqual(fs.readFileSync(cpFile(root)), checkpointBefore, 'a diagnostic must not replace the completion checkpoint');

    const unknown = canary(['doctor', '--check', 'not-sealed', '--json', root]);
    assert.equal(unknown.status, 3);
    assert.match(unknown.stdout, /available ids: build, test/);
    assert.deepEqual(fs.readFileSync(cpFile(root)), checkpointBefore, 'an unknown id must not execute or alter a result');

    const full = canary(['doctor', root]);
    assert.equal(full.status, 2, full.stdout + full.stderr);
    assert.match(full.stdout, /checks just failed \(build\)/i);
    assert.match(full.stdout, /focused recheck after repair: canary doctor --check build/);
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail', 'the full gate still records the other failed check');
  });

  it('READY after a green setup; hook deletion is detected loudly; --run still works (now always-on)', () => {
    const root = makeProject('doc');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const first = canary(['doctor', root]);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /READY/);
    assert.match(first.stdout, /running the verification plan/); // S4: doctor runs NOW, not from a record
    // tamper: strip Canary's entry, keep the file
    const sfile = path.join(root, '.claude', 'settings.json');
    const doc = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { hooks: { Stop: unknown[] } };
    doc.hooks.Stop = [];
    fs.writeFileSync(sfile, JSON.stringify(doc));
    const t = canary(['doctor', root]);
    assert.equal(t.status, 2);
    assert.match(t.stdout, /no longer registered/);
    // self-heal via setup re-run
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const run = canary(['doctor', '--run', root]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /READY/);
  });
  it('S4: a FORGED or stale checkpoint file can never produce READY — only this run can', () => {
    const root = makeProject('s4-forged');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    fs.writeFileSync(cpFile(root), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', status: 'fail', failed: ['tests'], source: 'hand-edit' }));
    const d = canary(['doctor', root]);
    assert.equal(d.status, 0, d.output.join('')); // old behavior: NEEDS off the stale record
    assert.match(d.stdout, /READY/);
    assert.match(d.stdout, /just ran and passed/); // READY cites THIS invocation's execution
  });
  it('never set up -> NEEDS ATTENTION with the one command; outside git -> UNSUPPORTED', () => {
    const root = makeProject('doc-fresh');
    const r = canary(['doctor', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /canary setup --yes/);
    const loose = fs.mkdtempSync(path.join(TMP, 'nogit-'));
    const u = canary(['doctor', loose]);
    assert.equal(u.status, 2);
    assert.match(u.stdout, /UNSUPPORTED/);
  });

  it('1.1: a project with NO package.json is set up from its own ecosystem and pinned', () => {
    // A Python project, end to end, with no Node project in sight. The fake
    // `python` on PATH stands in for the interpreter: setup is the one moment a
    // real toolchain is resolved, and what it seals is the ABSOLUTE path.
    const root = fs.mkdtempSync(path.join(TMP, 'pyproj-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "x"\n[tool.pytest.ini_options]\n');

    const toolDir = fs.mkdtempSync(path.join(TMP, 'toolchain-'));
    const py = path.join(toolDir, process.platform === 'win32' ? 'python.cmd' : 'python');
    const pass = path.join(FIXTURES, 'f-pass.js');
    fs.writeFileSync(py, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${pass}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${pass}" "$@"\n`);
    if (process.platform !== 'win32') fs.chmodSync(py, 0o755);

    const before = process.env.PATH;
    process.env.PATH = `${toolDir}${path.delimiter}${before ?? ''}`;
    try {
      const r = canary(['setup', '--yes', root]);
      assert.equal(r.status, 0, r.output.join(''));
      assert.match(r.stdout, /READY/);
      const cfg = readCfg(root);
      assert.equal(cfg.plan.length, 1);
      const step = cfg.plan[0]!;
      assert.equal(step.adapter, 'python');
      assert.equal(step.script, 'pytest');
      assert.deepEqual(step.argv!.slice(1), ['-m', 'pytest']);
      assert.ok(path.isAbsolute(step.argv![0]!), `the toolchain must be sealed as an absolute path, got ${step.argv![0]}`);
      // and the sealed authority is what status/doctor judge against
      assert.equal(canary(['status', root]).status, 0);
      const d = canary(['doctor', root]);
      assert.equal(d.status, 0, d.output.join(''));
      assert.match(d.stdout, /READY/);
    } finally {
      process.env.PATH = before;
    }
  });
  it('uninstall removes exactly Canary, preserves everything else; repeat is safe', () => {
    const userHook = 'node "tools/custom-checkpoint.js" checkpoint';
    const root = makeProject('uninst', { settings: { $schema: 'https://x', hooks: { Stop: [{ hooks: [{ type: 'command', command: userHook }] }] } } });
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    const r = canary(['uninstall', root]);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /READY/);
    const cmds = stopCommands(root);
    assert.ok(!cmds.some((c) => cfg.hookCommands.includes(c)), 'canary command fully gone');
    assert.equal(cmds.filter((c) => c === userHook).length, 1, 'user hook intact and not mistaken for Canary');
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(doc.$schema, 'https://x', 'unrelated keys preserved');
    assert.ok(!fs.existsSync(path.join(root, '.canary')));
    assert.equal(canary(['uninstall', root]).status, 0); // idempotent
    assert.match(canary(['uninstall', root]).stdout, /not installed/);
    // reinstall works
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(stopCommands(root).filter((c) => c === readCfg(root).hookCommand).length, 1);
  });
  it('setup refuses to stack a hook from a different Canary installation', () => {
    const foreign = 'node "C:/old/node_modules/@canary-rn/cli/dist/main.js" checkpoint';
    const root = makeProject('setup-foreign-hook', { settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } } });
    const settings = path.join(root, '.claude', 'settings.json');
    const before = fs.readFileSync(settings);
    const check = canary(['setup', '--check', root]);
    assert.equal(check.status, 2, check.stdout);
    assert.match(check.stdout, /Canary hooks from another installation/i);
    assert.deepEqual(fs.readFileSync(settings), before);
    assert.ok(!fs.existsSync(cfgFile(root)));
    const setup = canary(['setup', '--yes', root]);
    assert.equal(setup.status, 2, setup.stdout);
    assert.match(setup.stdout, /another Canary installation/i);
    assert.deepEqual(fs.readFileSync(settings), before);
    assert.ok(!fs.existsSync(cfgFile(root)));
  });
  it('uninstall reports and preserves an unowned hook from another Canary installation', () => {
    const root = makeProject('uninst-foreign-hook');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    const foreign = 'node "C:/old/node_modules/@canary-rn/cli/dist/main.js" checkpoint';
    const settings = path.join(root, '.claude', 'settings.json');
    const doc = JSON.parse(fs.readFileSync(settings, 'utf8')) as { hooks: { Stop: Array<{ hooks: Array<Record<string, unknown>> }> } };
    doc.hooks.Stop.push({ hooks: [{ type: 'command', command: foreign }] });
    fs.writeFileSync(settings, JSON.stringify(doc, null, 2));

    const result = canary(['uninstall', root]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /unowned Canary hook/i);
    assert.doesNotMatch(result.stdout, /Canary is fully removed/);
    assert.deepEqual(stopCommands(root), [foreign]);
    assert.ok(!stopCommands(root).includes(cfg.hookCommand));
    assert.ok(!fs.existsSync(cfgFile(root)));
  });
  it('S1: an out-of-repo touched path in the config is refused, untouched, loudly', () => {
    const root = makeProject('s1');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const victim = path.join(TMP, 's1-victim-settings.json');
    const cfg = readCfg(root);
    const originalTouched = cfg.touched;
    fs.writeFileSync(victim, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cfg.hookCommand }] }] } }, null, 2));
    const before = fs.readFileSync(victim);
    cfg.touched = [{ path: victim, created: false }]; // a doctored record steering writes outward
    writeCfg(root, cfg);
    const r = canary(['uninstall', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /resolves outside this repository/);
    assert.deepEqual(fs.readFileSync(victim), before); // not one byte changed
    assert.ok(fs.existsSync(cfgFile(root)), 'ownership record kept for the retry');
    // honest record -> honest removal
    cfg.touched = originalTouched;
    writeCfg(root, cfg);
    assert.equal(canary(['uninstall', root]).status, 0);
    const localSettings = path.join(root, '.claude', 'settings.json');
    assert.ok(!fs.existsSync(localSettings) || !stopCommands(root).includes(cfg.hookCommand));
  });
  it('S6: partial cleanup keeps .canary so the promised retry can actually finish', () => {
    const root = makeProject('s6');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    const sfile = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(sfile, '{ broken'); // user's file is currently unrepairable
    const r = canary(['uninstall', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /ownership record \(\.canary\) is kept/);
    assert.ok(fs.existsSync(cfgFile(root)), 'record survived the failed pass');
    // fix the file, repeat exactly as promised -> completes
    fs.writeFileSync(sfile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cfg.hookCommand }] }] } }, null, 2));
    assert.equal(canary(['uninstall', root]).status, 0);
    assert.ok(!fs.existsSync(path.join(root, '.canary')));
  });
  it('S2-adjacent: uninstall of a foreign-cliPath config is refused (cannot prove ownership)', () => {
    const root = makeProject('uninst-distrust');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    cfg.cliPath = path.join(FIXTURES, 'not-canary.js');
    writeCfg(root, cfg);
    const r = canary(['uninstall', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /does not trust/);
    assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')));
    assert.ok(stopCommands(root).some((c) => c.includes('checkpoint'))); // nothing was pruned
  });
});

describe('degenerate empty plan (hand-edited config must not fake green)', () => {
  it('checkpoint: zero checks executed -> UNVERIFIED systemMessage, never a silent pass; doctor flags it', () => {
    const root = makeProject('emptyplan');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    cfg.plan = [];
    writeCfg(root, cfg);
    const cp = canary(['checkpoint'], root, JSON.stringify({ cwd: root, stop_hook_active: false, hook_event_name: 'Stop' }));
    assert.equal(cp.status, 0);
    const out = JSON.parse(cp.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined); // never blocks on vacuous "all 0 passed"
    assert.match(out.systemMessage ?? '', /UNVERIFIED/);
    const d = canary(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /plan is empty/);
    assert.doesNotMatch(d.stdout, /READY/);
  });
});

describe('link containment (S3)', () => {
  it('checkpoint evidence is never written through a link pointing outside the repo', (t) => {
    const root = makeProject('s3');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cp = cpFile(root);
    fs.rmSync(cp);
    let target: string;
    try {
      target = fs.mkdtempSync(path.join(TMP, 's3-outside-'));
      fs.symlinkSync(path.join(target, 'last-checkpoint.json'), cp, 'file'); // dangling outward — the write would escape
    } catch {
      t.skip('OS denies symlink creation (Windows without dev mode / privileges)');
      return;
    }
    const r = canary(['doctor', root]); // doctor writes evidence every run now
    assert.equal(r.status, 0, r.output.join(''));
    assert.deepEqual(fs.readdirSync(target), [], 'no evidence escaped through the link');
    assert.ok(fs.lstatSync(cp).isSymbolicLink(), 'the user link is left exactly as it was');
  });
  it('setup refuses outright when a managed file is a link (dangling included)', (t) => {
    const root = makeProject('s3b');
    let target: string;
    try {
      target = fs.mkdtempSync(path.join(TMP, 's3b-out-'));
      fs.symlinkSync(path.join(target, 'settings.json'), path.join(root, '.claude', 'settings.json'), 'file');
    } catch {
      t.skip('OS denies symlink creation (Windows without dev mode / privileges)');
      return;
    }
    const r = canary(['setup', '--yes', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /is a link/);
    assert.match(r.stdout, /Nothing was changed|will not write through links/);
    assert.deepEqual(fs.readdirSync(target), [], 'setup never created its file through the link');
  });
});

describe('hook entry shape + ownership', () => {
  it('hasCanaryEntry matches exact command only', () => {
    const cmd = 'node "C:/x/main.js" checkpoint';
    const doc = { hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } } as Record<string, unknown>;
    assert.ok(hasCanaryEntry(doc, new Set([cmd])));
    assert.ok(!hasCanaryEntry(doc, new Set(['node "C:/y/main.js" checkpoint']))); // moved install is NOT silently owned
    assert.ok(!hasCanaryEntry({ hooks: {} }, new Set([cmd])));
  });
});
