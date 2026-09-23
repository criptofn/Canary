#!/usr/bin/env node
/**
 * v1.4 RELEASE-GATE BUDGETS AND CONTROL FLOW.
 *
 * WHY THIS IS ITS OWN MODULE. `verify-productization.mjs` applied ONE flat
 * `timeout: 900_000` to EVERY step. MEASURED: the master-pass mutation battery
 * takes ~993 s standalone, so on a loaded machine the release gate killed a step
 * whose legitimate runtime class exceeds the budget — twice, with the same
 * downstream cascade. A gate that cannot wait for its known-valid workload is
 * not a gate; it is a coin toss with a red summary.
 *
 * The rules here are pure and testable so the budget can be pinned by a
 * deterministic probe instead of by a comment (see
 * `tooling/probes/v14-battery-budget.mjs`), and so "the test FAILED" can never be
 * confused with "the test DID NOT COMPLETE".
 */

/** Applied when a step declares nothing: unchanged from the historical value. */
export const DEFAULT_STEP_TIMEOUT_MS = 900_000;

/**
 * MEASURED legitimate runtimes (this machine, 2026-09-21), used by the regression
 * probe to require real headroom rather than a hopeful number. A budget below
 * `1.5 x known` is considered a defect, not a preference: these steps vary with
 * load, and the failure mode of a tight budget is a false red.
 */
export const KNOWN_RUNTIME_MS = {
  'probe: master-pass mutation battery (built dist)': 993_000,
  'probe: architecture closure mutations (scratch builds)': 393_000,
  'probe: architecture closure matrix': 300_000,
  'probe: packed architecture matrix': 289_000,
  'full unit suite': 390_000,
};

/** Explicit per-step budgets. Finite everywhere: a hang must still be caught. */
export const STEP_TIMEOUT_MS = {
  'full unit suite': 1_800_000,
  'probe: M10.2 adversarial authority battery (real git)': 1_800_000,
  'probe: master-pass split-verdict subjectivity battery (real git)': 1_800_000,
  'probe: master-pass mutation battery (built dist)': 2_700_000,
  'probe: 1.1 P0 trust-boundary mutations (scratch builds)': 1_800_000,
  'probe: architecture closure matrix': 1_800_000,
  'probe: architecture closure mutations (scratch builds)': 1_800_000,
  'probe: packed architecture matrix': 1_800_000,
  'probe: 1.1 discrimination completion regressions (candidate, promotion, doctor, Stop hook)': 1_800_000,
  'probe: installed HARDENED production authority and custody': 1_800_000,
  'probe: HARDENED provider boundary (measured, not claimed)': 1_800_000,
};

/**
 * Steps that REWRITE `dist` in place. If one of these does not finish, everything
 * downstream would be judged against bytes nobody can account for — MEASURED:
 * a single master-pass timeout produced FIVE artificial failures in the steps
 * after it. The battery therefore restores trusted bytes and stops, reporting the
 * ORIGINAL failure instead of a cascade.
 */
export const MUTATES_DIST = new Set([
  'probe: master-pass mutation battery (built dist)',
  'probe: 1.1 P0 trust-boundary mutations (scratch builds)',
  'probe: architecture closure mutations (scratch builds)',
  'probe: dist-mutation guard (interrupted-battery recovery)',
]);

export function budgetFor(label = '') {
  const ms = STEP_TIMEOUT_MS[label] ?? DEFAULT_STEP_TIMEOUT_MS;
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_STEP_TIMEOUT_MS;
}

/**
 * The verdict vocabulary. `INCOMPLETE` exists so a killed step is never reported
 * as a failed test: "the assertion did not hold" and "we ran out of time before
 * the assertion could be reached" are different facts, and only the first is
 * evidence about the product.
 */
export function verdictFor({ status, skipAware = false, timedOut = false }) {
  if (timedOut) return 'INCOMPLETE';
  if (status === 0) return 'PASS';
  if (skipAware && status === 3) return 'SKIP';
  return 'FAIL';
}

/**
 * Should the battery stop after this step? Yes when a step that REWRITES `dist`
 * did not PASS: the next step would read bytes this run cannot vouch for.
 * A failure in a read-only step is reported and the battery continues — there is
 * no contamination to spread.
 */
export function shouldStopAfter(label, verdict) {
  if (verdict === 'PASS') return false;
  return MUTATES_DIST.has(label);
}

/** Restore trusted compiled bytes after a destructive step did not finish. */
export function restoreDist(run) {
  const r = run('npm', ['exec', '--', 'tsc', '-b', '--force']);
  return r.status === 0;
}
