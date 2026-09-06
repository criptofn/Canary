#!/usr/bin/env node
/**
 * LAZY-VIBECODER ACCEPTANCE TEST — clean room, cross-platform (pure Node).
 *
 * Plays the whole brief end to end against the BUILT CLI, exactly as a user
 * would: one setup command in a fresh sample repo, then detection, config,
 * doctor, an automatic verification triggered through the harness workflow
 * (Stop-hook stdin contract), a deliberately broken setup that must be
 * detected loudly, an idempotent re-run, and an uninstall that harms nothing.
 *
 * Simulation note (honesty): "installation" is one-time and machine-wide in
 * real life (`npm link` from a checkout until the package is published). Here
 * we invoke the CLI by absolute path so the test never mutates global state
 * — the per-project commands and the hook contract are identical either way.
 * The "supported workflow" trigger is the exact stdin/stdout JSON contract
 * Claude Code uses for Stop hooks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CANARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(CANARY, 'apps', 'cli', 'dist', 'src', 'main.js');
fs.existsSync(CLI) || (console.error('build first: ' + CLI + ' missing'), process.exit(1));

const TREE = spawnSync('git', ['-C', CANARY, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
console.log(`TREE: ${TREE} @ ${process.cwd()}`);
console.log(`node ${process.version} ${process.platform}; cleanroom lazy-vibecoder acceptance`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cleanroom-'));
const REPO = path.join(TMP, 'my-todo-app');
let failures = 0;
const check = (n, label, cond, extra = '') => {
  if (cond) console.log(`STEP-${n} PASS: ${label}`);
  else { failures++; console.log(`STEP-${n} FAIL: ${label} ${extra}`); }
  return cond;
};
const canary = (args, opts = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: opts.cwd ?? REPO, input: opts.input, timeout: 180_000 });

try {
  // ---- 1) clean, supported sample repo ----
  fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.mkdirSync(path.join(REPO, '.claude'), { recursive: true }); // vibecoder already uses Claude Code here
  fs.writeFileSync(path.join(REPO, 'package-lock.json'), '{}\n'); // lockfile sentinel -> pm detection
  fs.writeFileSync(path.join(REPO, 'src', 'todos.js'), 'export function add(a, b) { return a + b; }\n');
  fs.writeFileSync(path.join(REPO, 'src', 'todos.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './todos.js';\ntest('adds', () => assert.equal(add(2, 2), 4));\n");
  fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({
    name: 'my-todo-app', type: 'module',
    scripts: { test: 'node --test src/todos.test.js', build: "node -e \"console.log('built')\"" },
  }, null, 2));
  // the user's own pre-existing harness config — must survive everything
  fs.writeFileSync(path.join(REPO, '.claude', 'settings.json'), JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-custom-stop-notifier' }] }] },
  }, null, 2));
  check(1, 'clean supported sample repo created (git+package.json+scripts+.claude)', true);

  // ---- 2) installation (simulated: absolute-path invocation; real: npm link) ----
  check(2, 'installation: CLI built and invocable (docs give the real one-time install)', fs.existsSync(CLI));

  // ---- 3) ONE setup command ----
  const setup = canary(['setup', '--yes']);
  check(3, 'one command configured everything (exit 0)', setup.status === 0, JSON.stringify(setup.stdout));
  check(3, 'ends with READY for a healthy repo', /READY/.test(setup.stdout));

  // ---- 4) automatic detection, disclosed compactly ----
  check(4, 'detected package manager from lockfile', /package manager: npm \(package-lock\.json found\)/.test(setup.stdout));
  check(4, 'disclosed inferred plan in compact form', /✓ tests: npm run test/.test(setup.stdout) && /✓ build: npm run build/.test(setup.stdout));
  check(4, 'detected the harness', /Claude Code/.test(setup.stdout));

  // ---- 5) automatic configuration ----
  const settings = () => JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  const allCmds = () => (settings().hooks?.Stop ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  check(5, 'Stop hook registered pointing at the Canary CLI', allCmds().some((c) => /" checkpoint$/.test(c)));
  check(5, 'local config + self-ignoring .canary/ created', fs.existsSync(path.join(REPO, '.canary', 'canary.local.json')) && fs.readFileSync(path.join(REPO, '.canary', '.gitignore'), 'utf8').trim() === '*');
  check(5, 'smoke evidence recorded', JSON.parse(fs.readFileSync(path.join(REPO, '.canary', 'last-checkpoint.json'), 'utf8')).status === 'pass');

  // ---- 6) doctor success ----
  const doc1 = canary(['doctor']);
  check(6, 'doctor says READY (exit 0)', doc1.status === 0 && /READY/.test(doc1.stdout), doc1.stdout);

  // ---- 7) verification triggered automatically through the supported workflow ----
  const hookJson = (active) => JSON.stringify({ session_id: 'cleanroom', transcript_path: path.join(TMP, 't.jsonl'), cwd: REPO, hook_event_name: 'Stop', stop_hook_active: !!active });
  const cpPass = canary(['checkpoint'], { input: hookJson(false) });
  check(7, 'green repo: agent finishes -> Canary allows silently (human NOT interrupted)', cpPass.status === 0 && cpPass.stdout.trim() === '');
  fs.writeFileSync(path.join(REPO, 'src', 'todos.js'), 'export function add(a, b) { return a - b; } // AI broke it\n');
  const cpFail = canary(['checkpoint'], { input: hookJson(false) });
  const cpFailOut = JSON.parse(cpFail.stdout || '{}');
  check(7, 'broken repo: Canary BLOCKS the finish with a repair instruction (REPAIR)', cpFailOut.decision === 'block' && /Canary verification failed/.test(cpFailOut.reason ?? ''));
  const cpLoop = JSON.parse(canary(['checkpoint'], { input: hookJson(true) }).stdout || '{}');
  check(7, 'loop guard: second finish still-failing -> honest systemMessage, human told, no infinite loop', cpLoop.decision === undefined && /still failing/.test(cpLoop.systemMessage ?? ''));

  // ---- 8) intentionally broken setup detected loudly ----
  const docBroken = canary(['doctor']);
  check(8, 'doctor on failing checks: NEEDS ATTENTION, never READY', docBroken.status === 2 && /NEEDS ATTENTION/.test(docBroken.stdout) && !/READY/.test(docBroken.stdout), docBroken.stdout);
  const s0 = settings(); s0.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo my-custom-stop-notifier' }] }]; // user removes canary hook
  fs.writeFileSync(path.join(REPO, '.claude', 'settings.json'), JSON.stringify(s0, null, 2));
  const docNoHook = canary(['doctor']);
  check(8, 'hook removed by hand: loudly un-protected + one repair command', docNoHook.status === 2 && /no longer registered/.test(docNoHook.stdout) && /canary setup/.test(docNoHook.stdout), docNoHook.stdout);

  // ---- 9) re-run repairs, idempotently, preserving user config ----
  const repair = canary(['setup', '--yes']); // fixes the tampered registration AND fails smoke (code still broken)
  check(9, 're-run repairs registration (exactly one Canary entry, user entry intact)', allCmds().filter((c) => /" checkpoint$/.test(c)).length === 1 && allCmds().includes('echo my-custom-stop-notifier'));
  check(9, 're-run stays honest while code is broken: NEEDS ATTENTION, not fake green', repair.status === 2 && /did not pass/.test(repair.stdout), repair.stdout);
  const backupExists = fs.existsSync(path.join(REPO, '.canary', 'backups')) && fs.readdirSync(path.join(REPO, '.canary', 'backups')).length >= 1;
  check(9, 'backups taken before consequential config edits', backupExists);
  fs.writeFileSync(path.join(REPO, 'src', 'todos.js'), 'export function add(a, b) { return a + b; }\n'); // AI repairs
  const docAfter = canary(['doctor', '--run']);
  check(9, 'after the code is fixed: doctor --run re-proves READY', docAfter.status === 0 && /READY/.test(docAfter.stdout), docAfter.stdout);

  // ---- 10) uninstall: removes Canary, harms nothing; reinstall works ----
  const un = canary(['uninstall']);
  const after = settings();
  check(10, 'uninstall exit 0; Canary state gone', un.status === 0 && !fs.existsSync(path.join(REPO, '.canary')));
  check(10, 'unrelated config preserved exactly ($schema + user hook; no Canary entry)',
    after.$schema === 'https://json.schemastore.org/claude-code-settings.json'
    && (after.hooks?.Stop ?? []).flatMap((g) => g.hooks.map((h) => h.command)).join('|') === 'echo my-custom-stop-notifier');
  check(10, 'uninstall idempotent', /not installed/.test(canary(['uninstall']).stdout));
  check(10, 'reinstall after uninstall', canary(['setup', '--yes']).status === 0 && allCmds().filter((c) => /" checkpoint$/.test(c)).length === 1);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('');
if (failures) { console.log(`CLEANROOM-FAIL (${failures} failed checks)`); process.exit(1); }
console.log('ALL-ACCEPTANCE-PASS (10/10 acceptance steps)');
