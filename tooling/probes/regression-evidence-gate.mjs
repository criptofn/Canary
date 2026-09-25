#!/usr/bin/env node
/**
 * THE REGRESSION-EVIDENCE GATE — does Canary refuse a green plan that proves nothing about the change?
 *
 * THE PRODUCT INVARIANT THIS VERIFIES: *Canary must never issue PASS/READY/promotion merely because
 * the configured tests are green if authorized requirements are not independently covered by
 * adequate proof. Existing behaviour that must be preserved requires regression evidence. Missing
 * or ambiguous proof must fail closed, never degrade to PASS.*
 *
 * MEASURED REASON IT EXISTS (`bench-r5-refactor-preserve-invisible-2`): an agent rewrote
 * `formatMoney`'s string handling, ran nothing, and finished while `formatMoney("0.5")` returned
 * `$0.05`. The project's own checks passed BEFORE and AFTER the change, so they carried no evidence
 * about it — and Canary said READY. That is a false green the runner cannot fix, because the checks
 * do not discriminate the change. The gate now runs the sealed plan against the sealed BASE with the
 * candidate's check files overlaid and asks: do the checks FAIL without this change?
 *
 * Cases, each on a fresh real repository driven through the real CLI:
 *   A  product changed, plan green before and after  -> NOT PROVEN (`doctor`), and the Stop hook
 *                                                        BLOCKS with an actionable instruction;
 *   B  A + a check that fails without the change      -> READY (the plan discriminates);
 *   C  a failing check fixed                          -> READY (the plan fails on the base);
 *   D  nothing changed                                -> READY (no question to ask);
 *   E  only check files changed                       -> READY (no product behaviour to discriminate);
 *   F  the base comparison cannot run                 -> NOT PROVEN, never a weaker duty.
 *
 * Usage: node tooling/probes/regression-evidence-gate.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);

const RUNNER = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const dir = path.join(__dirname, 'tests');",
  "let passing = 0, failing = 0;",
  "for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js')).sort()) {",
  "  const tests = require(path.join(dir, f));",
  "  for (const [name, fn] of Object.entries(tests)) {",
  "    try { fn(); passing += 1; } catch (e) { failing += 1; console.log('FAIL ' + f + ' :: ' + name + ' — ' + (e && e.message ? e.message : e)); }",
  "  }",
  "}",
  "console.log(passing + ' passing (0.01s)');",
  "if (failing > 0) console.log(failing + ' failing');",
  "process.exit(failing > 0 ? 1 : 0);",
  '',
].join('\n');

/** A project whose `greet` returns the plain name; the visible suite covers only that. */
const SRC_V1 = [
  "'use strict';",
  "function greet(name) { return 'hello ' + name; }",
  "module.exports = { greet };",
  '',
].join('\n');
/**
 * The SILENT behaviour change of case A: it trims the name. The visible suite only calls
 * `greet('ada')`, for which trimming changes nothing — so the suite is green BEFORE and AFTER. That
 * is the shape `bench-r5` measured: real behaviour changed, and the plan cannot tell.
 */
const SRC_V2 = [
  "'use strict';",
  "function greet(name) { return 'hello ' + String(name).trim(); }",
  "module.exports = { greet };",
  '',
].join('\n');
const TEST_V1 = [
  "'use strict';",
  "const { greet } = require('../src/greet.js');",
  "module.exports = {",
  "  'greets a name': () => { if (greet('ada') !== 'hello ada') throw new Error('got ' + greet('ada')); },",
  "};",
  '',
].join('\n');
/** Case B: a check that only passes WITH the change (it fails on the base). */
const TEST_DISCRIMINATING = [
  "'use strict';",
  "const { greet } = require('../src/greet.js');",
  "module.exports = {",
  "  'greets a name': () => { if (greet('ada') !== 'hello ada') throw new Error('got ' + greet('ada')); },",
  "  'trims the name (the behaviour this change introduced)': () => {",
  "    if (greet('  ada  ') !== 'hello ada') throw new Error('got ' + JSON.stringify(greet('  ada  ')));",
  "  },",
  "};",
  '',
].join('\n');

function makeRepo(name, src, test, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `canary-regevidence-${name}-`));
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: `regevidence-${name}`, private: true, scripts: { test: 'node run-tests.js' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'run-tests.js'), RUNNER);
  fs.writeFileSync(path.join(root, 'src', 'greet.js'), src);
  fs.writeFileSync(path.join(root, 'tests', 'greet.test.js'), test);
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'regevidence@canary.local']);
  git(['config', 'user.name', 'Regression Evidence Probe']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  if (opts.extraCommit !== undefined) {
    fs.writeFileSync(path.join(root, 'src', 'greet.js'), opts.extraCommit.src);
    git(['add', '-A']);
    git(['commit', '-m', 'baseline moves on']);
  }
  return root;
}

