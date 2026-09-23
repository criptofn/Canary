// v1.3 §16 — HOW MUCH INTERNAL VOCABULARY DOES THE ORDINARY PATH SPEAK?
//
// The release's own product test is: hand Canary to a developer who has never heard of proof bindings,
// sealed bases or candidate promotion, and see whether they get verified work without learning any of
// it. The honest proxy for "without learning the machinery" is the words the DEFAULT output uses,
// because `--verbose` is opt-in and nobody reads it unless they already suspect something.
//
// So this probe measures the vocabulary of the ordinary path — `setup`, `status`, `doctor`, `agents`,
// and the completion gate's own message — and pins it as a BUDGET: default output may not exceed the
// recorded counts. It also checks the other direction, which is what makes a budget safe to enforce:
// the detail must still EXIST under `--verbose`, so lowering the default count by deleting information
// fails here rather than silently making Canary less inspectable.
//
// Verdict words (READY, NOT PROVEN, NEEDS ATTENTION, BLOCKED, UNSUPPORTED, CONNECTED) are NOT jargon:
// they are the product's answer, and they are identical in the machine channel. The list below is
// internals only.
//
// FIXTURE LAYOUT MATTERS, and this probe learned it the hard way: the trust store lives OUTSIDE the
// repository (as the default one does, under the OS home). An earlier version pointed
// CANARY_TRUST_STORE at a directory inside the repo, which made the repo genuinely dirty — so `setup`
// correctly stamped `dirty: true` and the gate correctly answered "the repo was already dirty at
// setup". That is Canary behaving properly on a misconfigured layout, and it looked exactly like a
// product defect until the probe printed its own decision inputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-vocabulary-'));
const project = path.join(temp, 'project');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};

/** Internals a user should not have to decode on the ordinary path. */
const TERMS = ['sealed', 'seal', 'authority', 'candidate', 'promotion', 'promote', 'obligation',
  'binding', 'digest', 'isolat', 'worktree', 'receipt', 'custody', 'attestation', 'provenance'];
const count = (text) => {
  const hits = {};
  for (const t of TERMS) {
    const n = (text.match(new RegExp(t, 'gi')) ?? []).length;
    if (n > 0) hits[t] = n;
  }
  return hits;
};
const total = (hits) => Object.values(hits).reduce((a, b) => a + b, 0);

const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'local-trust') };
const run = (exe, args, cwd, input) => spawnSync(exe, args, {
  cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300000,
  ...(input === undefined ? {} : { input }),
});
const canary = (args) => run(process.execPath, [cli, ...args], project);
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
const baseline = () => JSON.parse(fs.readFileSync(path.join(project, '.canary', 'canary.local.json'), 'utf8')).baseline;

