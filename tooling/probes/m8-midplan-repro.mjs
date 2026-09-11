#!/usr/bin/env node
/**
 * DIAGNOSTIC (not a gate): reproduce the `m8-promotion.mjs` "midplan" fixture
 * command directly inside the temp repository that fixture builds, and capture
 * COMPLETE stdout + stderr — including the lines the product's `tail` (last 12
 * lines, onboarding.ts `Out.step`) and the probe's own failure message truncate.
 *
 * The m8 midplan scenario failed with `✗ tests: npm run test (exit 1)` and a
 * stack tail that named `node:internal/modules/cjs/loader`. The head of that
 * error — which is the only part that says WHAT failed — was cut twice. This
 * probe exists to print it.
 *
 * It reproduces the fixture byte-for-byte from m8-promotion.mjs and then:
 *   1. runs the sealed step the way the PRODUCT runs it (the product's own
 *      `sanitizedEnv` + resolved `npm`),
 *   2. runs the same fixture command in the CALLER's environment, as a control,
 *   3. reports which programs the sanitized PATH can actually resolve.
 *
 * Temp dir is KEPT by default so it can be inspected; `CANARY_REPRO_CLEAN=1`
 * removes it. Exits 0 when the diagnosis completed (this is not a gate).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const SUPPORT = path.join(REPO, 'packages', 'support', 'dist', 'src', 'index.js');
const ONBOARDING = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'onboarding.js');

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);
assert(fs.existsSync(SUPPORT), `missing built support package: ${SUPPORT}`);

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function banner(t) { console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`); }
function dump(label, s) {
  console.log(`\n--- ${label} (${s === null || s === undefined ? 'null' : `${s.length} chars`}) ---`);
  if (s === null || s === undefined) { console.log('(null)'); return; }
  // complete: no slicing, no pattern filter. Indent so nested newlines stay readable.
  console.log(s.split('\n').map((l) => `| ${l}`).join('\n'));
}

const { sanitizedEnv } = await import(`file://${SUPPORT.replace(/\\/g, '/')}`);
const { gitExe, trustedDirs, resolveProgram } = await import(`file://${ONBOARDING.replace(/\\/g, '/')}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m8-midplan-repro-'));
const NODE_DIR = path.dirname(process.execPath);

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} (in ${dir}) failed: ${r.stderr?.trim() || r.stdout?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
}
// ---- byte-for-byte copy of m8-promotion.mjs makeRepo() ----
function makeRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: 'node checks/verify.js' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'checks', 'verify.js'),
    "const fs = require('node:fs');\nprocess.exit(fs.readFileSync('marker.txt', 'utf8').includes('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(root, 'marker.txt'), 'ok\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
  const t = canary(['task', 'behavior-preserving probe change', '--kind', 'refactor'], root);
  assert(t.status === 0, `task registration failed: ${t.stdout}\n${t.stderr}`);
  return root;
}
const candPath = (root, name) => path.join(root, '.canary', 'candidates', name);

console.log(`temp repo root: ${TMP}`);
console.log(`node: ${process.execPath}`);
console.log(`NODE_DIR: ${NODE_DIR}`);
console.log(`gitExe() (product resolution): ${String(gitExe())}`);
console.log(`trustedDirs(): ${JSON.stringify(trustedDirs(), null, 2)}`);

const mp = makeRepo('midplan');
assert(canary(['isolate', 's1', mp], mp).status === 0, 'isolate failed');
const c = candPath(mp, 's1');
fs.writeFileSync(path.join(c, 'marker.txt'), 'FAIL\n'); // committed red
git(c, 'add', '-A'); git(c, 'commit', '-m', 'red');
// the sealed step turns green AND commits while running — EXACT sealed text
// from m8-promotion.mjs:268-271
fs.writeFileSync(path.join(c, 'checks', 'verify.js'),
  "const fs=require('node:fs');const {execSync}=require('node:child_process');\n" +
  "if(fs.readFileSync('marker.txt','utf8').includes('FAIL')){fs.writeFileSync('marker.txt','ok\\n');execSync('git add -A && git commit -m midplan-fix',{stdio:'ignore'});}\n" +
  'process.exit(0);\n');
git(c, 'add', '-A'); git(c, 'commit', '-m', 'step commits mid-run');

banner('FIXTURE STATE');
console.log(`candidate dir: ${c}`);
console.log(`candidate .git: ${fs.existsSync(path.join(c, '.git')) ? (fs.statSync(path.join(c, '.git')).isDirectory() ? 'DIRECTORY (real repo)' : `FILE -> ${fs.readFileSync(path.join(c, '.git'), 'utf8').trim()}`) : 'ABSENT'}`);
console.log(`git HEAD: ${git(c, 'rev-parse', 'HEAD')}`);
console.log(`git status --porcelain:\n${git(c, 'status', '--porcelain') || '(clean)'}`);
console.log(`\nchecks/verify.js as sealed:\n${fs.readFileSync(path.join(c, 'checks', 'verify.js'), 'utf8')}`);
console.log(`marker.txt: ${JSON.stringify(fs.readFileSync(path.join(c, 'marker.txt'), 'utf8'))}`);

// ---------------------------------------------------------------- 1. product path
banner('RUN 1: the sealed step command, in the PRODUCT\'s sanitized environment');
const prodEnv = sanitizedEnv({ ws: { root: os.tmpdir(), fixture: c }, nodeDir: NODE_DIR });
console.log(`sanitizedEnv PATH = ${prodEnv.PATH}`);
console.log(`sanitizedEnv keys = ${JSON.stringify(Object.keys(prodEnv).sort())}`);
const npm = resolveProgram('npm');
console.log(`resolveProgram('npm') = ${JSON.stringify(npm)}`);
if (npm !== null) {
  const argv = [...npm.spawnArgv, 'run', 'test'];
  console.log(`executing (shell:false): ${JSON.stringify(argv)}\n`);
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: c, encoding: 'utf8', timeout: 120_000, env: prodEnv, shell: false, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  console.log(`status=${r.status} signal=${r.signal} error=${r.error ? `${r.error.code ?? ''} ${r.error.message}` : 'none'}`);
  dump('PRODUCT-ENV stdout', r.stdout);
  dump('PRODUCT-ENV stderr (COMPLETE — this is the block the product tail-truncated)', r.stderr);
}

// ---------------------------------------------------------------- 2. caller control
banner('RUN 2: same command in the CALLER\'s environment (control)');
{
  const r = spawnSync(npm !== null ? npm.spawnArgv[0] : 'npm', npm !== null ? [...npm.spawnArgv.slice(1), 'run', 'test'] : ['run', 'test'],
    { cwd: c, encoding: 'utf8', timeout: 120_000, shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  console.log(`status=${r.status} signal=${r.signal} error=${r.error ? `${r.error.code ?? ''} ${r.error.message}` : 'none'}`);
  dump('CALLER-ENV stdout', r.stdout);
  dump('CALLER-ENV stderr', r.stderr);
}

// ---------------------------------------------------------------- 3. what the fixture needs
banner('RUN 3: can the fixture\'s own `git` requirement be met under each PATH?');
function whichIn(env, prog) {
  const r = spawnSync(process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
    process.platform === 'win32' ? ['/d', '/s', '/c', `where ${prog}`] : ['-c', `command -v ${prog}`],
    { encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
  return { status: r.status, out: (r.stdout ?? '').trim() };
}
console.log(`\n-- under the PRODUCT's sanitized PATH (${prodEnv.PATH}) --`);
for (const prog of ['git', 'node', 'npm']) console.log(`  where ${prog.padEnd(5)} -> status=${whichIn(prodEnv, prog).status} ${whichIn(prodEnv, prog).out.replace(/\n/g, ' | ')}`);
console.log(`\n-- under the CALLER's PATH --`);
for (const prog of ['git', 'node', 'npm']) console.log(`  where ${prog.padEnd(5)} -> status=${whichIn(process.env, prog).status} ${whichIn(process.env, prog).out.replace(/\n/g, ' | ')}`);

// the decisive single step: does the fixture's execSync target work in the product env?
banner('RUN 4: the fixture\'s exact in-step command, product env vs caller env');
for (const [label, env] of [['product-env', prodEnv], ['caller-env', process.env]]) {
  const r = spawnSync('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'git add -A && git commit -m midplan-fix', '--allow-empty'],
    { cwd: c, encoding: 'utf8', timeout: 60_000, env, shell: false, windowsHide: true });
  console.log(`[${label}] status=${r.status} error=${r.error ? r.error.code : 'none'}`);
  dump(`[${label}] stdout`, r.stdout);
  dump(`[${label}] stderr`, r.stderr);
}

// ---------------------------------------------------------------- 5. candidate fix
banner('RUN 5: would pinning GIT to its ABSOLUTE path fix the step under the product env?');
const absGit = (() => {
  const p = process.platform === 'win32'
    ? spawnSync('where', ['git.exe'], { encoding: 'utf8', timeout: 15_000 })
    : spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 15_000 });
  return (p.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
})();
console.log(`absolute git resolved on the caller PATH: ${String(absGit)}`);
{
  // restore the red state, then run the FIXED fixture (execFileSync + absolute git)
  fs.writeFileSync(path.join(c, 'marker.txt'), 'FAIL\n');
  spawnSync(absGit ?? 'git', ['-C', c, 'add', '-A'], { encoding: 'utf8' });
  spawnSync(absGit ?? 'git', ['-C', c, 'commit', '-m', 'restore-red'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(c, 'checks', 'verify.js'),
    "const fs=require('node:fs');const {execFileSync}=require('node:child_process');\n" +
    `const GIT=${JSON.stringify(absGit)};\n` +
    "if(fs.readFileSync('marker.txt','utf8').includes('FAIL')){fs.writeFileSync('marker.txt','ok\\n');" +
    "execFileSync(GIT,['add','-A'],{stdio:'pipe'});execFileSync(GIT,['commit','-m','midplan-fix'],{stdio:'pipe'});}\n" +
    'process.exit(0);\n');
  console.log(`before: HEAD=${git(c, 'rev-parse', 'HEAD')} marker=${JSON.stringify(fs.readFileSync(path.join(c, 'marker.txt'), 'utf8'))}`);
  const r = spawnSync(npm.spawnArgv[0], [...npm.spawnArgv.slice(1), 'run', 'test'],
    { cwd: c, encoding: 'utf8', timeout: 120_000, env: prodEnv, shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  console.log(`status=${r.status} signal=${r.signal}`);
  dump('FIXED-FIXTURE product-env stdout', r.stdout);
  dump('FIXED-FIXTURE product-env stderr', r.stderr);
  console.log(`after:  HEAD=${git(c, 'rev-parse', 'HEAD')} marker=${JSON.stringify(fs.readFileSync(path.join(c, 'marker.txt'), 'utf8'))}`);
  console.log(`after:  status --porcelain: ${git(c, 'status', '--porcelain') || '(clean)'}`);
}

banner('RESULT');
console.log('If RUN 4 product-env fails while caller-env succeeds, the fixture depends on the');
console.log('CALLER PATH, which the product deliberately ignores (docs/SECURITY.md: sanitizedEnv).');
console.log('If RUN 5 succeeds (status=0 and HEAD moved), pinning the absolute git path is the fix.');
console.log(`temp repo kept at: ${TMP}`);
if (process.env.CANARY_REPRO_CLEAN === '1') {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 4 });
  console.log('(removed: CANARY_REPRO_CLEAN=1)');
}
process.exit(0);
