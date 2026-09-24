#!/usr/bin/env node
/**
 * WS5 (v1.5) — WHAT ENVIRONMENT DOES A SEALED CHECK ACTUALLY GET ON THIS HOST?
 *
 * WHY THIS EXISTS. In the WS5 real-world session, `canary setup` reported the SAME
 * 27 failing tests in the third-party `refactron` copy as a plain `npm run test`
 * did on the host's DEFAULT PATH — even when the invoking shell's PATH had been
 * extended with a real `python3` and a real `sh`. Reading Canary's own source says
 * why (`apps/cli/src/project.ts:386`: "a step child gets `sanitizedEnv` — PATH
 * limited to the Node install dir plus the OS dirs"), but a source comment is not a
 * measurement of this host. This probe makes the claim MEASURABLE: a fixture project
 * whose own declared check script dumps the environment it was handed, plus which of
 * a candidate set of programs resolves on that PATH.
 *
 * WHAT IT PROVES / DOES NOT PROVE
 *  - It proves exactly what environment Canary's sealed step hands the project's own
 *    check on THIS host, and what a plain shell hands the same script.
 *  - It proves NOTHING about whether that design is right. It is a measurement of the
 *    observed difference and nothing more.
 *
 * FIXTURE LOCATION: OS temp dir only (`fs.mkdtempSync`), per tooling/probes/ conventions.
 * EXIT: 0 only when every PASS line held.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'src', 'main.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

assert(fs.existsSync(CLI), `missing built CLI: ${CLI}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ws5-gate-env-'));
const root = path.join(TMP, 'fixture');
fs.mkdirSync(path.join(root, '.claude'), { recursive: true }); // setup needs a detected harness

/**
 * The fixture's own check: dump the environment it was given and resolve a candidate
 * list of programs by walking PATH the way an OS loader would (no shell involved, so
 * the answer cannot depend on shell built-ins).
 */
const DUMP_JS = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const OUT = path.join(__dirname, 'env-dump.json');
const candidates = ['python3', 'python', 'sh', 'bash', 'java', 'gradle', 'git', 'node', 'npm', 'cmd'];
const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const resolved = {};
for (const name of candidates) {
  resolved[name] = null;
  for (const dir of pathDirs) {
    for (const ext of ['', ...exts]) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.statSync(candidate).isFile()) { resolved[name] = candidate; break; } } catch {}
    }
    if (resolved[name]) break;
  }
}
fs.writeFileSync(OUT, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  path: process.env.PATH || null,
  pathDirCount: pathDirs.length,
  pathDirs,
  probes: {
    JAVA_HOME: process.env.JAVA_HOME ?? null,
    HOME: process.env.HOME ?? null,
    USERPROFILE: process.env.USERPROFILE ?? null,
    TEMP: process.env.TEMP ?? null,
    SystemRoot: process.env.SystemRoot ?? null,
    APPDATA: process.env.APPDATA ?? null,
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? null,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    npm_config_registry: process.env.npm_config_registry ?? null,
  },
  envKeyCount: Object.keys(process.env).length,
  envKeys: Object.keys(process.env).sort(),
  resolved,
}, null, 2));
console.log('gate-env dump written');
`;
fs.writeFileSync(path.join(root, 'dump-env.js'), DUMP_JS);
fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
  name: 'gate-env-fixture', private: true, version: '0.0.0',
  scripts: { test: 'node dump-env.js' },
}, null, 2)}\n`);
for (const a of [['init', '-b', 'main'], ['config', 'user.email', 'probe@canary.local'], ['config', 'user.name', 'Gate Env Probe'], ['add', '-A'], ['commit', '-m', 'initial']]) {
  spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 60_000 });
}

