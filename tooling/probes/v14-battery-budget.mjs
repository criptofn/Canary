#!/usr/bin/env node
/**
 * v1.4 — RELEASE-GATE BUDGET AND CASCADE-ISOLATION REGRESSION.
 *
 * Two infrastructure defects made this battery report things that were not true:
 *
 *  1. ONE FLAT `timeout: 900_000` for every step. MEASURED: the master-pass
 *     mutation battery takes ~993 s standalone, so on a loaded machine the gate
 *     KILLED a step whose legitimate runtime class exceeds the budget — and
 *     reported it as a failed test.
 *  2. A killed dist-REWRITING step left bytes nobody could vouch for, and the
 *     next five steps "failed" against them. The summary then showed six
 *     failures where the evidence supported one.
 *
 * This probe pins the rules that fix both, without running the 90-minute battery:
 *  - every budget is FINITE (a deadlock must still be caught) and the heavy,
 *    measured steps have real headroom over their measured class;
 *  - a timeout is `INCOMPLETE`, never `FAIL` and never `PASS`;
 *  - a dist-rewriting step that does not PASS STOPS the chain, and the restore
 *    function genuinely rebuilds trusted bytes.
 *
 * Exit 0 only when all of that holds. Deterministic and fast.
 *
 * Usage: node tooling/probes/v14-battery-budget.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STEP_TIMEOUT_MS, KNOWN_RUNTIME_MS, STEP_TIMEOUT_MS, MUTATES_DIST,
  budgetFor, verdictFor, shouldStopAfter, restoreDist,
} from '../step-budgets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e)}`); }
};

console.log('=== budgets are finite, and big enough for the measured workload ===');
check('the default budget is finite and positive (a deadlock must still be caught)', () => {
  assert.ok(Number.isFinite(DEFAULT_STEP_TIMEOUT_MS) && DEFAULT_STEP_TIMEOUT_MS > 0, 'default must be finite');
});
check('every explicit budget is finite and positive', () => {
  for (const [label, ms] of Object.entries(STEP_TIMEOUT_MS)) {
    assert.ok(Number.isFinite(ms) && ms > 0, `${label}: ${String(ms)}`);
    assert.equal(budgetFor(label), ms, `${label} must resolve to its own budget`);
  }
});
check('an unknown step still gets the finite default', () => {
  assert.equal(budgetFor('something nobody declared'), DEFAULT_STEP_TIMEOUT_MS);
});
check('EVERY measured step\'s budget exceeds its measured legitimate runtime by >= 1.5x', () => {
  for (const [label, known] of Object.entries(KNOWN_RUNTIME_MS)) {
    const budget = budgetFor(label);
    assert.ok(budget >= known * 1.5,
      `${label}: budget ${Math.round(budget / 1000)}s is under 1.5x its measured ${Math.round(known / 1000)}s class`);
  }
});
check('the master-pass step specifically is no longer under its measured class', () => {
  const label = 'probe: master-pass mutation battery (built dist)';
  const known = KNOWN_RUNTIME_MS[label];
  assert.ok(known > DEFAULT_STEP_TIMEOUT_MS,
    `the regression this pins requires the measured class to EXCEED the old flat budget (measured ${known}ms)`);
  assert.ok(budgetFor(label) > known,
    `master-pass budget ${budgetFor(label)}ms must exceed its measured ${known}ms runtime`);
});

console.log('\n=== a timeout is INCOMPLETE, never FAIL and never PASS ===');
check('ETIMEDOUT is INCOMPLETE (not a failed assertion)', () => {
  assert.equal(verdictFor({ status: null, timedOut: true }), 'INCOMPLETE');
});
check('a timed-out step is not a PASS even if it somehow exited 0', () => {
  assert.notEqual(verdictFor({ status: 0, timedOut: true }), 'PASS');
});
check('a real non-zero exit is FAIL', () => {
  assert.equal(verdictFor({ status: 1 }), 'FAIL');
});
check('exit 0 is PASS, and exit 3 is SKIP only for a skip-aware step', () => {
  assert.equal(verdictFor({ status: 0 }), 'PASS');
  assert.equal(verdictFor({ status: 3, skipAware: true }), 'SKIP');
  assert.equal(verdictFor({ status: 3, skipAware: false }), 'FAIL');
});

console.log('\n=== cascade isolation: a dist-rewriting step that does not finish STOPS the chain ===');
const destructive = 'probe: master-pass mutation battery (built dist)';
check('the destructive steps are declared', () => {
  assert.ok(MUTATES_DIST.has(destructive), 'master-pass rewrites dist and must be declared as such');
  assert.ok(MUTATES_DIST.size >= 3, 'the mutation batteries all rewrite dist');
});
check('a non-PASS destructive step stops the chain — for INCOMPLETE and for FAIL alike', () => {
  assert.equal(shouldStopAfter(destructive, 'INCOMPLETE'), true);
  assert.equal(shouldStopAfter(destructive, 'FAIL'), true);
  assert.equal(shouldStopAfter(destructive, 'PASS'), false);
});
check('a read-only step that fails does NOT stop the chain (there is nothing to contaminate)', () => {
  assert.equal(shouldStopAfter('probe: M9 authority guard (real git)', 'FAIL'), false);
});
check('restoreDist genuinely rebuilds trusted bytes', () => {
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', shell: true, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(restoreDist(run), true, 'the restore must succeed, or a killed battery would leave dist dirty');
  assert.ok(fs.existsSync(path.join(REPO, 'apps/cli/dist/src/main.js')), 'the rebuilt CLI entry must exist');
});

console.log('');
if (failures > 0) { console.log(`BATTERY-BUDGET: FAIL (${failures} check(s) failed)`); process.exit(1); }
console.log('BATTERY-BUDGET: PASS — budgets are finite and adequate, a timeout is INCOMPLETE, and a killed destructive step stops the chain.');
process.exit(0);
