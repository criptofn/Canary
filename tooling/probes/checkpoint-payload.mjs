#!/usr/bin/env node
/**
 * The completion gate's failure payload — measured end to end.
 *
 * WHY THIS IS A PROBE AND NOT A UNIT TEST: the payload is a TOKEN-COST control, and the cost is
 * what the MODEL is handed through the Stop hook. Only a real `canary checkpoint` on a real
 * wired repository shows what the hook actually emits, how large it is, and that the full runner
 * output is on disk where a human (or an explicit drill-down) can read it.
 *
 * Before this change the block reason carried up to 4000 characters of raw runner output, on
 * every failed attempt, plus prose. What this asserts now:
 *   1. the hook BLOCKS (a failing check must never be allowed through),
 *   2. the payload names the failing check and the failing test identity,
 *   3. the payload is SMALL (a bounded number of characters, far below the old 4000-char dump),
 *   4. the payload points at a log file that exists and contains the FULL runner output,
 *   5. the full output is NOT in the payload (the model is not paying for it).
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
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-payload-'));
const root = path.join(TMP, 'project');
fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
fs.mkdirSync(path.join(root, '.git'), { recursive: true });
// v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
// `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
// machine that has Claude Code installed and failed on every CI runner.
fs.mkdirSync(path.join(root, '.claude'), { recursive: true });

// A dependency-free project whose check FAILS, with a runner shape that reports a test identity
// and an assertion line — the ordinary case the payload has to compress.
fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
  name: 'payload-fixture', private: true, scripts: { test: 'node run-tests.js' },
}, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'run-tests.js'), [
  "'use strict';",
  "const marker = require('node:fs').readFileSync('marker.txt', 'utf8').trim();",
  "if (marker === 'fail') {",
  "  console.log('Failures:');",
  "  console.log('  totals.test.js :: total includes negative values');",
  "  console.log('    Expected values to be strictly equal: 5 !== 0');",
  "  console.log('  ' + 'DEBUG-NOISE '.repeat(400));",
  "  console.log('7 passing (0.01s)');",
  "  console.log('1 failing');",
  "  process.exit(1);",
  "}",
  "console.log('8 passing (0.01s)');",
  '',
].join('\n'));
fs.writeFileSync(path.join(root, 'marker.txt'), 'fail\n');

const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000 });
git(['init', '-b', 'main']);
git(['config', 'user.email', 'payload@canary.local']);
git(['config', 'user.name', 'Payload Probe']);
git(['add', '-A']);
git(['commit', '-m', 'initial']);

const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { cwd: root, encoding: 'utf8', timeout: 240_000 });
assert(setup.status === 2 || setup.status === 0, `setup must complete (wired, checks failing): ${setup.stdout}${setup.stderr}`);

// Exactly what the Stop hook does: the CLI with the hook's JSON on stdin.
const hook = spawnSync(process.execPath, [CLI, 'checkpoint'], {
  cwd: root, encoding: 'utf8', timeout: 240_000, input: JSON.stringify({ stop_hook_active: false }),
});
let envelope = null;
try { envelope = JSON.parse(hook.stdout.trim()); } catch { envelope = null; }
console.log(`hook exit ${hook.status}; stdout ${hook.stdout.length} chars`);
console.log(`reason (${envelope?.reason?.length ?? 0} chars):\n${envelope?.reason ?? '(none)'}`);

check('1. a failing check BLOCKS the completion', () => {
  assert(envelope !== null, `the hook must print one JSON object, got: ${hook.stdout.slice(0, 200)}`);
  assert(envelope.decision === 'block', `expected decision=block, got ${JSON.stringify(envelope)}`);
});

check('2. the payload names the check and the failing test identity', () => {
  const reason = envelope?.reason ?? '';
  assert(/Canary verification failed: tests/.test(reason), `the failing check must be named:\n${reason}`);
  assert(/total includes negative values/.test(reason), `the failing identity must be named:\n${reason}`);
  assert(/5 !== 0/.test(reason), `the assertion line must survive:\n${reason}`);
});

check('3. the payload is SMALL (this is the token-cost control)', () => {
  const reason = envelope?.reason ?? '';
  assert(reason.length <= 1200, `payload is ${reason.length} chars; the bound is 1200 (it replaced a 4000-char dump)`);
  assert(!/DEBUG-NOISE/.test(reason), 'raw runner noise must NOT be in the model-visible payload');
});

check('4. the full runner output is on disk, and the payload says where', () => {
  const reason = envelope?.reason ?? '';
  const m = /full output: (.+)$/m.exec(reason);
  assert(m !== null, `the payload must name the full-output path:\n${reason}`);
  const logPath = m[1].trim();
  assert(fs.existsSync(logPath), `the referenced log must exist: ${logPath}`);
  const full = fs.readFileSync(logPath, 'utf8');
  assert(/DEBUG-NOISE/.test(full), 'the full log must carry everything the payload left out');
});

check('5. the payload is bounded even when the log is huge', () => {
  // The fixture's noise is ~5 KB on purpose; the bound is what makes a pathological failure
  // (a megabyte of output) cost the same as a small one.
  const reason = envelope?.reason ?? '';
  assert(reason.length < 400 * 4, `payload grew with the log (${reason.length} chars)`);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== checkpoint payload: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
