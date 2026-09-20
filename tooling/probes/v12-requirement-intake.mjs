#!/usr/bin/env node
/**
 * REQUIREMENT INTAKE — a stated requirement is registered VERBATIM, or the command refuses.
 *
 * WHY THIS EXISTS (v1.2, found by measurement, not by review). While completing the corpus
 * declarations, `tooling/probes/v12-fixture-configurations.mjs` reported that fixture
 * `cli-exit-codes` states EIGHT requirements and `canary task` recorded SEVEN digests. The missing
 * one begins with a dash-like token:
 *
 *   "--strict moves warnings into errors rather than dropping them"
 *
 * The old `canary task` parser required a `--requirement` value to NOT start with `--`, then skipped
 * any remaining `--` token outright. So that requirement was neither consumed nor reported: the
 * operator believed eight duties were registered, seven were, and the eighth became prose nobody
 * checks. This is the same defect class the repository already recorded for `canary work`
 * (orchestrate.ts: "Canary silently registered FEWER, i.e. weaker verification than the human
 * authorized"), which was fixed there in v1.1 while this one survived in `task`.
 *
 * The rule this probe pins:
 *   1. `--requirement` takes the NEXT ARGUMENT VERBATIM. A requirement whose TEXT begins with `--`
 *      is ordinary text and must be registered, counted, and have its digest printed.
 *   2. A `--requirement` with NO value is REFUSED (exit 3) and nothing is written — never a quiet
 *      zero-duty registration.
 *   3. An option that is not `--kind`/`--requirement` is REFUSED, not ignored: ignoring
 *      `--requirment "x"` (a typo) registers ZERO duties while the operator believes otherwise.
 *   4. Both intake paths agree: the digest `canary bind` prints for the same text is the digest the
 *      task record carries. If they disagreed, a requirement could be bindable but unregistered.
 *
 * Usage: node tooling/probes/v12-requirement-intake.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

const DASH_REQ = '--strict moves warnings into errors rather than dropping them';
const PLAIN_REQ = 'a valid config exits 0 with an ok line on stdout';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
const canary = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 240_000, windowsHide: true });

/** A minimal sealed Node project: one real check, so `canary bind` has a plan script to point at. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-intake-'));
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ok.js'), "'use strict';\nprocess.exit(0);\n");
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'intake-probe', version: '1.0.0', private: true, scripts: { test: 'node ok.js' },
  }, null, 2)}\n`);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'intake@canary.local']);
  git(root, ['config', 'user.name', 'Requirement Intake Probe']);
  git(root, ['add', '-A']);
  const commit = git(root, ['commit', '-m', 'sealed project']);
  assert(commit.status === 0, `git commit failed: ${commit.stderr}`);
  const setup = canary(root, ['setup', '--yes']);
  assert(fs.existsSync(path.join(root, '.canary', 'canary.local.json')), `setup wrote no config (exit ${setup.status}): ${setup.stdout}${setup.stderr}`);
  return root;
}
const taskRecordOf = (root) => {
  const p = path.join(root, '.canary', 'task', 'current.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

console.log('── 1. a requirement whose TEXT begins with "--" is registered, counted and printed');
{
  const root = makeProject();
  const r = canary(root, ['task', 'make the validator behave', '--requirement', DASH_REQ]);
  console.log(`   canary task: exit ${r.status}`);
  check('1. the dash-leading requirement is a REGISTERED duty, not prose', () => {
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    const rec = taskRecordOf(root);
    assert(rec !== null, 'no task record was written');
    assert(rec.requirementCount === 1, `expected 1 registered requirement, got ${rec.requirementCount}`);
    assert(rec.requirementDigests.length === 1, `expected 1 digest, got ${rec.requirementDigests.length}`);
    assert(r.stdout.includes(rec.requirementDigests[0]), `the digest must be printed so the operator can bind it:\n${r.stdout}`);
    assert(/1 requirement\(s\)/.test(r.stdout), `the count must be reported honestly:\n${r.stdout}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n── 2. it coexists with ordinary requirements, in either order');
{
  const root = makeProject();
  const r = canary(root, ['task', 'make the validator behave', '--requirement', PLAIN_REQ, '--requirement', DASH_REQ]);
  console.log(`   canary task: exit ${r.status}`);
  check('2. two stated requirements produce two digests', () => {
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    const rec = taskRecordOf(root);
    assert(rec.requirementCount === 2, `expected 2 registered requirements, got ${rec.requirementCount}`);
    assert(new Set(rec.requirementDigests).size === 2, 'the two requirements must be distinct duties');
    assert(/2 requirement\(s\)/.test(r.stdout), `the count must be reported honestly:\n${r.stdout}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n── 3. a misuse is REFUSED, and refusal writes nothing');
{
  const missingValue = (() => { const root = makeProject(); const r = canary(root, ['task', 'intent', '--requirement']); const rec = taskRecordOf(root); fs.rmSync(root, { recursive: true, force: true }); return { r, rec }; })();
  const unknownOption = (() => { const root = makeProject(); const r = canary(root, ['task', 'intent', '--requirment', PLAIN_REQ]); const rec = taskRecordOf(root); fs.rmSync(root, { recursive: true, force: true }); return { r, rec }; })();
  console.log(`   --requirement with no value: exit ${missingValue.r.status}; unknown option: exit ${unknownOption.r.status}`);
  check('3a. `--requirement` with no value is refused and registers nothing', () => {
    assert(missingValue.r.status === 3, `expected exit 3, got ${missingValue.r.status}: ${missingValue.r.stdout}`);
    assert(/REFUSED/.test(missingValue.r.stdout), `the refusal must say REFUSED:\n${missingValue.r.stdout}`);
    assert(missingValue.rec === null, 'a refused registration must write no task record');
  });
  check('3b. an unknown option is refused, not ignored (a typo must not register zero duties)', () => {
    assert(unknownOption.r.status === 3, `expected exit 3, got ${unknownOption.r.status}: ${unknownOption.r.stdout}`);
    assert(/unknown option/.test(unknownOption.r.stdout), `the refusal must name the option:\n${unknownOption.r.stdout}`);
    assert(unknownOption.rec === null, 'a refused registration must write no task record');
  });
}

console.log('\n── 4. both intake paths agree on the identity of the same text');
{
  const root = makeProject();
  const r = canary(root, ['task', 'make the validator behave', '--requirement', DASH_REQ]);
  const bind = canary(root, ['bind', 'test', '--requirement', DASH_REQ]);
  console.log(`   task exit ${r.status}; bind exit ${bind.status}`);
  check('4. `bind` prints the same digest the task record carries', () => {
    const rec = taskRecordOf(root);
    assert(rec !== null && rec.requirementDigests.length === 1, 'the task record must carry the requirement');
    const printed = (bind.stdout.match(/[0-9a-f]{64}/g) ?? []);
    assert(printed.length > 0, `bind printed no digest:\n${bind.stdout}${bind.stderr}`);
    assert(printed.includes(rec.requirementDigests[0]),
      `bind and task disagree about the requirement's identity: task ${rec.requirementDigests[0]}, bind ${printed.join(', ')}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== requirement intake: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
