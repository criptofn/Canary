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
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import {
  detectPm, detectPlan, isSafeScriptName, stepArgv, buildHookCommand, hasCanaryEntry, containedRealPath,
  writeConfig, readConfig, installStopHook,
  type CanaryConfig,
} from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
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
    assert.deepEqual(plan.map((s) => s.kind), ['typecheck', 'tests', 'build']);
    assert.deepEqual(detectPlan({ lint: 'x' }), []);
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
  });
  it('failure -> decision:block with the reason (agent gets a repair turn)', () => {
    const root = makeProject('cp-fail', { testScript: fx('f-needs.js') });
    canary(['setup', '--yes', root]);
    const r = canary(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /Canary verification failed/);
    assert.match(out.reason, /needs work/);
  });
  it('loop guard: stop_hook_active allows with an honest systemMessage, never re-blocks', () => {
    const root = makeProject('cp-loop', { testScript: fx('f-fail.js') });
    canary(['setup', '--yes', root]);
    const r = canary(['checkpoint'], root, hookInput(root, true));
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage ?? '', /still failing/);
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
    const root = makeProject('uninst', { settings: { $schema: 'https://x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } } });
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    const r = canary(['uninstall', root]);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /READY/);
    const cmds = stopCommands(root);
    assert.ok(!cmds.some((c) => cfg.hookCommands.includes(c)), 'canary command fully gone');
    assert.equal(cmds.filter((c) => c === 'echo user-hook').length, 1, 'user hook intact');
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(doc.$schema, 'https://x', 'unrelated keys preserved');
    assert.ok(!fs.existsSync(path.join(root, '.canary')));
    assert.equal(canary(['uninstall', root]).status, 0); // idempotent
    assert.match(canary(['uninstall', root]).stdout, /not installed/);
    // reinstall works
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(stopCommands(root).filter((c) => c.includes('checkpoint')).length, 1);
  });
  it('S1: an out-of-repo touched path in the config is refused, untouched, loudly', () => {
    const root = makeProject('s1');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const victim = path.join(TMP, 's1-victim-settings.json');
    const cfg = readCfg(root);
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
    cfg.touched = [{ path: path.join(root, '.claude', 'settings.json'), created: false }];
    writeCfg(root, cfg);
    assert.equal(canary(['uninstall', root]).status, 0);
    assert.ok(!stopCommands(root).some((c) => c === cfg.hookCommand));
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
