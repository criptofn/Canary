#!/usr/bin/env node
/**
 * v1.5 §4A/§4E — THE CLEAN-ROOM FIRST RUN, AS A REGRESSION JOURNEY.
 *
 * WHAT THIS MEASURES, and why it is a probe rather than a sentence in a document:
 * the first-run path is the one nobody re-reads. `install -> setup -> first task ->
 * verified completion -> FAILED completion -> repair -> second completion -> uninstall`
 * is exercised here against a REAL installed artifact in a scratch git repository under
 * the OS temp dir, with the completion gate driven the way the harness drives it
 * (`canary checkpoint`, hook JSON on stdin — see apps/cli/src/onboarding.ts:3195-3234).
 *
 * WHAT IT ASSERTS: semantics and REQUIRED ACTIONS, never prose. A failing completion
 * must produce a block decision that names the failing check; the payload must name an
 * evidence file that EXISTS on disk; `uninstall` must remove exactly Canary's own entries
 * and leave the user's own hook/permissions/MCP server byte-for-byte intact; every
 * first-run error must name a next action. Wording is deliberately NOT snapshotted —
 * the wording is allowed to improve without turning this probe red.
 *
 * SURFACE. Prefers the packed tarball (`node tooling/pack.mjs` -> pack/npm/*.tgz), because
 * the first-run experience a user has is the INSTALLED artifact, not a checkout. Falls back
 * to the built entry (`apps/cli/dist/src/main.js`) when no tarball is present; which surface
 * ran is printed, and `--version` is asserted on it either way so a fallback can never be a
 * silent no-op. NOTE: the fallback measures `dist`, which a rebuild is required to refresh —
 * a source-side wording change is NOT observable there until then. This probe reports such
 * a case as `PENDING-REBUILD: … NOT a pass`, and never counts it as one.
 *
 * Fixtures live only under the OS temp dir and are removed on success.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI_ENTRY = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

const passed = [];
const failed = [];
const pending = [];
const skips = [];

const check = (name, ok, detail = '') => {
  if (ok) { passed.push(name); console.log(`PASS: ${name}`); return true; }
  failed.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL: ${name}${detail ? `\n      ${String(detail).split('\n').join('\n      ')}` : ''}`);
  return false;
};
/** A source-side improvement this artifact predates. Loudly NOT a pass. */
const note_pending = (what) => {
  pending.push(what);
  console.log(`PENDING-REBUILD: ${what} — the artifact measured here predates the source change; NOT a pass`);
};
const skip = (what) => {
  skips.push(what);
  console.log(`SKIP (host-bound): ${what} — a skip is never a pass`);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, input: opts.input, encoding: 'utf8', timeout: opts.timeoutMs ?? 300_000,
    env: { ...process.env, ...(opts.env ?? {}) }, shell: opts.shell ?? false, windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
}
const git = (args, cwd) => run('git', args, { cwd });

// ──────────────────────────────── a fixture root PROVABLY outside every git repository ──
/**
 * v1.5 §4D — MEASURED DEFECT IN THIS PROBE, FIXED HERE. Harness/fixture only; the product is correct.
 *
 * The "no git repository" case (§6a) used to build its fixture under `temp` = mkdtempSync(os.tmpdir())
 * and then delete the fixture's own `.git`. MEASURED on the host where this was found (2026-09-24):
 *
 *   git -C "$env:TEMP" rev-parse --show-toplevel   ->   C:/Users/Johannes   (exit 0)
 *
 * so the fixture still sat INSIDE an ancestor repository and "no git repository" was NEVER tested.
 * It reported PASS on `C:\Users\Johannes is a git repo, but Canary found no project it can model at
 * its root` — a different condition, matched by the old `/git/i` detail check. That is the defect.
 *
 * Two proofs are taken, because they are two different claims, and neither substitutes for the other:
 *   1. git's own discovery must fail from the fixture root (`rev-parse --show-toplevel`);
 *   2. no `.git` entry may exist in ANY ancestor of the fixture root — this is Canary's OWN
 *      project-root rule (`findRepoRoot`, apps/cli/src/onboarding.ts:173-181: an upward
 *      `fs.existsSync(<dir>/.git)` walk). Proof 2 is the decisive one, and it is why the fixture
 *      MOVES rather than the environment changing: `GIT_CEILING_DIRECTORIES` bounds git's upward
 *      walk but does NOT bound that walk, so no environment variable can make an in-repo fixture
 *      honest — only a physically repo-free root can.
 *
 * Candidate roots, in order: the OS temp dir (the repo's convention), then its ancestors
 * nearest-first. Every rejection is printed with its reason. If no candidate can host a provably
 * repo-free fixture, §6a reports an explicit host-bound SKIP — never a quiet pass.
 */
const GIT_DISCOVERY_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];
/** Proof 1. Asked with git's own discovery variables stripped, so the answer is about the PATH
 *  and not about a GIT_DIR this process happened to inherit. `status: null` = git could not be asked. */
