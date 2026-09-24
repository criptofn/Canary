#!/usr/bin/env node
/**
 * AUDIT BLOCKER 6 (v1.5) — SEALED TOOLCHAIN / FALSE PROJECT BLAME.
 *
 * WHAT THIS PROBE MEASURES, on THIS host, with the BUILT CLI:
 *
 *  A. The difference the auditor reproduced: a sealed step child gets a PATH built only from the
 *     Node install dir and the OS dirs, so a program the ambient shell resolves (`git`, `java`,
 *     `python`) can be invisible to the project's own check — same command, same host, different
 *     answer inside Canary.
 *  B. That the security decision is PRESERVED, not traded away: the calling PATH is still ignored, so
 *     a `git.cmd` planted earlier on that PATH is never executed as sealed authority.
 *  C/D. That the product now names the right cause: `CANARY SEALED ENVIRONMENT CANNOT RESOLVE REQUIRED
 *     TOOLCHAIN` when Canary's own restriction is the cause, `PROJECT CHECK FAILURE` when the project
 *     genuinely fails — and never the false "That is your project talking, not Canary."
 *  E. That the remediation NAMES the missing executable and prints a command that actually works: the
 *     suggested directory is checked to contain that executable, and running the suggested setup makes
 *     the same project's same check PASS inside Canary.
 *
 * WHAT IT DOES NOT PROVE: nothing about Java/Python toolchains beyond what THIS host has (each is
 * measured, and only asserted when the ambient environment provided it); nothing about locale-specific
 * "not found" text (the resolution walk decides attribution, not the text alone); nothing about
 * `--toolchain-dir` being safe against an operator who authorizes a directory the worker can write
 * (that is refused inside the repository — asserted below — but a writable directory OUTSIDE it is the
 * operator's own call, and the product says so).
 *
 * FIXTURES: OS temp dir only. EXIT: 0 only when every PASS line held.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'src', 'main.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-v15-sealed-toolchain-'));
const TRUST = path.join(TMP, 'trust-store');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

assert(fs.existsSync(CLI), `missing built CLI: ${CLI} — run: npm exec -- tsc -b apps/cli --force`);

// ---------------------------------------------------------------- fixture: a CLEAN project whose own
// check shells out to a tool the ambient environment has. This is the auditor's shape: `npm test`
// spawns a program Canary never named.
const CANDIDATES = ['git', 'java', 'python', 'python3', 'node', 'npm'];

const CHECK_CJS = `'use strict';
// A project check of the ordinary kind: it dumps the environment it was handed (so the sealed vs
// ambient difference is MEASURED), then runs a tool the project itself depends on through the
// platform shell (so a missing tool fails the way a real check fails: exit 9009 / 127 plus the
// loader's own "not recognized" / "not found" text).
//
// The dump is written OUTSIDE the repository on purpose: a check that leaves an untracked file in the
// tree makes the tree dirty, and Canary then (correctly) refuses to attribute the change to the
// worker. That is a fixture trap this probe walked into on its first run, and the v13 vocabulary
// probe documents the same lesson.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const DUMP_DIR = path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), 'canary-v15st-dump');
fs.mkdirSync(DUMP_DIR, { recursive: true });
const OUT = path.join(DUMP_DIR, path.basename(__dirname) + '.json');
const candidates = ${JSON.stringify(CANDIDATES)};
const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const resolved = {};
for (const name of candidates) {
  resolved[name] = null;
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const c = path.join(dir, name + ext);
      try { if (fs.statSync(c).isFile()) { resolved[name] = c; break; } } catch {}
    }
    if (resolved[name]) break;
  }
}
fs.writeFileSync(OUT, JSON.stringify({
  path: process.env.PATH || null,
  pathDirs: dirs,
  pathDirCount: dirs.length,
  envKeyCount: Object.keys(process.env).length,
  JAVA_HOME: process.env.JAVA_HOME ?? null,
  resolved,
}, null, 2));
const win = process.platform === 'win32';
const r = win
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'git --version'], { stdio: 'inherit' })
  : spawnSync('/bin/sh', ['-c', 'git --version'], { stdio: 'inherit' });
process.exit(r.status === null ? 127 : r.status);
`;

function makeFixture(name, scripts, extraFiles = {}) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name, private: true, version: '0.0.0', scripts }, null, 2)}\n`);
  for (const [file, body] of Object.entries(extraFiles)) fs.writeFileSync(path.join(root, file), body);
  const gitArgs = [['init', '-b', 'main'], ['config', 'user.email', 'probe@canary.local'], ['config', 'user.name', 'Sealed Toolchain Probe'], ['add', '-A'], ['commit', '-m', 'initial']];
  for (const a of gitArgs) {
    const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 60_000 });
    assert(r.status === 0, `fixture git ${a[0]} failed: ${r.stdout}${r.stderr}`);
  }
  return root;
}

const canaryEnv = (extra = {}) => ({ ...process.env, CANARY_TRUST_STORE: TRUST, ...extra });
const canary = (root, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: canaryEnv(extra), encoding: 'utf8', timeout: 900_000 });
/** The fixture check's dump — written OUTSIDE the repo, so a run leaves the tree exactly as it found it. */
const dumpOf = (root) => {
  const name = `${path.basename(root)}.json`;
  for (const base of [process.env.TEMP ?? os.tmpdir(), path.join(process.env.TEMP ?? os.tmpdir(), 'tmp'), os.tmpdir()]) {
    const p = path.join(base, 'canary-v15st-dump', name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error(`no environment dump for ${root} — the fixture check did not run`);
};

/** How the AMBIENT environment resolves a program — measured here, never hardcoded. */
function ambientResolve(program) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      const c = path.join(dir, program + ext);
      try { if (fs.statSync(c).isFile()) return c; } catch { /* keep walking */ }
    }
  }
  return null;
}