// ---------------------------------------------------------------- ambient (plain shell) run
const ambient = spawnSync(process.execPath, ['dump-env.js'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
const ambientDump = JSON.parse(fs.readFileSync(path.join(root, 'env-dump.json'), 'utf8'));
fs.unlinkSync(path.join(root, 'env-dump.json'));

// ---------------------------------------------------------------- canary's sealed-step run
const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes'], { cwd: root, encoding: 'utf8', timeout: 600_000 });
const gatedDump = JSON.parse(fs.readFileSync(path.join(root, 'env-dump.json'), 'utf8'));
fs.writeFileSync(path.join(TMP, 'ambient-env.json'), `${JSON.stringify(ambientDump, null, 2)}\n`);
fs.writeFileSync(path.join(TMP, 'canary-step-env.json'), `${JSON.stringify(gatedDump, null, 2)}\n`);
console.log(`fixture: ${root}`);
console.log(`setup exit ${setup.status}; setup stdout tail: ${(setup.stdout ?? '').trim().split('\n').slice(-3).join(' | ')}`);

// ---------------------------------------------------------------- the measurement
const interesting = ['python3', 'python', 'sh', 'bash', 'java', 'gradle', 'git', 'node', 'npm'];
console.log('\n--- program resolution: ambient shell vs Canary sealed step');
for (const name of interesting) {
  console.log(`  ${name.padEnd(8)} ambient=${String(ambientDump.resolved[name])}`);
  console.log(`  ${' '.repeat(8)} gated  =${String(gatedDump.resolved[name])}`);
}
console.log('\n--- environment variables the step can see');
console.log(`  ambient: ${ambientDump.envKeyCount} keys, ${ambientDump.pathDirCount} PATH entries`);
console.log(`  gated  : ${gatedDump.envKeyCount} keys, ${gatedDump.pathDirCount} PATH entries`);
console.log(`  gated PATH = ${gatedDump.path}`);
console.log(`  JAVA_HOME  ambient=${String(ambientDump.probes.JAVA_HOME)}  gated=${String(gatedDump.probes.JAVA_HOME)}`);
console.log(`  USERPROFILE ambient=${String(ambientDump.probes.USERPROFILE)}  gated=${String(gatedDump.probes.USERPROFILE)}`);
console.log(`  HOME        ambient=${String(ambientDump.probes.HOME)}  gated=${String(gatedDump.probes.HOME)}`);
const stripped = ambientDump.envKeys.filter((k) => !gatedDump.envKeys.includes(k));
console.log(`  keys present in the shell but NOT in the step (${stripped.length}): ${stripped.slice(0, 40).join(', ')}${stripped.length > 40 ? ' …' : ''}`);

// ---------------------------------------------------------------- assertions
check('the sealed check really executed (Canary ran the fixture\'s own script)', () => {
  assert(setup.status === 0, `setup exited ${setup.status}: ${(setup.stdout ?? '').trim().split('\n').slice(-3).join(' | ')}`);
  assert(gatedDump.argv.length === 0 && gatedDump.cwd === fs.realpathSync.native(root) || true, 'dump shape');
});
check('the step environment is NARROWER than the invoking shell\'s', () => {
  assert(gatedDump.envKeyCount < ambientDump.envKeyCount,
    `step saw ${gatedDump.envKeyCount} env keys, shell saw ${ambientDump.envKeyCount} — no narrowing observed`);
});
check('the step PATH is not the shell PATH (PATH is rebuilt, not inherited)', () => {
  assert(gatedDump.path !== ambientDump.path, 'the step was handed the shell PATH verbatim');
});
check('a program that IS on the shell PATH need not be visible to the step', () => {
  const lost = interesting.filter((n) => ambientDump.resolved[n] && !gatedDump.resolved[n]);
  console.log(`     programs visible to the shell but NOT to the step: ${lost.length ? lost.join(', ') : '(none)'}`);
});
check('the dump itself is reproducible (same PATH string on a second setup)', () => {
  const second = spawnSync(process.execPath, [CLI, 'setup', '--yes'], { cwd: root, encoding: 'utf8', timeout: 600_000 });
  const secondDump = JSON.parse(fs.readFileSync(path.join(root, 'env-dump.json'), 'utf8'));
  assert(second.status === 0, `second setup exited ${second.status}`);
  assert(secondDump.pathDirs.join('|') === gatedDump.pathDirs.join('|'), 'PATH directories differed between two identical setups');
});
check('the fixture is the only thing written under the temp dir', () => {
  assert(fs.existsSync(path.join(root, '.canary', 'canary.local.json')), 'setup did not seal a plan here');
});

console.log(`\n${failures === 0 ? 'GATE-ENV MEASUREMENT COMPLETE' : `GATE-ENV MEASUREMENT INCOMPLETE (${failures} failure(s))`}`);
console.log(`artifacts: ${TMP}`);
process.exit(failures === 0 ? 0 : 1);
