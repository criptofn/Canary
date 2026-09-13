#!/usr/bin/env node
/**
 * pre10-env-authority — blocker 1: the calling environment must not control
 * proof-authoritative execution. Every attack supplies a lying PATH (fake
 * npm/git that log their own execution), a NODE_OPTIONS preload, and
 * npm_config/NODE_PATH poison; each blocked attack must prove, from the
 * real CLI + on-disk bundles: the forged exe never ran, broken code still
 * cannot PASS, promotion cannot succeed on it, the base HEAD never moved,
 * zero accepted bundles appeared, and the evidence NAMES the trusted path
 * (resolved file inside trusted dirs + digest matching the actual bytes).
 * The honest controls (B, E) prove the hardening did not break real proof:
 * good code still PASSes and promotes.
 * M2 ceiling, restated: same-UID total forgery (rewriting the trusted npm
 * entry or node itself) is out of scope — this battery covers environment
 * INJECTION, which is the agent-reachable class.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trustedDirs } from '../../apps/cli/dist/src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const NODE_DIR = path.dirname(process.execPath);
// The probe IMPORTS the product's declared trust set rather than paraphrasing
// it: while this list was a hardcoded mirror, the assertion that polices the
// trust set could silently drift away from the set itself (which is how win32
// git ended up executing from a directory the mirror did not contain). The
// running node's bundled-package dirs are still added, because resolvePm trusts
// npm-cli.js BY BEING BUNDLED UNDER THE RUNNING NODE, not by any PATH.
const NODE_PKGS = process.platform === 'win32'
  ? [path.join(NODE_DIR, 'node_modules')]
  : [path.join(NODE_DIR, 'node_modules'), path.join(path.dirname(NODE_DIR), 'lib', 'node_modules')];
const TRUSTED = trustedDirs().concat(NODE_PKGS);
const PASS = `node "${path.join(FX, 'f-pass.js')}"`;
const BUILD = `node "${path.join(FX, 'f-build.js')}"`;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 300_000, env: env ?? process.env });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-envauth-'));

/** One poison pack: a lying bin dir + a preload that logs which process
 *  loaded it + npm env steering. Logs are per-exe so "did it run?" is
 *  decidable from disk, not from trust in the child. */