const ambientTools = Object.fromEntries(CANDIDATES.map((c) => [c, ambientResolve(c)]));
console.log('--- this host\'s ambient toolchain (measured, not assumed) ---');
for (const [name, abs] of Object.entries(ambientTools)) console.log(`  ${name.padEnd(8)} ${String(abs)}`);

// The ambient check the fixture declares: `npm test` outside Canary. It is the SAME command Canary
// will run — that is what makes the inside/outside difference attributable to Canary.
const outside = makeFixture('outside', { test: 'node check.cjs' }, { 'check.cjs': CHECK_CJS });
const outsideRun = spawnSync(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['-c', 'npm test'],
  { cwd: outside, encoding: 'utf8', timeout: 300_000 });
const outsideDump = dumpOf(outside);
console.log(`\n--- outside Canary: npm test -> exit ${outsideRun.status}`);
console.log(`    PATH entries ${outsideDump.pathDirCount}, env keys ${outsideDump.envKeyCount}, JAVA_HOME=${String(outsideDump.JAVA_HOME)}`);
console.log(`    resolves: ${CANDIDATES.map((c) => `${c}=${outsideDump.resolved[c] ? 'yes' : 'no'}`).join(' ')}`);

check('A1 the fixture\'s own check PASSES outside Canary (the control the audit used)', () => {
  assert(outsideRun.status === 0, `npm test exited ${outsideRun.status} outside Canary:\n${outsideRun.stdout}${outsideRun.stderr}`);
  assert(outsideDump.resolved.git !== null, 'the control fixture needs a resolvable `git`, and this host has none');
});

// ---------------------------------------------------------------- inside Canary, nothing authorized
const inside = makeFixture('inside', { test: 'node check.cjs' }, { 'check.cjs': CHECK_CJS });
const failuresBefore = (() => {
  const r = canary(inside, ['setup', '--yes']);
  return { r, dump: dumpOf(inside) };
})();
const beforeOut = `${failuresBefore.r.stdout}${failuresBefore.r.stderr}`;
console.log(`\n--- inside Canary (no --toolchain-dir): setup exit ${failuresBefore.r.status}`);
console.log(`    PATH entries ${failuresBefore.dump.pathDirCount}, env keys ${failuresBefore.dump.envKeyCount}, JAVA_HOME=${String(failuresBefore.dump.JAVA_HOME)}`);
console.log(`    resolves: ${CANDIDATES.map((c) => `${c}=${failuresBefore.dump.resolved[c] ? 'yes' : 'no'}`).join(' ')}`);
console.log(`    sealed PATH = ${failuresBefore.dump.path}`);
console.log('    verdict line:');
for (const line of beforeOut.split(/\r?\n/).filter((l) => /CANARY SEALED|PROJECT CHECK|project talking|not resolvable/.test(l))) console.log(`      ${line.trim()}`);

