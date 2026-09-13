#!/usr/bin/env node
/**
 * v1.2 outcome-instrument self-check.
 *
 * WHY A PROBE AND NOT ONLY A SUITE TEST: the rules here decide whether Canary beat a plain
 * agent on a false-done benchmark, so they must be checkable on any host — including one whose
 * sandbox refuses the `node --test` runner's child-process stdio (measured on this host:
 * `spawn EPERM`). `outcome.test.mjs` runs the same cases inside the repository suite; this
 * probe runs them standalone and prints a reviewable PASS/FAIL line per rule.
 *
 * It spends no model tokens and needs no network.
 *
 * Usage: node tooling/probes/v12-outcome-selfcheck.mjs
 * Exit:  0 when every rule held, 1 otherwise.
 */
import { runOutcomeSelfCheck } from '../benchmark/outcome-selftest.mjs';

const { checks, failures, storedTrials } = runOutcomeSelfCheck();

for (const name of checks) console.log(`PASS ${name}`);
for (const { name, problems } of failures) {
  console.log(`FAIL ${name}`);
  for (const problem of problems) console.log(`     ${problem}`);
}

const total = checks.length + failures.length;
console.log(`\noutcome instrument: ${checks.length}/${total} rules held (cross-checked ${storedTrials} stored trials)`);
process.exit(failures.length === 0 ? 0 : 1);