try {
  fs.mkdirSync(project, { recursive: true });
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'vocabulary', private: true, scripts: { test: 'node greeting.test.cjs' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'package-lock.json'), JSON.stringify({
    name: 'vocabulary', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {},
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'greeting.cjs'), 'module.exports = (name) => `Hello, ${name}!`;\n');
  fs.writeFileSync(path.join(project, 'greeting.test.cjs'),
    "const assert = require('node:assert/strict');\n"
    + "const greeting = require('./greeting.cjs');\n"
    + "assert.equal(greeting('Ada'), 'Hello, Ada!');\n");
  run(git, ['init', '-b', 'main'], project);
  run(git, ['config', 'user.email', 'vocab@canary.local'], project);
  run(git, ['config', 'user.name', 'Vocabulary Probe'], project);
  run(git, ['add', '-A'], project);
  const commit = run(git, ['commit', '-m', 'base'], project);
  if (commit.status !== 0) throw new Error(`fixture commit failed: ${commit.stdout}${commit.stderr}`);

  const setup = canary(['setup', '--yes']);
  // PRECONDITION, asserted rather than assumed: the ordinary path starts from a repository that was
  // CLEAN when Canary was wired. A dirty one makes the gate answer with the unattributable-comparison
  // premise instead of the discrimination question — a different message measuring a different thing.
  if (baseline()?.dirty !== false) {
    throw new Error(`fixture precondition failed: setup stamped baseline.dirty=${String(baseline()?.dirty)}`);
  }

  const status = canary(['status']);
  const doctor = canary(['doctor']);
  const agents = canary(['agents']);
  const statusJson = JSON.parse(canary(['status', '--json']).stdout);
  const doctorJson = JSON.parse(canary(['doctor', '--json']).stdout);
  const setupVerbose = canary(['setup', '--yes', '--verbose']);
  const doctorVerbose = canary(['doctor', '--verbose']);

  // The completion gate is the message the AGENT reads, and the one place a user meets a refusal
  // without having asked for one. Provoke the interesting case — a behaviour change no declared check
  // can see — because that refusal is the product, and its wording is the product.
  fs.appendFileSync(path.join(project, 'greeting.cjs'),
    'module.exports.farewell = (name) => `Bye, ${name}!`;\n');
  const gate = run(process.execPath, [cli, 'checkpoint'], project, JSON.stringify({ stop_hook_active: false }));

  console.log('--- the completion gate\'s actual message (what the AGENT reads) ---');
  let gateEnv = null;
  try { gateEnv = JSON.parse((gate.stdout ?? '').trim()); } catch { gateEnv = null; }
  console.log(gateEnv === null
    ? `  (silence — the documented allow signal; raw: ${JSON.stringify((gate.stdout ?? '').slice(0, 60))})`
    : `  decision=${gateEnv.decision}\n  ${String(gateEnv.reason ?? gateEnv.systemMessage ?? '(no message)').split('\n').join('\n  ')}`);

  const rows = [
    ['setup --yes', out(setup)],
    ['status', out(status)],
    ['doctor', out(doctor)],
    ['agents', out(agents)],
    ['the completion gate', out(gate)],
  ];
  console.log('--- default output vocabulary ---');
  const defaultHits = {};
  for (const [label, text] of rows) {
    const hits = count(text);
    for (const [k, v] of Object.entries(hits)) defaultHits[k] = (defaultHits[k] ?? 0) + v;
    console.log(`  ${label.padEnd(22)} ${String(total(hits)).padStart(3)}  ${JSON.stringify(hits)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(total(defaultHits)).padStart(3)}  ${JSON.stringify(defaultHits)}`);

  const verboseText = out(setupVerbose) + out(doctorVerbose);
  console.log('--- the same detail under --verbose ---');
  console.log(`  ${JSON.stringify(count(verboseText))}`);

  // THE GATE MUST BE ANSWERING THE DISCRIMINATION QUESTION, not the unattributable-comparison one:
  // otherwise this probe is measuring the wording of a different refusal.
  check('the probe provoked the refusal it means to measure', () => {
    if (gateEnv?.decision !== 'block') throw new Error(`expected a block, got ${JSON.stringify(gateEnv)}`);
    if (/already dirty at setup/.test(String(gateEnv.reason))) {
      throw new Error('the gate answered the unattributable-comparison premise — the fixture is dirty, so this measures the wrong message');
    }
  });

  /*
   * THE BUDGET, set from the first MEASURED run rather than from an ambition.
   *
   * MEASURED (this probe, on the ordinary path): 13 occurrences of 5 distinct internals —
   * `status` 7 (sealed ×2, seal ×2, authority ×2, candidate ×1), `doctor` 1 (obligation),
   * the completion gate 5 (sealed ×2, seal ×2, obligation ×1); `setup` and `agents` speak NONE.
   *
   * The number is deliberately set to what the product DOES, not to a target it has not met: a budget
   * below the measured value would fail on the day it was written, and one above it would let the
   * ordinary path drift back into internals. It is a RATCHET — the ordinary path may only get quieter
   * unless somebody raises this number here, which is a reviewable act.
   *
   * What the measurement also decided: NO prose rewrite. The gate's message is 5 of those 13 and is
   * otherwise plain, actionable English ("the checks pass on the base commit too, so they carry no
   * evidence about this change ... needs a check that FAILS without the change and passes with it").
   * The brief is explicit that renaming internals for cosmetics is not the work, so the finding is
   * recorded instead of churned.
   */
  const BUDGET = Number(process.env.CANARY_VOCAB_BUDGET ?? 13);
  check(`the ordinary path speaks at most ${BUDGET} internal term(s)`, () => {
    if (total(defaultHits) > BUDGET) {
      throw new Error(`default output uses ${total(defaultHits)}: ${JSON.stringify(defaultHits)}`);
    }
  });

  // RAISING THE DEFAULT BY DELETING THE DETAIL IS NOT A FIX: the internals must stay reachable where an
  // engineer would look for them.
  check('the internals are still reachable under --verbose', () => {
    const verboseHits = count(verboseText);
    const missing = Object.keys(defaultHits).filter((t) => verboseHits[t] === undefined);
    if (missing.length > 0) {
      throw new Error(`--verbose no longer explains: ${missing.join(', ')} — the default was made quieter by deleting information, not by moving it`);
    }
  });

  // The machine channel is not a presentation surface and must keep saying exactly what it said.
  check('the JSON envelope is unchanged by the prose (same fields, same verdict)', () => {
    if (statusJson.status !== 'CONNECTED') throw new Error(`status --json says ${statusJson.status}`);
    if (doctorJson.exitCode !== 0) throw new Error(`doctor --json exitCode ${doctorJson.exitCode} on a green repo`);
    if (!Array.isArray(doctorJson.checks) || doctorJson.checks.length === 0) throw new Error('doctor --json lost its checks list');
  });

  console.log(`\n=== everyday vocabulary: ${failures === 0 ? 'PASS' : `${failures} FAIL`} (default budget ${BUDGET}) ===`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