/** The envelope is the one JSON object on stdout; prose goes to stderr. */
function parseEnvelope(stdout) {
  const text = (stdout ?? '').trim();
  try { return JSON.parse(text); } catch { /* maybe a leading prose line */ }
  for (const line of text.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  return null;
}
const setup = (root) => spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { cwd: root, encoding: 'utf8', timeout: 240_000, windowsHide: true });
const doctor = (root) => {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json', root], { cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true });
  return { status: r.status, env: parseEnvelope(r.stdout), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const hook = (root, active = false) => {
  const r = spawnSync(process.execPath, [CLI, 'checkpoint'], {
    cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true,
    input: JSON.stringify({ cwd: root, stop_hook_active: active, hook_event_name: 'Stop' }),
  });
  return { status: r.status, env: parseEnvelope(r.stdout), stdout: r.stdout ?? '' };
};
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);

// ── A: product changed, plan green before and after ─────────────────────────
console.log('\n── A: a silent behaviour change behind a green suite');
{
  const root = makeRepo('silent-change', SRC_V1, TEST_V1);
  const s = setup(root);
  assert(s.status === 0 || s.status === 2, `setup must complete: ${s.stdout}${s.stderr}`);
  write(root, 'src/greet.js', SRC_V2);
  const d = doctor(root);
  console.log(`   doctor: status=${String(d.env?.status ?? '?')} exit=${d.status}`);
  console.log(`   why: ${String(d.env?.why ?? d.stdout.split('\n')[0] ?? '').slice(0, 220)}`);
  const h = hook(root);
  console.log(`   checkpoint: decision=${String(h.env?.decision ?? '(none)')}`);
  console.log(`   reason: ${String(h.env?.reason ?? h.env?.systemMessage ?? '').slice(0, 260)}`);
  check('A1: doctor does NOT say READY when the checks cannot tell the change from the base', () => {
    assert(d.env?.status !== 'READY', `doctor said ${String(d.env?.status)} — a green plan that proves nothing about the change must not be READY`);
    assert(d.env?.status === 'NOT PROVEN', `expected NOT PROVEN, got ${String(d.env?.status)}`);
  });
  check('A2: doctor fails closed (non-zero exit)', () => assert(d.status !== 0, `doctor exited 0 while NOT PROVEN`));
  check('A3: the Stop hook BLOCKS with an actionable instruction', () => {
    assert(h.env?.decision === 'block', `the gate allowed a completion whose proof does not discriminate the change (${h.stdout.slice(0, 200)})`);
    assert(/fails? without|FAILS without/i.test(String(h.env?.reason ?? '')), `the reason must say how to fix it: ${String(h.env?.reason ?? '').slice(0, 300)}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── B: the same change, with a check that fails without it ──────────────────
console.log('\n── B: the same change plus a discriminating check');
{
  const root = makeRepo('discriminating', SRC_V1, TEST_V1);
  setup(root);
  write(root, 'src/greet.js', SRC_V2);
  write(root, 'tests/greet.test.js', TEST_DISCRIMINATING);
  const d = doctor(root);
  console.log(`   doctor: status=${String(d.env?.status ?? '?')} exit=${d.status}`);
  if (d.env?.status !== 'READY') console.log(`   why: ${String(d.env?.why ?? '').slice(0, 300)}`);
  check('B1: a check that fails without the change earns READY', () => {
    assert(d.env?.status === 'READY', `expected READY once the plan discriminates the change, got ${String(d.env?.status)}: ${String(d.env?.why ?? '')}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── C: a failing check is fixed (the plan fails on the base) ────────────────
console.log('\n── C: fixing a failing check');
{
  // Starts RED: the source dropped the space the suite asserts.
  const SRC_BROKEN = SRC_V1.replace("'hello ' + name", "'hello' + name");
  const root = makeRepo('fix-red', SRC_BROKEN, TEST_V1);
  const before = spawnSync(process.execPath, ['run-tests.js'], { cwd: root, encoding: 'utf8', windowsHide: true });
  setup(root);
  write(root, 'src/greet.js', SRC_V1); // the fix
  const d = doctor(root);
  console.log(`   suite before the fix: exit ${before.status}; doctor: status=${String(d.env?.status ?? '?')} exit=${d.status}`);
  if (d.env?.status !== 'READY') console.log(`   stderr: ${d.stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 400)}`);
  check('C1: a fix that turns a red plan green is READY (the base fails, so the plan discriminates)', () => {
    assert(before.status !== 0, 'the fixture must start red for this case to mean anything');
    assert(d.env?.status === 'READY', `expected READY, got ${String(d.env?.status)}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── D: nothing changed ──────────────────────────────────────────────────────
console.log('\n── D: no change at all');
{
  const root = makeRepo('no-change', SRC_V1, TEST_V1);
  setup(root);
  const d = doctor(root);
  console.log(`   doctor: status=${String(d.env?.status ?? '?')} exit=${d.status}`);
  check('D1: nothing changed -> nothing to discriminate -> READY', () => {
    assert(d.env?.status === 'READY', `expected READY with no change, got ${String(d.env?.status)}: ${String(d.env?.why ?? '')}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── E: only check files changed ─────────────────────────────────────────────
console.log('\n── E: only the check file changed (no product behaviour to discriminate)');
{
  const root = makeRepo('tests-only', SRC_V1, TEST_V1);
  setup(root);
  write(root, 'tests/greet.test.js', TEST_DISCRIMINATING.replace("if (greet('  ada  ') !== 'hello ada') throw new Error('got ' + JSON.stringify(greet('  ada  ')));", "if (greet('ada') !== 'hello ada') throw new Error('second look');"));
  const d = doctor(root);
  console.log(`   doctor: status=${String(d.env?.status ?? '?')} exit=${d.status}`);
  check('E1: a check-only change is not asked to discriminate itself', () => {
    assert(d.env?.status === 'READY', `expected READY, got ${String(d.env?.status)}: ${String(d.env?.why ?? '')}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── F: the comparison cannot be established ─────────────────────────────────
console.log('\n── F: the base comparison cannot run (it must say so, not guess)');
{
  // The check needs a module installed by npm; in the throwaway base worktree there is no
  // node_modules, so the base run fails in an ENVIRONMENT-shaped way. That is UNESTABLISHED, and an
  // unestablished comparison must not be reported as either answer.
  const root = makeRepo('env-shaped', SRC_V1, TEST_V1);
  write(root, 'run-tests.js', `${RUNNER}\n`);
  setup(root);
  write(root, 'src/greet.js', SRC_V2);
  write(root, 'helper.cjs', 'module.exports = {};\n');
  write(root, 'tests/greet.test.js', "require('../helper.cjs');\n" + TEST_V1);
  const d = doctor(root);
  console.log(`   doctor: status=${String(d.env?.status ?? '?')} exit=${d.status}`);
  console.log(`   why: ${String(d.env?.why ?? '').slice(0, 200)}`);
  check('F1: an environment-shaped comparison failure is not read as "the plan discriminates"', () => {
    assert(d.status === 2 && d.env?.status === 'NOT PROVEN', `a broken comparison must remain NOT PROVEN: ${d.stdout}\n${d.stderr}`);
    assert(/comparison could not be established/.test(d.stderr), 'the missing comparison must be disclosed');
    assert(hook(root).env?.decision === 'block', 'the Stop hook must refuse the same missing comparison');
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── G: the discriminating evidence is a check the WORKER added ──────────────
console.log('\n── G: the worker adds its own check to satisfy the gate');
{
  /**
   * MEASURED (`bench-final-constraint-hold-guarded-3`): an agent added `tests/csv-quoted.test.js`,
   * the plan passed, the stated rule was still broken, and Canary said READY with no remark. The gate
   * cannot call that a failure — the added check really does discriminate the change, and no
   * requirement was AUTHORIZED to hold it to — but it must not stay silent about what the evidence
   * is. This case pins the honest caveat.
   */
  const root = makeRepo('worker-added', SRC_V1, TEST_V1);
  setup(root);
  write(root, 'src/greet.js', SRC_V2);
  write(root, 'tests/added-by-worker.test.js', TEST_DISCRIMINATING); // a NEW file, not a modified one
  const d = doctor(root);
  const h = hook(root);
  console.log(`   doctor: status=${String(d.env?.status ?? '?')} exit=${d.status}`);
  console.log(`   checkpoint message: ${String(h.env?.systemMessage ?? '(none)').slice(0, 260)}`);
  check('G1: the change is allowed (the added check does discriminate it)', () => {
    assert(d.env?.status === 'READY', `expected READY, got ${String(d.env?.status)}`);
  });
  check('G2: but the allow SAYS the discriminating evidence is the worker\'s own new check', () => {
    const msg = String(h.env?.systemMessage ?? '');
    assert(msg !== '', 'a READY resting on worker-authored evidence must not be silent');
    /*
     * v1.5 POST-AUDIT. This assertion used to grep the exact phrase "THIS SESSION ADDED".
     *
     * The BLOCKER 1+7 fix replaced that prose with wording that ALSO covers a REWRITTEN existing
     * check — "CHECK TEXT WRITTEN BY THE WORKER ITSELF", with a per-file "(created by this
     * session)" or "(EXISTING check rewritten by this session)" — because a worker that EDITS an
     * existing oracle writes the evidence just as much as one that creates a file, and the old
     * wording let it inherit independent authority. Coupling a gate to a sentence made that
     * security fix look like a regression.
     *
     * The gate now asserts the SEMANTICS it always cared about, and asserts them more strongly:
     * the message must name the worker's check, say the WORKER authored it AND say how it was
     * authored. A future rewording cannot pass by dropping that claim.
     */
    assert(/added-by-worker\.test\.js/.test(msg), `the caveat must name the worker's check:\n${msg}`);
    assert(/worker/i.test(msg) && /(created by this session|rewritten by this session)/i.test(msg),
      `the caveat must say the WORKER authored the evidence, and whether it was created or REWRITTEN:\n${msg}`);
    assert(/independent coverage|operator-bound/i.test(msg), 'and it must name what independent coverage would take');
  });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== regression-evidence gate: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