function makePoison(tag) {
  const base = path.join(TMP, `poison-${tag}`);
  const bin = path.join(base, 'liar-bin');
  fs.mkdirSync(bin, { recursive: true });
  const npmLog = path.join(base, 'liar-npm.ran');
  const gitLog = path.join(base, 'liar-git.ran');
  fs.writeFileSync(path.join(bin, 'npm'),
    `#!/bin/sh\necho "npm ran: $*" >> "${npmLog}"\necho 99.99.99-LIAR\necho "all tests passing (liar output)"\nexit 0\n`);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "git ran: $*" >> "${gitLog}"\nexit 0\n`);
  for (const f of ['npm', 'git']) fs.chmodSync(path.join(bin, f), 0o755);
  const preload = path.join(base, 'liar.cjs');
  const preLog = path.join(base, 'preload.ran');
  fs.writeFileSync(preload,
    `try { require('fs').appendFileSync(${JSON.stringify(preLog)}, (process.argv[1] ?? '?') + '\\n'); } catch {}\n`);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    NODE_OPTIONS: `--require ${preload}`,
    NODE_PATH: bin,
    npm_config_evil: '1',
    npm_config_prefix: base,
  };
  const logs = { npmLog, gitLog, preLog };
  const clean = () => { for (const p of Object.values(logs)) try { fs.unlinkSync(p); } catch { /* absent = clean */ } };
  return { env, logs, clean };
}
/** If the preload EVER ran in a Canary child, that child's script path shows
 *  up. The CLI process itself (attacker-launched) is allowed: only main.js. */
function assertPreloadNeverReachedChildren(p) {
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const bad = lines.filter((l) => !l.endsWith('main.js'));
  assert(bad.length === 0, `NODE_OPTIONS preload leaked into Canary children: ${bad.join(', ')}\n       (log: ${p})`);
}
function readBundle(root, suffix) {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith(`-${suffix}`)).sort() : [];
  assert(dirs.length > 0, `no "${suffix}" evidence bundle in ${d}`);
  const dir = path.join(d, dirs.at(-1));
  return { dir, b: JSON.parse(fs.readFileSync(path.join(dir, 'verification.json'), 'utf8')) };
}
/** The invariant, checked over every step of a bundle: named trusted bytes. */
function assertEvidenceNamesTrustedPaths(bundle, { not = [] } = {}) {
  assertEq(bundle.execPolicy, 'canary-sanitized/1', 'bundle execPolicy');
  assert(bundle.steps.length > 0, 'bundle has no steps to inspect');
  for (const s of bundle.steps) {
    assert(s.exec && typeof s.exec.file === 'string' && s.exec.file !== '', `step ${s.kind}: exec.file must name the resolved bytes`);
    assert(TRUSTED.some((td) => s.exec.file.startsWith(td + path.sep)), `step ${s.kind}: exec.file ${s.exec.file} outside trusted dirs ${TRUSTED.join(', ')}`);
    for (const bad of not) assert(!s.exec.file.includes(bad), `step ${s.kind}: exec.file touches the poison dir ${bad}`);
    assert(s.exec.via === 'node-entry' || s.exec.via === 'trusted-path' || s.exec.via === 'trusted-cmd' || s.exec.via === 'trusted-git', `step ${s.kind}: exec.via ${s.exec.via}`);
    assertEq(s.exec.policy, 'canary-sanitized/1', `step ${s.kind}: exec.policy`);
    if (/^[0-9a-f]{64}$/.test(s.exec.digest ?? '')) {
      const real = crypto.createHash('sha256').update(fs.readFileSync(s.exec.file)).digest('hex');
      assertEq(s.exec.digest, real, `step ${s.kind}: exec.digest must match the bytes it names`);
    } else {
      assert(/^size:\d+$/.test(s.exec.digest ?? '') || s.exec.digest === null, `step ${s.kind}: exec.digest shape: ${s.exec.digest}`);
    }
  }
}
function stepStdout(bundleDir, s) {
  if (!s.stdout.file) return '';
  return fs.readFileSync(path.join(bundleDir, s.stdout.file), 'utf8');
}
function makeRepo(name, scripts, files) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 2;\n');
  for (const [f, content] of Object.entries(files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), content);
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts: scripts ?? { test: PASS, build: BUILD } }, null, 2) + '\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
  return root;
}
function isolate(root, name) {
  const r = canary(['isolate', name, root], root);
  assert(r.status === 0, `isolate failed: ${r.stdout}\n${r.stderr}`);
  return path.join(root, '.canary', 'candidates', name);
}
function candCommit(c, files, msg = 'candidate work') {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(c, f)), { recursive: true });
    fs.writeFileSync(path.join(c, f), content);
  }
  git(c, 'add', '-A');
  git(c, 'commit', '-m', msg);
}
const hasPromotionBundle = (root) => {
  const d = path.join(root, '.canary', 'evidence');
  return fs.existsSync(d) && fs.readdirSync(d).some((x) => x.endsWith('-promotion'));
};

// A — the flagship forgery: broken candidate + a lying npm that exits 0.
check('A PATH liar cannot forge PASS over broken code; shadowed git never runs; promote stays locked', () => {
  // sealed test = brittle script reading src/app.js: the candidate breaks it
  // WITHOUT touching the sealed scripts (otherwise authority drift blocks the
  // verify before the plan even runs — true, but not this attack).
  const root = makeRepo('a-forge', { test: 'node scripts/brittle.js', build: BUILD },
    { 'scripts/brittle.js': 'const v = require("../src/app.js");\nprocess.exit(v === 2 ? 0 : 1);\n' });
  const poison = makePoison('a'); poison.clean();
  const c = isolate(root, 'c');
  candCommit(c, {
    'src/app.js': 'module.exports = 3; // the "fix" that breaks the contract\n',
    'tests/regress.test.js': '// honest-looking regression artifact\n',
  });
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const v = canary(['isolate', '--verify', 'c', root], root, poison.env);
  assertEq(v.status, 2, `A: broken plan + liar env must NOT reach PASS:\n${v.stdout}`);
  assert(/CANDIDATE FAIL/.test(v.stdout), `A: FAIL verdict expected:\n${v.stdout}`);
  const { dir, b } = readBundle(root, 'candidate');
  assertEq(b.status, 'fail', 'A: bundle status');
  const boom = b.steps.find((s) => s.kind === 'tests') ?? b.steps[0];
  assertEq(boom.exitCode, 1, 'A: the REAL exit code is recorded — the liar could not overwrite it');
  assert(!/liar output|99\.99\.99/i.test(stepStdout(dir, boom)), `A: liar stdout must never enter evidence:\n${stepStdout(dir, boom)}`);
  assert(!fs.existsSync(poison.logs.npmLog), 'A: lying npm was NEVER executed');
  assert(!fs.existsSync(poison.logs.gitLog), 'A: shadowed git was NEVER executed');
  assertPreloadNeverReachedChildren(poison.logs.preLog);
  assertEvidenceNamesTrustedPaths(b, { not: ['poison-a'] });
  const p = canary(['isolate', '--promote', 'c', root], root, poison.env);
  assert(p.status !== 0, `A: promotion of FAILed code must refuse:\n${p.stdout}`);
  assertEq(git(root, 'rev-parse', 'HEAD'), headBefore, 'A: base HEAD unmoved');
  assert(!hasPromotionBundle(root), 'A: zero accepted bundles');
});

// B — honest positive control: clean env, real work, real promotion.
check('B honest candidate PASSes and promotes with byte-verified trusted-path evidence', () => {
  const root = makeRepo('b-honest', { test: 'node scripts/brittle.js', build: BUILD }, {
    'scripts/brittle.js': "const fs = require('node:fs'); const expected = Number(fs.readFileSync('tests/expected.json', 'utf8')); process.exit(require('../src/app.js') === expected ? 0 : 1);\n",
    'tests/expected.json': '2\n',
  });
  const t = canary(['task', 'fix the crash', '--kind', 'bugfix'], root);
  assertEq(t.status, 0, `B: task: ${t.stdout}`);
  const poison = makePoison('b'); poison.clean();
  const c = isolate(root, 'b1');
  // This control changes only a test file, so the legitimate no-behavior-change
  // exemption keeps the hardening proof focused on trusted execution paths.
  candCommit(c, { 'src/app.js': 'module.exports = 3;\n', 'tests/expected.json': '3\n', 'tests/regress.test.js': '// regression test present\n' });
  const v = canary(['isolate', '--verify', 'b1', root], root);
  assertEq(v.status, 0, `B: honest green candidate must PASS:\n${v.stdout}`);
  assertEvidenceNamesTrustedPaths(readBundle(root, 'candidate').b, { not: ['poison-b'] });
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const p = canary(['isolate', '--promote', 'b1', root], root);
  assertEq(p.status, 0, `B: positive control promotion:\n${p.stdout}`);
  assert(git(root, 'rev-parse', 'HEAD') !== headBefore, 'B: base advanced by the promotion');
  assert(!fs.existsSync(poison.logs.npmLog), 'B: honest path never consults PATH liars either');
});

// C — setup poisoning: pm detection AND smoke under lying PATH + preload.
check('C setup under poisoned env: READY is earned by trusted bytes only (detection + smoke)', () => {
  const root = path.join(TMP, 'c-setup');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'c-setup', private: true, scripts: { test: PASS, build: BUILD } }, null, 2) + '\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const poison = makePoison('c'); poison.clean();
  const s = canary(['setup', '--yes', root], root, poison.env);
  assertEq(s.status, 0, `C: setup must still succeed honestly:\n${s.stdout}`);
  assert(!/99\.99\.99-LIAR/.test(s.stdout), 'C: liar version text must never appear — pm detection used trusted bytes');
  assert(!fs.existsSync(poison.logs.npmLog), 'C: lying npm NEVER ran during detection or smoke');
  assert(!fs.existsSync(poison.logs.gitLog), 'C: shadowed git NEVER ran');
  assertPreloadNeverReachedChildren(poison.logs.preLog);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
  assertEq(cfg.pm, 'npm', 'C: sealed pm recorded');
  assertEvidenceNamesTrustedPaths(readBundle(root, 'setup').b, { not: ['poison-c'] });
});

// D — the child itself testifies: an env-witness script in the plan proves
// stripping, while npm_config_*/NODE_OPTIONS/NODE_PATH/PATH all carry poison.
check('D NODE_OPTIONS + npm_config_* + PATH poison during verify: children see a clean env; bundle records the attempted overrides', () => {
  const root = path.join(TMP, 'd-witness');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'witness.js'), [
    'const fs = require("fs"), p = require("path");',
    'const leak = [];',
    'for (const k of ["NODE_OPTIONS", "NODE_PATH"]) if (process.env[k]) leak.push(k);',
    // npm legitimately SETS npm_config_* in its children; what must not
    // survive is the CALLER-INJECTED keys and values.
    'if (process.env.npm_config_evil) leak.push("npm_config_evil");',
    'if ((process.env.npm_config_prefix || "").includes("poison-d")) leak.push("npm_config_prefix");',
    'if ((process.env.PATH || "").split(p.delimiter).some((x) => x.includes("liar-bin"))) leak.push("PATH");',
    'if (process.execArgv.some((a) => a.includes("liar"))) leak.push("execArgv");',
    'if (leak.length) { console.log("ENV-LEAK " + leak.join(",")); process.exit(1); }',
    'console.log("ENV-CLEAN");',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'd-witness', private: true, scripts: { test: 'node scripts/witness.js', build: BUILD } }, null, 2) + '\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const s0 = canary(['setup', '--yes', root], root);
  assertEq(s0.status, 0, `D: baseline setup: ${s0.stdout}`);
  const t = canary(['task', 'restyle the about page', '--kind', 'ui'], root);
  assertEq(t.status, 0, `D: task: ${t.stdout}`);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/about.js': 'styled\n' });
  const poison = makePoison('d'); poison.clean();
  const v = canary(['isolate', '--verify', 'c', root], root, poison.env);
  const { dir, b } = readBundle(root, 'candidate');
  const test = b.steps.find((x) => x.kind === 'tests');
  assert(test && test.ok && test.exitCode === 0, `D: witness step must be green (child env was clean):\n${JSON.stringify(b.steps.map((x) => [x.kind, x.exitCode]))}`);
  assert(/ENV-CLEAN/.test(stepStdout(dir, test)), `D: witness testimony missing from evidence:\n${stepStdout(dir, test)}`);
  assertEq(v.status, 2, 'D: ui kind still holds the verdict at the split (env poison or not)');
  assert(/NODE_OPTIONS/.test(JSON.stringify(b.envOverrides)), `D: the bundle must NAME the overrides it ignored:\n${JSON.stringify(b.envOverrides)}`);
  assert(/npm_config_evil/.test(JSON.stringify(b.envOverrides)), 'D: npm_config_* named in envOverrides');
  assert(!fs.existsSync(poison.logs.npmLog), 'D: liar npm never ran');
  assertPreloadNeverReachedChildren(poison.logs.preLog);
  assertEvidenceNamesTrustedPaths(b, { not: ['poison-d'] });
});

// E — poisoned promote on an honestly green candidate: the liar cannot steer
// the promotion either way (neither forge, nor block, nor substitute bytes).
check('E promote under poisoned env: honest PASS still promotes; evidence still names trusted bytes', () => {
  const root = makeRepo('e-promote', { test: 'node scripts/brittle.js', build: BUILD }, {
    'scripts/brittle.js': "const fs = require('node:fs'); const expected = Number(fs.readFileSync('tests/expected.json', 'utf8')); process.exit(require('../src/app.js') === expected ? 0 : 1);\n",
    'tests/expected.json': '2\n',
  });
  const t = canary(['task', 'fix the crash', '--kind', 'bugfix'], root);
  assertEq(t.status, 0, `E: task: ${t.stdout}`);
  const c = isolate(root, 'c');
  candCommit(c, { 'src/app.js': 'module.exports = 3;\n', 'tests/expected.json': '3\n', 'tests/regress.test.js': '// test\n' });
  const poison = makePoison('e'); poison.clean();
  const v = canary(['isolate', '--verify', 'c', root], root, poison.env);
  assertEq(v.status, 0, `E: verify under poison must still PASS honestly:\n${v.stdout}`);
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const p = canary(['isolate', '--promote', 'c', root], root, poison.env);
  assertEq(p.status, 0, `E: promote under poison:\n${p.stdout}`);
  assert(git(root, 'rev-parse', 'HEAD') !== headBefore, 'E: base advanced — promotion used trusted git');
  assert(!fs.existsSync(poison.logs.npmLog) && !fs.existsSync(poison.logs.gitLog), 'E: no liar process ran for a single step of it');
  const pr = fs.readdirSync(path.join(root, '.canary', 'evidence')).filter((x) => x.endsWith('-promotion'));
  assert(pr.length === 1, 'E: exactly one promotion bundle');
  assertEvidenceNamesTrustedPaths(readBundle(root, 'promotion').b, { not: ['poison-e'] });
});

console.log(`\n=== pre10-env-authority: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ===`);
process.exit(failures === 0 ? 0 : 1);