check('A2 the sealed step PATH is BUILT, not inherited (fewer entries than the shell, different text)', () => {
  assert(failuresBefore.dump.path !== outsideDump.path, 'the sealed step was handed the shell PATH verbatim');
  assert(failuresBefore.dump.pathDirCount < outsideDump.pathDirCount,
    `sealed ${failuresBefore.dump.pathDirCount} entries vs ambient ${outsideDump.pathDirCount} — no narrowing observed`);
});

check('A3 a program the ambient shell resolves can be invisible to the sealed step (the defect)', () => {
  const lost = CANDIDATES.filter((c) => outsideDump.resolved[c] && !beforeDumpResolves(c));
  function beforeDumpResolves(c) { return failuresBefore.dump.resolved[c] !== null; }
  console.log(`     visible outside but NOT inside: ${lost.length ? lost.join(', ') : '(none)'}`);
  assert(lost.includes('git'), 'the control program `git` was expected to be invisible in the sealed environment on this host');
});

check('D1 the verdict is the ENVIRONMENT outcome, with the required vocabulary', () => {
  assert(/CANARY SEALED ENVIRONMENT CANNOT RESOLVE REQUIRED TOOLCHAIN/.test(beforeOut),
    `setup did not print the environment outcome. Output tail:\n${beforeOut.split(/\r?\n/).slice(-12).join('\n')}`);
  assert(failuresBefore.r.status !== 0, 'setup reported success while its own check could not run');
});

check('D2 Canary does NOT blame the project for its own restriction (the false attribution is gone)', () => {
  assert(!/That is your project talking, not Canary\./.test(beforeOut),
    'the false attribution is still printed for an environment-caused failure');
  assert(!/PROJECT CHECK FAILURE/.test(beforeOut), 'a project-failure word was printed for an environment-caused failure');
});

check('E1 the remediation NAMES the missing executable and a command that can be run', () => {
  assert(/\bgit\b/.test(beforeOut), 'the missing executable `git` is not named');
  const m = beforeOut.match(/canary setup --toolchain-dir "([^"]+)"/);
  assert(m !== null, `no actionable command was printed. Output tail:\n${beforeOut.split(/\r?\n/).slice(-12).join('\n')}`);
  const suggested = m[1];
  assert(fs.existsSync(path.join(suggested, 'git.exe')) || fs.existsSync(path.join(suggested, 'git.cmd')) || fs.existsSync(path.join(suggested, 'git')),
    `the suggested directory does not contain git: ${suggested}`);
});

check('D5 the COMPLETION GATE tells the agent the environment is the cause, not the project', () => {
  // The gate is the message a worker reads before it decides what to repair. If Canary's own
  // restriction caused the failure and the gate says "your checks failed", the worker repairs a
  // project that was never at fault — the same defect, one surface later.
  const gate = spawnSync(process.execPath, [CLI, 'checkpoint'], {
    cwd: inside, env: canaryEnv(), encoding: 'utf8', timeout: 300_000,
    input: JSON.stringify({ stop_hook_active: false, cwd: inside }),
  });
  let payload = null;
  try { payload = JSON.parse((gate.stdout ?? '').trim()); } catch { payload = null; }
  assert(payload !== null, `checkpoint printed no envelope: ${(gate.stdout ?? '').slice(0, 300)}${(gate.stderr ?? '').slice(0, 300)}`);
  assert(payload.decision === 'block', `checkpoint did not block a failing plan: ${JSON.stringify(payload).slice(0, 300)}`);
  const reason = String(payload.reason ?? '');
  assert(/CANARY SEALED ENVIRONMENT CANNOT RESOLVE REQUIRED TOOLCHAIN/.test(reason),
    `the agent was not told the environment is the cause:\n${reason.slice(0, 600)}`);
  assert(!/That is your project talking/.test(reason), 'the completion gate still blamed the project');
});