function gitToplevel(dir) {
  const env = { ...process.env };
  for (const k of GIT_DISCOVERY_VARS) delete env[k];
  const r = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env, timeoutMs: 60_000 });
  const out = r.stdout.trim();
  // `detail` is kept so the printed proof distinguishes "git says: not a repository" from
  // "git failed for some other reason" — the two are not the same evidence.
  return { status: r.status, toplevel: r.status === 0 && out !== '' ? out : null, detail: (r.stderr.trim() || out || r.error || '').split('\n')[0] };
}
/** Proof 2 — Canary's own rule, reproduced exactly: the nearest ancestor (or `dir` itself) holding
 *  a `.git` ENTRY. `existsSync` on purpose: a directory, a worktree/submodule pointer file and a
 *  bogus file all stop `findRepoRoot`'s walk. */
function dotGitAncestor(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}
/** Does `text` name `p`, in either separator style? (Paths are compared case-insensitively.) */
function namesPath(text, p) {
  const t = String(text).toLowerCase();
  return [p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')].some((f) => f !== '' && t.includes(f.toLowerCase()));
}
/** Walk `os.tmpdir()` and its ancestors; return the first that can host a fixture root that is
 *  provably outside every repository, with the proofs re-taken on the root ACTUALLY created. */
function repoFreeFixtureRoot() {
  const candidates = [path.resolve(os.tmpdir())];
  for (let d = candidates[0]; path.dirname(d) !== d;) { d = path.dirname(d); candidates.push(d); }
  const tried = [];
  for (const candidate of candidates) {
    const top = gitToplevel(candidate);
    if (top.status === null) { tried.push(`${candidate} — REJECTED: git could not be asked, so repo-freeness is UNPROVEN`); continue; }
    if (top.status === 0) { tried.push(`${candidate} — REJECTED: INSIDE a git repository (rev-parse --show-toplevel -> ${top.toplevel})`); continue; }
    const dot = dotGitAncestor(candidate);
    if (dot !== null) { tried.push(`${candidate} — REJECTED: a .git entry exists at ${dot}, so Canary's own root walk stops inside a repository`); continue; }
    let root;
    try { root = fs.mkdtempSync(path.join(candidate, 'canary-v15-nogit-')); }
    catch (e) { tried.push(`${candidate} — REJECTED: repo-free but unusable, cannot create a fixture root there (${e.code ?? e.message})`); continue; }
    const reTop = gitToplevel(root);
    const reDot = dotGitAncestor(root);
    if (reTop.status === 0 || reDot !== null) {
      tried.push(`${candidate} — REJECTED: the created root ${root} still resolves into ${reTop.toplevel ?? reDot}`);
      fs.rmSync(root, { recursive: true, force: true });
      continue;
    }
    tried.push(`${candidate} — repo-free and writable: CHOSEN`);
    return { root, tried, proof: [
      `git -C "${root}" rev-parse --show-toplevel  ->  exit ${reTop.status}, no toplevel printed; git said: ${reTop.detail}`,
      `no .git entry in any ancestor of ${root}  ->  Canary's own findRepoRoot() answers null here`,
    ] };
  }
  return { root: null, tried, proof: [] };
}
/** The repository the OLD fixture location resolved into — kept only to prove the difference. */
const noGitAncestorRepo = dotGitAncestor(os.tmpdir());

// ───────────────────────────────────────────────────────────────── the measured surface ──
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-v15-firstrun-'));
/**
 * v1.5 — MEASURED DEFECT IN THIS PROBE, fixed here.
 *
 * It used to reuse ANY tarball already sitting in `pack/npm/` and never repack. After
 * source-side fixes were made and `dist` was rebuilt, the probe still reported those fixes
 * as `PENDING-REBUILD`, because the tarball it installed had been packed BEFORE the change.
 * The probe was measuring stale bytes and presenting them as the current surface — exactly
 * the stale-build acceptance that the v1.2 dist-tripwire rule exists to prevent.
 *
 * It now REPACKS from the current `dist`, and refuses to measure a tarball older than the
 * newest compiled file, so the artifact under test is always the source in front of it.
 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return newest;
}
const packDir = path.join(REPO, 'pack', 'npm');
const packed = run(process.execPath, [path.join(REPO, 'tooling', 'pack.mjs')], { cwd: REPO, timeoutMs: 300_000 });
if (packed.status !== 0) {
  console.log(`FAIL: repacking the artifact failed (exit ${packed.status}) — the measured surface cannot be trusted as current`);
  console.log(`${packed.stdout}\n${packed.stderr}`);
}
const tarballs = (() => {
  if (!fs.existsSync(packDir)) return [];
  const distNewest = newestMtime(path.join(REPO, 'apps/cli', 'dist'));
  return fs.readdirSync(packDir).filter((f) => f.endsWith('.tgz')).map((f) => path.join(packDir, f))
    .filter((f) => {
      const packedAt = fs.statSync(f).mtimeMs;
      if (packedAt < distNewest) {
        console.log(`FAIL: ${path.basename(f)} predates the newest compiled source — refusing to measure stale bytes`);
        return false;
      }
      return true;
    });
})();

let invoke;           // (args, {cwd,input,env}) -> {status,stdout,stderr}
let surfaceKind;      // 'installed tarball' | 'built dist'

if (tarballs.length > 0) {
  const prefix = path.join(temp, 'prefix');
  fs.mkdirSync(prefix, { recursive: true });
  const inst = run('npm', ['install', '-g', tarballs[0], '--prefix', prefix], { shell: true, timeoutMs: 300_000 });
  const bundle = path.join(prefix, 'node_modules', '@canary-rn', 'cli', 'dist', 'main.js');
  if (inst.status === 0 && fs.existsSync(bundle)) {
    surfaceKind = 'installed tarball';
    invoke = (args, opts = {}) => run(process.execPath, [bundle, ...args], opts);
    const shim = process.platform === 'win32' ? path.join(prefix, 'canary.cmd') : path.join(prefix, 'bin', 'canary');
    const shimRun = run(shim, ['--version'], { shell: true, cwd: temp });
    check('the installed artifact ships a runnable `canary` command', shimRun.status === 0 && /canary \d/.test(shimRun.stdout),
      `shim ${shim}: exit ${shimRun.status} ${shimRun.stdout}${shimRun.stderr}`);
  } else {
    console.log(`INFO: tarball install failed (${inst.status}); falling back to the built entry`);
  }
}
if (invoke === undefined) {
  surfaceKind = 'built dist';
  invoke = (args, opts = {}) => run(process.execPath, [CLI_ENTRY, ...args], opts);
}
console.log(`SURFACE: ${surfaceKind}`);
console.log(`TEMP:    ${temp}\n`);

// ──────────────────────────────────────────────────────────────────── fixture builders ──
const GREETING_V1 = 'module.exports = (name) => `Hello, ${name}!`;\n';
const TEST_V1 = [
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const greeting = require('./greeting.cjs');",
  '',
  "test('greeting greets by name', () => {",
  "  assert.equal(greeting('Ada'), 'Hello, Ada!');",
  '});',
  '',
].join('\n');
const USER_CLAUDE = {
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-own-stop-hook' }] }] },
};
const USER_CODEX = { hooks: { Stop: [{ type: 'command', command: 'echo user-own-codex-hook' }] } };
const USER_MCP = { mcpServers: { someoneelse: { command: 'node', args: ['their-server.js'] } } };

/** The user's OWN configuration is seeded BEFORE Canary ever runs: uninstall must keep it. */
function makeProject(dir, { seedUserConfig = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: path.basename(dir), version: '1.0.0', private: true,
    scripts: { test: 'node --test greeting.test.cjs' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'greeting.cjs'), GREETING_V1);
  fs.writeFileSync(path.join(dir, 'greeting.test.cjs'), TEST_V1);
  if (seedUserConfig) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(USER_CLAUDE, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify(USER_CODEX, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(USER_MCP, null, 2) + '\n');
  }
  const gj = (args) => git(['-c', 'user.name=Op', '-c', 'user.email=op@localhost', ...args], dir);
  git(['init', '-q'], dir);
  gj(['add', '-A']);
  gj(['commit', '-q', '-m', 'initial project']);
  return dir;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const hookCommands = (doc) => JSON.stringify(doc.hooks ?? {});
const checkpoint = (dir, body) => {
  const r = invoke(['checkpoint'], { cwd: dir, input: JSON.stringify({ cwd: dir, stop_hook_active: false, task: 'v15 first-run probe', ...body }) });
  let env = null;
  try { env = JSON.parse(r.stdout.trim()); } catch { env = null; }
  return { ...r, env, raw: r.stdout };
};
const allowed = (v) => (v.env === null ? v.raw.trim() === '' : v.env.decision !== 'block');

// ═══════════════════════════════════════════════════ 1. install → setup (the first run) ══
console.log('=== 1. install -> setup ===');
const version = invoke(['--version'], { cwd: temp });
check('the measured artifact answers --version', version.status === 0 && /canary \d+\.\d+\.\d+/.test(version.stdout),
  `exit ${version.status}: ${version.stdout}${version.stderr}`);

const repo = makeProject(path.join(temp, 'journey'));
const setup = invoke(['setup', '--yes'], { cwd: repo });
console.log(setup.stdout.trimEnd());
check('setup --yes ends READY on a clean project with a passing declared check',
  setup.status === 0 && /\bREADY\b/.test(setup.stdout), `exit ${setup.status}\n${setup.stdout}${setup.stderr}`);

const claudeDoc = () => readJson(path.join(repo, '.claude', 'settings.json'));
const codexDoc = () => readJson(path.join(repo, '.codex', 'hooks.json'));
const mcpDoc = () => readJson(path.join(repo, '.mcp.json'));
check('setup wires the completion gate into .claude/settings.json',
  /checkpoint/.test(hookCommands(claudeDoc())), hookCommands(claudeDoc()));
check("setup preserves the user's own Claude hook alongside Canary's",
  /user-own-stop-hook/.test(hookCommands(claudeDoc())), hookCommands(claudeDoc()));
check("setup preserves the user's own Claude permissions",
  JSON.stringify(claudeDoc().permissions) === JSON.stringify(USER_CLAUDE.permissions), JSON.stringify(claudeDoc().permissions));
check('setup wires the Codex project hook',
  /checkpoint/.test(hookCommands(codexDoc())), hookCommands(codexDoc()));
check("setup preserves the user's own Codex hook",
  /user-own-codex-hook/.test(hookCommands(codexDoc())), hookCommands(codexDoc()));
check('setup registers the agent tool server without touching the user\'s MCP server',
  mcpDoc().mcpServers?.canary !== undefined
  && JSON.stringify(mcpDoc().mcpServers?.someoneelse) === JSON.stringify(USER_MCP.mcpServers.someoneelse),
  JSON.stringify(mcpDoc()));
// 4B/4C: the trust step and the local-vs-project scope must be ANSWERED in the output.
const trustWorded = /\/hooks/.test(setup.stdout) && /(will NOT run it|not gated|gates nothing)/i.test(setup.stdout);
if (!trustWorded) check('setup explains the Codex trust step', false, setup.stdout); else check('setup explains the Codex trust step', true);
const scopeWorded = /(PROJECT files|project file)/i.test(setup.stdout) && /(local to you|self-ignored)/i.test(setup.stdout);
if (!scopeWorded) note_pending('setup states which Canary files are PROJECT-scoped (shared) and which are local to this machine');
else check('setup states which Canary files are PROJECT-scoped (shared) and which are local', true);
const undoWorded = /canary uninstall/.test(setup.stdout);
if (!undoWorded) note_pending('setup says how to undo the trust step / the wiring'); else check('setup says how to undo the wiring', true);

// ─────────────────────────────────── 2. first normal task: a completion the checks can PROVE ──
console.log('\n=== 2. first normal task (discriminating change) ===');
fs.writeFileSync(path.join(repo, 'greeting.cjs'), 'module.exports = (name) => `Hello, ${String(name).trim()}!`;\n');
fs.writeFileSync(path.join(repo, 'greeting.test.cjs'), `${TEST_V1}
test('greeting trims the name', () => {
  assert.equal(greeting('  Ada  '), 'Hello, Ada!');
});
`);
const firstStop = checkpoint(repo, {});
check('a change the sealed checks can discriminate is ALLOWED (silence, exit 0)',
  firstStop.status === 0 && allowed(firstStop), `exit ${firstStop.status} stdout=${JSON.stringify(firstStop.raw)}`);
const record1 = readJson(path.join(repo, '.canary', 'last-checkpoint.json'));
check('the allow is a VERIFIED pass, not a no-op (a checkpoint record was written)',
  record1.status === 'pass' && record1.source === 'checkpoint', JSON.stringify(record1));

// ───────────────────────────────── 3. the FAILED completion: the sealed check is broken ──
console.log('\n=== 3. failed completion ===');
fs.writeFileSync(path.join(repo, 'greeting.cjs'), 'module.exports = (name) => `hello, ${String(name).trim()}!`;\n');
const blocked = checkpoint(repo, {});
console.log(`raw decision JSON: ${blocked.raw.trim()}`);
check('a failing sealed check yields a BLOCK decision on stdout with exit 0',
  blocked.status === 0 && blocked.env !== null && blocked.env.decision === 'block',
  `exit ${blocked.status} stdout=${JSON.stringify(blocked.raw)}`);
const reason = String(blocked.env?.reason ?? '');
check('the block reason NAMES the failing check', /\btests\b/.test(reason), reason);
check('the block reason NAMES an evidence file', /full output: (.+\.log)/.test(reason), reason);
const logPath = (/full output: (.+)$/m.exec(reason) ?? [])[1];
check('the named evidence file EXISTS on disk', logPath !== undefined && fs.existsSync(logPath.trim()),
  `path=${JSON.stringify(logPath)}`);
const logText = logPath !== undefined && fs.existsSync(logPath.trim()) ? fs.readFileSync(logPath.trim(), 'utf8') : '';
check('the evidence file carries the full runner output (the failing test is identifiable there)',
  /greeting (trims the name|greets by name)/.test(logText), logText.slice(0, 300));
if (!/greeting (trims the name|greets by name)/.test(reason)) {
  note_pending('the block PAYLOAD names the failing test itself (`node --test` spec-reporter identity)');
} else {
  check('the block payload names the failing test itself', true);
}
const recordedFail = readJson(path.join(repo, '.canary', 'last-checkpoint.json'));
check('the failure is recorded as a fail (state, not a bundle)', recordedFail.status === 'fail', JSON.stringify(recordedFail));

// the loop guard: one repair turn, then an honest stop that hands off to a human
const loop = checkpoint(repo, { stop_hook_active: true });
check('after one repair attempt the gate STOPS the loop with an honest message instead of blocking again',
  loop.status === 0 && allowed(loop) && typeof loop.env?.systemMessage === 'string',
  `exit ${loop.status} stdout=${JSON.stringify(loop.raw)}`);
check('that hand-off message names what is still failing', /\btests\b/.test(String(loop.env?.systemMessage ?? '')),
  String(loop.env?.systemMessage ?? ''));
if (!/canary doctor/.test(String(loop.env?.systemMessage ?? ''))) {
  note_pending('the hand-off message names the next action (`canary doctor`) for the human it hands off to');
} else {
  check('the hand-off message names the next action for the human', true);
}

// the human's own view of the same failure
const doc = invoke(['doctor'], { cwd: repo });
console.log(doc.stdout.trimEnd());
check('doctor on a failing tree exits non-zero with NEEDS ATTENTION and never READY',
  doc.status === 2 && /NEEDS ATTENTION/.test(doc.stdout) && !/\bREADY\b/.test(doc.stdout),
  `exit ${doc.status}\n${doc.stdout}`);
check('doctor names a required next action', /^next: /m.test(doc.stdout), doc.stdout);
if (!/full runner output: .*(\.canary|evidence)/.test(doc.stdout)) {
  note_pending('doctor prints the evidence PATH its own TROUBLESHOOTING entry promises ("read that file, not the summary")');
} else {
  check('doctor prints the evidence path it promises', true);
}
const docDirs = fs.existsSync(path.join(repo, '.canary', 'evidence'))
  ? fs.readdirSync(path.join(repo, '.canary', 'evidence')).filter((d) => d.endsWith('-doctor')) : [];
check('doctor wrote its evidence bundle to disk even when it failed', docDirs.length > 0, JSON.stringify(docDirs));

// ────────────────────────────────────────────────── 4. repair -> second verified completion ──
console.log('\n=== 4. repair -> second completion ===');
fs.writeFileSync(path.join(repo, 'greeting.cjs'), 'module.exports = (name) => `Hello, ${String(name).trim()}!`;\n');
const secondStop = checkpoint(repo, {});
check('the repaired tree is ALLOWED again (exit 0, no block)',
  secondStop.status === 0 && allowed(secondStop), `exit ${secondStop.status} stdout=${JSON.stringify(secondStop.raw)}`);
check('the second completion is recorded as a verified pass',
  readJson(path.join(repo, '.canary', 'last-checkpoint.json')).status === 'pass', 'last-checkpoint.json');

// ──────────────────────────────────────────────────────────────────────────── 5. uninstall ──
console.log('\n=== 5. uninstall ===');
const un = invoke(['uninstall'], { cwd: repo });
console.log(un.stdout.trimEnd());
check('uninstall exits 0 and reports the removal',
  un.status === 0 && /removed \d+ Canary hook entr/.test(un.stdout), `exit ${un.status}\n${un.stdout}${un.stderr}`);
check("uninstall removes Canary's Claude hook",
  !/checkpoint/.test(hookCommands(claudeDoc())), hookCommands(claudeDoc()));
check("uninstall keeps the user's own Claude hook",
  /user-own-stop-hook/.test(hookCommands(claudeDoc())), hookCommands(claudeDoc()));
check("uninstall keeps the user's own Claude permissions",
  JSON.stringify(claudeDoc().permissions) === JSON.stringify(USER_CLAUDE.permissions), JSON.stringify(claudeDoc().permissions));
check("uninstall keeps the user's own Codex hook and removes Canary's",
  /user-own-codex-hook/.test(hookCommands(codexDoc())) && !/checkpoint/.test(hookCommands(codexDoc())), hookCommands(codexDoc()));
check("uninstall keeps the user's own MCP server and removes Canary's",
  mcpDoc().mcpServers?.canary === undefined
  && JSON.stringify(mcpDoc().mcpServers?.someoneelse) === JSON.stringify(USER_MCP.mcpServers.someoneelse),
  JSON.stringify(mcpDoc()));
check("uninstall removes Canary's own state directory", !fs.existsSync(path.join(repo, '.canary')));

// ═════════════════════════════════════════════════════════ 6. the first-run ERRORS (4D) ══
console.log('\n=== 6. first-run errors say WHAT HAPPENED, WHY IT STOPPED, WHAT TO DO NEXT ===');
/** Every error assertion: non-zero, never READY, and a named next action.
 *  `nextRe` is the shape THAT path uses — the last-resort handler prints `what to do:` rather
 *  than the `next:` line the onboarding verdicts use; both name an action, neither is a pass. */
const errorCase = (label, r, extra = () => true, nextRe = /^next: /m) => {
  const out = `${r.stdout}${r.stderr}`;
  check(`${label}: exits non-zero`, r.status !== 0 && r.status !== null, `exit ${r.status}`);
  check(`${label}: never claims READY`, !/\bREADY\b/.test(out), out.slice(0, 400));
  check(`${label}: names a next action`, nextRe.test(out), out.slice(0, 400));
  check(`${label}: keeps its factual detail`, extra(out), out.slice(0, 400));
};

// (a) no git repository. STRENGTHENED in v1.5: the fixture must be PROVABLY outside every
//     repository (see the block at the top of this file), and the refusal is pinned to the text
//     the built artifact actually prints — the generic errorCase below is kept, but its old
//     `/git/i` detail check passed on `C:\Users\Johannes is a git repo, ...` (the ENCLOSING
//     repository), i.e. it would pass for exactly the wrong reason this section now rules out.
const gitOnPath = run('git', ['--version']).status === 0;
const noGitFixture = gitOnPath
  ? repoFreeFixtureRoot()
  : { root: null, tried: ['git is not on PATH — repo-freeness cannot be proven'], proof: [] };
if (noGitFixture.root === null) {
  skip(`no git repository: this host offers no PROVABLY repo-free fixture root, so the case is UNMEASURED (${noGitFixture.tried.join('; ')}) — a fixture inside an ancestor repository measures the enclosing-repo path instead, which is the defect this case fixes; a skip is never a pass`);
} else {
  console.log(`no-git fixture root: ${noGitFixture.root}`);
  for (const t of noGitFixture.tried) console.log(`  candidate: ${t}`);
  for (const p of noGitFixture.proof) console.log(`  proof:     ${p}`);
  if (noGitAncestorRepo !== null) {
    console.log(`  (this case's OLD fixture location, the OS temp dir ${os.tmpdir()}, still resolves into the repository at ${noGitAncestorRepo} — that is why the fixture had to move)`);
    /**
     * WHY NOT SIMPLY SET `GIT_CEILING_DIRECTORIES`? MEASURED here rather than argued: a ceiling
     * bounds GIT's upward walk, not Canary's own root walk (`findRepoRoot` asks the filesystem,
     * never git). The OLD fixture shape is built again under the temp dir and asked — with the
     * ceiling pointed at the enclosing repository — which root Canary selects. `canary result`
     * writes nothing, so this control cannot perturb any state. It is printed, not asserted: if a
     * future Canary ever honoured the ceiling, the fixture move below would still be the correct
     * (and sufficient) construction, and this probe should not go red for that improvement.
     */
    const ceilingFixture = path.join(temp, 'no-git-under-ceiling');
    makeProject(ceilingFixture);
    fs.rmSync(path.join(ceilingFixture, '.git'), { recursive: true, force: true });
    const ceilingRun = invoke(['result', '--json'], { cwd: ceilingFixture, env: { GIT_CEILING_DIRECTORIES: noGitAncestorRepo } });
    let ceilingEnv = null;
    try { ceilingEnv = JSON.parse(ceilingRun.stdout.trim()); } catch { ceilingEnv = null; }
    console.log(`  measured (read-only control): GIT_CEILING_DIRECTORIES=${noGitAncestorRepo} on the old fixture shape -> Canary still selects root=${JSON.stringify(ceilingEnv?.root ?? null)} (${ceilingEnv?.status ?? `exit ${ceilingRun.status}`}) — a ceiling cannot make an in-repo fixture honest`);
    fs.rmSync(ceilingFixture, { recursive: true, force: true });
  }
  const noGit = path.join(noGitFixture.root, 'no-git');
  makeProject(noGit);
  fs.rmSync(path.join(noGit, '.git'), { recursive: true, force: true });
  // The proofs are re-taken HERE — the fixture's final state, immediately before the product runs.
  const noGitTop = gitToplevel(noGit);
  const noGitDot = dotGitAncestor(noGit);
  check('no git repo: the fixture is PROVABLY outside every git repository (git discovery fails; no .git in any ancestor)',
    noGitTop.status !== 0 && noGitTop.toplevel === null && noGitDot === null,
    `git -C "${noGit}" rev-parse --show-toplevel -> exit ${noGitTop.status} toplevel=${JSON.stringify(noGitTop.toplevel)} ("${noGitTop.detail}"); nearest .git ancestor: ${noGitDot}`);
  const ancestorCanaryBefore = noGitAncestorRepo === null ? null : fs.existsSync(path.join(noGitAncestorRepo, '.canary'));
  const rNoGit = invoke(['setup', '--yes'], { cwd: noGit });
  console.log(rNoGit.stdout.trimEnd() || rNoGit.stderr.trimEnd());
  const noGitOut = `${rNoGit.stdout}${rNoGit.stderr}`;
  // Pinned to the OBSERVED refusal of the built artifact: run `node apps/cli/dist/src/main.js setup
  // --yes` in this fixture (the probe prints that run's output verbatim above) and copied here.
  const NO_GIT_REFUSAL = 'UNSUPPORTED — this folder is not inside a git repository.';
  const NO_GIT_NEXT = 'next: cd into your project and try again';
  errorCase('no git repo', rNoGit, (out) => out.includes(NO_GIT_REFUSAL) && out.includes(NO_GIT_NEXT));
  check('no git repo: the verdict and exit code are the refusal itself (UNSUPPORTED, exit exactly 2)',
    rNoGit.status === 2 && noGitOut.includes(NO_GIT_REFUSAL),
    `exit ${rNoGit.status}\n${noGitOut.slice(0, 400)}`);
  check('no git repo: names the no-repository next action, verbatim',
    noGitOut.includes(NO_GIT_NEXT), noGitOut.slice(0, 400));
  // The negation that makes this case discriminating: the old fixture's verdict NAMED the
  // enclosing repository. Neither that shape nor that path may appear here.
  check('no git repo: does NOT take the enclosing repository as the project root (the shape the old fixture produced)',
    !/is a git repo(sitory)?, but/.test(noGitOut) && !/no project it can model/.test(noGitOut)
    && (noGitAncestorRepo === null || !namesPath(noGitOut, noGitAncestorRepo)),
    noGitOut.slice(0, 400));
  // `canary result --json` carries the selected root as a FIELD (`root`, protocol.ts:80, attached
  // only after a root is found), so this is the "which root did the product select" assertion: a
  // no-repository project must select NONE — least of all the ancestor.
  const rNoGitResult = invoke(['result', '--json'], { cwd: noGit });
  console.log(`no-git result --json: exit ${rNoGitResult.status} ${rNoGitResult.stdout.trim()}`);
  let noGitEnv = null;
  try { noGitEnv = JSON.parse(rNoGitResult.stdout.trim()); } catch { noGitEnv = null; }
  check('no git repo: `result --json` selects NO project root (the envelope names neither the fixture\'s ancestor nor any other repo)',
    rNoGitResult.status === 2 && noGitEnv !== null && noGitEnv.status === 'NOT CONNECTED' && noGitEnv.exitCode === 2
    && noGitEnv.root === undefined
    && (noGitAncestorRepo === null || (!namesPath(rNoGitResult.stdout, noGitAncestorRepo) && !namesPath(rNoGitResult.stderr, noGitAncestorRepo))),
    `exit ${rNoGitResult.status} stdout=${JSON.stringify(rNoGitResult.stdout)} stderr=${JSON.stringify(rNoGitResult.stderr)}`);
  check('no git repo: `result` says there is no Canary state here, verbatim (not the "is a git repository, but ..." shape)',
    /not inside a git repository — there is no Canary state to report here\./.test(rNoGitResult.stderr)
    && !/is a git repository, but/.test(rNoGitResult.stderr),
    rNoGitResult.stderr.slice(0, 400));
  // A refusal must not be a partial setup, in the fixture OR in the enclosing repository.
  check('no git repo: wrote nothing — no Canary state in the fixture, and the enclosing repository is untouched',
    !fs.existsSync(path.join(noGit, '.canary'))
    && (noGitAncestorRepo === null || fs.existsSync(path.join(noGitAncestorRepo, '.canary')) === ancestorCanaryBefore),
    `fixture .canary=${fs.existsSync(path.join(noGit, '.canary'))} ancestor .canary=${noGitAncestorRepo === null ? 'n/a' : fs.existsSync(path.join(noGitAncestorRepo, '.canary'))} (before ${ancestorCanaryBefore})`);
  check("no git repo: the user's own Claude/Codex/MCP files are byte-for-byte untouched",
    fs.readFileSync(path.join(noGit, '.claude', 'settings.json'), 'utf8') === JSON.stringify(USER_CLAUDE, null, 2) + '\n'
    && fs.readFileSync(path.join(noGit, '.codex', 'hooks.json'), 'utf8') === JSON.stringify(USER_CODEX, null, 2) + '\n'
    && fs.readFileSync(path.join(noGit, '.mcp.json'), 'utf8') === JSON.stringify(USER_MCP, null, 2) + '\n');
}

// (b) no detected harness — a clean HOME and a PATH with no agent on it
const noHarness = path.join(temp, 'no-harness');
makeProject(noHarness, { seedUserConfig: false });
const fakeHome = path.join(temp, 'fake-home');
fs.mkdirSync(fakeHome, { recursive: true });
const nodeDir = path.dirname(process.execPath);
const rNoHarness = invoke(['setup', '--yes'], {
  cwd: noHarness,
  env: { USERPROFILE: fakeHome, HOME: fakeHome, PATH: nodeDir, Path: nodeDir },
});
console.log(rNoHarness.stdout.trimEnd() || `(exit ${rNoHarness.status})`);
if (/no supported AI harness detected/.test(`${rNoHarness.stdout}${rNoHarness.stderr}`)) {
  errorCase('no detected harness', rNoHarness, (out) => /harness/i.test(out));
} else {
  skip(`no detected harness: this host cannot hide every harness from the child (${process.platform} resolves agents outside PATH); the case ran but produced no harness refusal`);
}

// (c) an unreadable/corrupt .canary config, on a repo that IS wired
const corrupt = makeProject(path.join(temp, 'corrupt-config'));
invoke(['setup', '--yes'], { cwd: corrupt });
fs.writeFileSync(path.join(corrupt, '.canary', 'canary.local.json'), '{ this is not json');
const rCorrupt = checkpoint(corrupt, {});
console.log(`raw stdout: ${rCorrupt.raw.trim()}`);
check('corrupt local config: the completion is NOT reported as verified',
  rCorrupt.status === 0 && allowed(rCorrupt) && typeof rCorrupt.env?.systemMessage === 'string',
  `exit ${rCorrupt.status} stdout=${JSON.stringify(rCorrupt.raw)}`);
check('corrupt local config: says so and names the next action',
  /UNVERIFIED|unreadable/i.test(String(rCorrupt.env?.systemMessage ?? '')) && /canary setup/.test(String(rCorrupt.env?.systemMessage ?? '')),
  String(rCorrupt.env?.systemMessage ?? ''));
const rCorruptStatus = invoke(['status'], { cwd: corrupt });
console.log(rCorruptStatus.stdout.trimEnd());
check('corrupt local config: `status` refuses to call this CONNECTED and names a next action',
  /NOT CONNECTED/.test(rCorruptStatus.stdout) && /^next: /m.test(rCorruptStatus.stdout),
  `exit ${rCorruptStatus.status}\n${rCorruptStatus.stdout}`);

// (d) an unbound requirement — the duty nobody can close. The registration is on an OBJECTIVE
//     intent on purpose: Canary suppresses the pre-handoff note for requirements it reads as
//     subjective (a human closes those), which is a different case and not what is asserted here.
const unbound = makeProject(path.join(temp, 'unbound'));
invoke(['setup', '--yes'], { cwd: unbound });
const task = invoke(['task', 'trim whitespace in greeting()', '--requirement', "greeting('  Ada  ') returns 'Hello, Ada!'"], { cwd: unbound });
check('registering a requirement succeeds', task.status === 0, `exit ${task.status}\n${task.stdout}${task.stderr}`);
const reSetup = invoke(['setup', '--yes'], { cwd: unbound });
console.log(reSetup.stdout.trimEnd());
check('setup names the requirement that no sealed check measures (the documented pre-handoff note)',
  /requirement\(s\) that no (check|machine check) here measures/.test(reSetup.stdout) && /unbound: /.test(reSetup.stdout),
  reSetup.stdout);
const rUnbound = invoke(['doctor'], { cwd: unbound });
console.log(rUnbound.stdout.trimEnd());
check('doctor refuses a green plan as a proven task (NOT PROVEN, never READY)',
  rUnbound.status !== 0 && /\bNOT PROVEN\b/.test(rUnbound.stdout) && !/\bREADY\b/.test(rUnbound.stdout),
  `exit ${rUnbound.status}\n${rUnbound.stdout}`);
check('doctor names the next action for the unbound requirement',
  /^next: /m.test(rUnbound.stdout) && /(bind|accept|canary )/i.test(rUnbound.stdout), rUnbound.stdout);

// (e) the store cannot be written: `.canary` is an ordinary FILE where the directory must go.
//     MEASURED: this reaches the last-resort handler (exit 3) rather than the dedicated
//     "make the store writable" message, so the assertion is about the SEMANTICS that handler
//     must keep — never READY, "verified NOTHING" said out loud, factual text kept, and a next
//     action named (as `next:` or as `what to do:`).
const unwritable = makeProject(path.join(temp, 'unwritable-store'));
fs.writeFileSync(path.join(unwritable, '.canary'), 'not a directory\n');
const rUnwritable = invoke(['setup', '--yes'], { cwd: unwritable });
const unwritableOut = `${rUnwritable.stdout}${rUnwritable.stderr}`;
console.log(unwritableOut.trimEnd());
errorCase('unwritable store', rUnwritable, (out) => /(\.canary|EEXIST|ENOTDIR|exist)/i.test(out), /(^next: |what to do: )/m);
check('unwritable store: says the run verified nothing (an internal stop is not a verdict)',
  /(verified NOTHING|nothing was verified|UNVERIFIED)/i.test(unwritableOut), unwritableOut.slice(0, 500));
check('unwritable store: still names a next action, in the shape that path uses',
  /(^next: |what to do: )/m.test(unwritableOut), unwritableOut.slice(0, 500));

// ─────────────────────────────────────────────────────────────────────────────── summary ──
console.log('\n==================== SUMMARY ====================');
console.log(`surface:  ${surfaceKind}`);
console.log(`PASS:     ${passed.length}`);
console.log(`FAIL:     ${failed.length}`);
for (const f of failed) console.log(`  - ${f}`);
console.log(`PENDING-REBUILD (source-side changes this artifact predates; NOT passes): ${pending.length}`);
for (const p of pending) console.log(`  - ${p}`);
console.log(`SKIP (host-bound; never a pass): ${skips.length}`);
for (const s of skips) console.log(`  - ${s}`);
if (failed.length === 0) {
  fs.rmSync(temp, { recursive: true, force: true });
  // The no-git fixture lives OUTSIDE the OS temp dir (it must be repo-free, §6a); it is this
  // probe's own mkdtemp directory, so it is removed here too.
  if (noGitFixture.root !== null) fs.rmSync(noGitFixture.root, { recursive: true, force: true });
  console.log('\nALL ASSERTIONS PASSED (a PENDING-REBUILD line is not one of them)');
  process.exit(0);
}
console.log(`\nFIXTURES KEPT FOR INSPECTION: ${temp}`);
if (noGitFixture.root !== null) console.log(`  (the repo-free no-git fixture root: ${noGitFixture.root})`);
process.exit(1);
