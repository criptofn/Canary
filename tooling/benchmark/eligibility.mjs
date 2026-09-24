/**
 * v1.5 post-audit — WHICH TRIAL CELLS MAY ENTER A HEADLINE TOKEN AGGREGATE.
 *
 * WHY THIS EXISTS (CONFIRMED AUDIT FINDING, BLOCKER 2)
 * ----------------------------------------------------
 * The published v1.5 headline (`83.21 % of Plain, −16.79 %`) pooled twelve cells
 * under one accounting rule. It should not have. `v15-everyday-r2-stateful-replay-guarded-1.json`
 * carries:
 *
 *   agent.exitCode            4294967295      (the process did not exit 0)
 *   agentResult.isError       true
 *   agentResult.parseFailure  true
 *   stream.sawResult          false           (no terminal `result` event)
 *   streamedUsageUsable       false           (the harness itself says this path is unusable)
 *   usage.source              "streamed per-message usage (no result event)"
 *
 * That last line is the defect: the number came from the FALLBACK estimator, not
 * from the declared provider-native ledger the accounting rule names
 * (`result.usage`). Pooling it with eleven provider-native cells silently mixed two
 * incomparable accounting methods — which the release's own accounting rule forbids
 * ("Never mix incomparable accounting methods silently").
 *
 * The rule this module enforces: a cell may contribute to a headline ONLY when its
 * ledger is the declared one AND its run actually completed. Anything else makes the
 * aggregate INCOMPLETE. An incomplete aggregate is never reported as a percentage,
 * because a percentage computed from a dataset with a hole in it is exactly the kind
 * of claim this project exists to prevent.
 *
 * It is a pure function of one record so it can be tested against synthetic
 * adversarial records without running a benchmark (`eligibility.test.mjs`).
 */

/** The ONE accounting method a headline may rest on. */
export const PROVIDER_NATIVE_SOURCE = /^result\.usage/;

/**
 * May this trial cell contribute its token total to a headline aggregate?
 *
 * @param {unknown} record a `canary-benchmark-trial/2` record
 * @returns {{eligible: boolean, reasons: string[], total: number|null, source: string|null}}
 */
export function cellEligibility(record) {
  const reasons = [];
  const r = /** @type {any} */ (record ?? {});
  const usage = r?.agentResult?.usage ?? {};
  const total = Number(usage.totalTokens);
  const source = typeof usage.source === 'string' ? usage.source : null;

  // 1. The run has to have FINISHED, successfully.
  if (r?.agent?.exitCode !== 0) reasons.push(`agent exit code was ${r?.agent?.exitCode ?? 'absent'}, not 0`);
  if (r?.agent?.timedOut === true) reasons.push('the agent run timed out');
  if (r?.agentResult?.isError === true) reasons.push('agentResult.isError is true');
  if (r?.agentResult?.parseFailure === true) reasons.push('agentResult.parseFailure is true');
  // A trial that never produced its terminal event is a partial run, whatever its tokens.
  if (r?.stream?.sawResult !== true) reasons.push('the stream carried no terminal result event');

  // 2. The ledger has to be the DECLARED one — never a fallback estimator.
  if (source === null) reasons.push('the record names no usage source, so the accounting method is unknown');
  else if (!PROVIDER_NATIVE_SOURCE.test(source)) {
    reasons.push(`usage source is not the declared provider-native ledger: "${source}"`);
  }
  // Belt and braces: the harness's own verdict on its fallback path.
  if (r?.stream?.streamedUsageUsable === false && !(source !== null && PROVIDER_NATIVE_SOURCE.test(source))) {
    reasons.push('the streamed fallback usage is marked NOT usable by the harness');
  }

  // 3. There has to be a number to contribute.
  if (!Number.isFinite(total) || total <= 0) reasons.push(`no usable token total (${usage.totalTokens ?? 'absent'})`);

  return { eligible: reasons.length === 0, reasons, total: Number.isFinite(total) ? total : null, source };
}

/**
 * Aggregate a set of cells, refusing to invent a headline over a hole.
 *
 * @param {Array<{record: unknown, task?: string, arm?: string, run?: string}>} cells
 * @returns {{complete: boolean, cells: Array<object>, totals: Record<string, number>, incomplete: Array<object>}}
 */
export function aggregateCells(cells) {
  const judged = cells.map((c) => {
    const e = cellEligibility(c.record);
    return { ...c, ...e };
  });
  const incomplete = judged.filter((c) => !c.eligible);
  const totals = {};
  for (const c of judged) {
    if (!c.eligible) continue;
    const arm = String(c.arm ?? 'unknown');
    totals[arm] = (totals[arm] ?? 0) + /** @type {number} */ (c.total);
  }
  return { complete: incomplete.length === 0, cells: judged, totals, incomplete };
}