check('B1 the calling PATH is still IGNORED: a planted `git.cmd` earlier on it is never executed', () => {
  // A shim directory prepended to the CALLER's PATH, in front of the real git. Canary must not run it.
  const shimDir = path.join(TMP, 'planted-shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const marker = path.join(TMP, 'shim-ran.txt');
  fs.writeFileSync(path.join(shimDir, 'git.cmd'), `@echo off\r\necho SHIM RAN > "${marker}"\r\ngit --version\r\n`);
  const planted = makeFixture('planted', { test: 'node check.cjs' }, { 'check.cjs': CHECK_CJS });
  const r = canary(planted, ['setup', '--yes'], { PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` });
  const out = `${r.stdout}${r.stderr}`;
  assert(!fs.existsSync(marker), 'Canary EXECUTED a program planted earlier on the calling PATH — the security decision is broken');
  assert(!/SHIM RAN/.test(out), 'the planted shim ran inside the sealed step');
  assert(r.status !== 0, 'the planted-shim run unexpectedly succeeded');
});

// ---------------------------------------------------------------- the same project, authorized
const gitDir = ambientTools.git === null ? null : path.dirname(ambientTools.git);
const authorizedDirs = [];
for (const tool of ['git', 'java', 'python']) {
  if (ambientTools[tool] !== null) authorizedDirs.push(path.dirname(ambientTools[tool]));
}
const uniqueDirs = [...new Set(authorizedDirs)];
const authArgs = uniqueDirs.flatMap((d) => ['--toolchain-dir', d]);
console.log(`\n--- authorizing (operator act): ${uniqueDirs.map((d) => `"${d}"`).join(' ')}`);
const auth = canary(inside, ['setup', '--yes', ...authArgs]);
const authOut = `${auth.stdout}${auth.stderr}`;
const authDump = dumpOf(inside);
console.log(`    setup exit ${auth.status}; sealed PATH entries ${authDump.pathDirCount}`);
console.log(`    sealed PATH = ${authDump.path}`);
console.log(`    resolves: ${CANDIDATES.map((c) => `${c}=${authDump.resolved[c] ? 'yes' : 'no'}`).join(' ')}`);

check('C1 an operator-authorized directory is appended to the sealed step PATH (after the trusted dirs)', () => {
  assert(auth.status === 0, `setup with --toolchain-dir exited ${auth.status}:\n${authOut.split(/\r?\n/).slice(-12).join('\n')}`);
  assert(authDump.pathDirs.length > failuresBefore.dump.pathDirCount,
    `the sealed PATH did not grow: ${authDump.pathDirCount} entries`);
  for (const d of uniqueDirs) {
    const idx = authDump.pathDirs.findIndex((p) => p.toLowerCase() === d.toLowerCase());
    assert(idx >= 0, `authorized directory is not on the sealed PATH: ${d}`);
    assert(idx >= 3, `authorized directory ${d} was placed at index ${idx}, i.e. ahead of Canary's own trusted dirs`);
  }
});

check('C2 the SAME project check now PASSES inside Canary (the defect is closed, not hidden)', () => {
  // The repo where the failure happened, fixed by the command the failure itself printed — the
  // operator's real flow. (Nothing but Canary's own self-ignoring/excluded wiring files was written
  // by the failed setup, so this second setup still sees the clean tree the first one stamped.)
  const again = canary(inside, ['setup', '--yes', ...authArgs]);
  const againOut = `${again.stdout}${again.stderr}`;
  assert(again.status === 0, `setup with authorization exited ${again.status}:\n${againOut.split(/\r?\n/).slice(-14).join('\n')}`);
  assert(/READY/.test(againOut), `setup did not report READY after authorization:\n${againOut.split(/\r?\n/).slice(-8).join('\n')}`);
  const doctorRun = canary(inside, ['doctor', '--json']);
  let env = null;
  try { env = JSON.parse(doctorRun.stdout); } catch { env = null; }
  assert(doctorRun.status === 0, `doctor exited ${doctorRun.status} after authorization:\n${doctorRun.stdout.slice(0, 600)}${doctorRun.stderr.slice(0, 400)}`);
  assert(env === null || env.status === 'READY', `doctor status was ${String(env?.status)}`);
  const post = dumpOf(inside);
  assert(post.path.includes(uniqueDirs[0]), 'the authorized directory is not in the child PATH');
  assert(post.resolved.git !== null, 'git still does not resolve in the sealed environment');
});

check('C3 every tool the AMBIENT environment provided now resolves inside Canary too', () => {
  for (const tool of ['git', 'java', 'python', 'python3']) {
    if (ambientTools[tool] === null && outsideDump.resolved[tool] === null) { console.log(`     (host has no ${tool} — not asserted)`); continue; }
    assert(authDump.resolved[tool] !== null, `${tool} resolves outside Canary and not inside, after its directory was authorized`);
  }
});

check('C4 a path with SPACES is authorized and used verbatim', () => {
  const spaced = uniqueDirs.filter((d) => d.includes(' '));
  if (spaced.length === 0) { console.log('     (no ambient toolchain directory contains a space on this host — see the unit test for the staged case)'); return; }
  for (const d of spaced) assert(authDump.pathDirs.some((p) => p === d), `directory with a space was mangled: ${d}`);
  assert(authDump.resolved.git !== null, 'git did not resolve through a spaced directory');
});

check('C5 a directory INSIDE the repository is REFUSED (a worker cannot authorize its own shim)', () => {
  const evil = path.join(inside, 'node_modules', '.bin');
  fs.mkdirSync(evil, { recursive: true });
  const r = canary(inside, ['setup', '--yes', '--toolchain-dir', evil]);
  const out = `${r.stdout}${r.stderr}`;
  assert(r.status !== 0, 'setup accepted a toolchain directory inside the repository');
  assert(/not authorize that toolchain directory/i.test(out), `the refusal was not explained:\n${out.split(/\r?\n/).slice(-8).join('\n')}`);
  // and nothing was written: the previously sealed authority is intact
  const cfg = JSON.parse(fs.readFileSync(path.join(inside, '.canary', 'canary.local.json'), 'utf8'));
  assert((cfg.toolchain?.dirs ?? []).every((d) => !d.startsWith(inside)), 'a repository-local directory reached the sealed config');
});

// ---------------------------------------------------------------- the other outcome, on purpose
const broken = makeFixture('broken', { test: 'node failing-check.cjs' }, {
  'failing-check.cjs': "'use strict';\nconsole.error('1 !== 2 — the project\\'s own assertion failed');\nprocess.exit(1);\n",
});
const brokenRun = canary(broken, ['setup', '--yes']);
const brokenOut = `${brokenRun.stdout}${brokenRun.stderr}`;
check('D3 a genuinely failing project check is reported as a PROJECT CHECK FAILURE (no overclaim in reverse)', () => {
  assert(brokenRun.status !== 0, 'a failing check reported success');
  assert(/PROJECT CHECK FAILURE/.test(brokenOut), `the project-failure outcome is missing:\n${brokenOut.split(/\r?\n/).slice(-10).join('\n')}`);
  assert(!/CANARY SEALED ENVIRONMENT CANNOT RESOLVE/.test(brokenOut), 'a plain assertion failure was blamed on Canary\'s environment');
});

check('D4 a project that merely PRINTS a "not found" line cannot move the attribution', () => {
  const faker = makeFixture('faker', { test: 'node fake-not-found.cjs' }, {
    'fake-not-found.cjs': "'use strict';\nconsole.error(\"sh: 1: java: not found\");\nconsole.error('and my assertion failed anyway');\nprocess.exit(1);\n",
  });
  const r = canary(faker, ['setup', '--yes', ...authArgs]);
  const out = `${r.stdout}${r.stderr}`;
  assert(/PROJECT CHECK FAILURE/.test(out),
    `a printed "java: not found" moved the blame while java WAS resolvable in the sealed environment:\n${out.split(/\r?\n/).slice(-10).join('\n')}`);
  assert(!/CANARY SEALED ENVIRONMENT CANNOT RESOLVE/.test(out), 'the fake signature was taken as an environment fact');
});

console.log(`\nartifacts: ${TMP}`);
console.log(`${failures === 0 ? 'SEALED-TOOLCHAIN PROBE PASSED' : `SEALED-TOOLCHAIN PROBE FAILED (${failures} failure(s))`}`);
process.exit(failures === 0 ? 0 : 1);
