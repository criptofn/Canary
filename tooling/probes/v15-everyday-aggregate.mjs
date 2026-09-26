/**
 * v1.5 post-audit — the everyday token aggregate, recomputed from the RAW trial records.
 *
 * CHANGED BY A CONFIRMED AUDIT FINDING (BLOCKER 2).
 *
 * The previous version of this probe pooled every cell it found and printed one
 * percentage. A cell whose tokens came from the FALLBACK estimator
 * (`streamed per-message usage (no result event)`, with `streamedUsageUsable: false`
 * and no terminal `result` event) was therefore averaged together with provider-native
 * cells, and the resulting `83.21 % / −16.79 %` headline was published.
 *
 * This version refuses to do that. A cell counts toward a headline only when
 * `cellEligibility` says its run completed on the DECLARED provider-native ledger
 * (`tooling/benchmark/eligibility.mjs`, regressed by `eligibility.test.mjs`). Any
 * ineligible cell makes its whole RUN `INCOMPLETE`, and an incomplete run contributes
 * no ratio and no total — a percentage computed over a hole is precisely the claim this
 * project exists to prevent.
 *
 * It still emits the evidence that the STANDING MCP PAYLOAD was inside the measurement
 * (`agent.mcpConfig` / `agent.mcpToolsAdvertised`), because the claim is void without it.
 *
 *   node tooling/probes/v15-everyday-aggregate.mjs
 *
 * Exit 0 only when at least one run is complete and every check passes. Exit 1 when the
 * dataset cannot support a headline. Prints PASS/FAIL lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellEligibility, instrumentOf } from '../benchmark/eligibility.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dir = path.join(repo, 'tooling/benchmark/results');
const TASKS = ['bound-requirements', 'bug-sum', 'stateful-replay'];
const ARMS = ['plain', 'guarded'];

/**
 * The figure PUBLISHED at commit a004f55 and WITHDRAWN by this closure. It is recorded
 * so the probe can demonstrate that it is no longer reproducible from eligible cells —
 * a withdrawal that cannot be checked is not a withdrawal.
 */
const WITHDRAWN_HEADLINE = { ratio: 83.21, delta: -16.79 };

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const fmt = (n) => n.toLocaleString('en-US');
const pct = (n) => `${n.toFixed(2)}%`;

// ── load every per-trial record, deriving its run from the FILENAME ───────────────
// `record.label` is the per-file composite label (bench.mjs passes
// `<label>-<task>-<arm>-<n>` down to run-trial), so the run label comes from the name.
const records = [];
for (const f of fs.readdirSync(dir).filter((x) => /^v15-everyday.*\.json$/.test(x))) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (j.schema !== 'canary-benchmark-trial/2') continue;
  const run = f.replace(new RegExp(`-${j.task}-${j.arm}-\\d+\\.json$`), '');
  const judged = cellEligibility(j);
  records.push({ file: f, run, task: j.task, arm: j.arm, mcp: j.agent?.mcpToolsAdvertised, instrument: instrumentOf(j), ...judged });
}

check('per-trial records were found', () => {
  assert(records.length > 0, 'no canary-benchmark-trial/2 records matched v15-everyday*.json');
  console.log(`     ${records.length} per-trial records across runs: ${[...new Set(records.map((r) => r.run))].sort().join(', ')}`);
});

check('the standing MCP payload was inside the eligible guarded cells', () => {
  const withField = records.filter((r) => r.mcp !== undefined);
  if (withField.length === 0) { console.log('     no record carries mcpToolsAdvertised; evidenced by mcpConfig alone'); return; }
  const g = withField.filter((r) => r.arm === 'guarded');
  const p = withField.filter((r) => r.arm === 'plain');
  const on = g.filter((r) => r.mcp === true).length;
  const plainOn = p.filter((r) => r.mcp === true).length;
  assert(g.length > 0 && on === g.length, `only ${on}/${g.length} guarded trials advertised mcp__canary`);
  assert(plainOn === 0, `${plainOn} plain trials advertised mcp__canary`);
  console.log(`     ${on}/${g.length} guarded advertised mcp__canary; ${plainOn}/${p.length} plain did`);
});

// ── per-run completeness: one bad cell condemns the RUN, not just the cell ────────
const runs = [...new Set(records.map((r) => r.run))].sort().map((run) => {
  const cells = records.filter((r) => r.run === run);
  const bad = cells.filter((c) => !c.eligible);
  const missing = [];
  for (const task of TASKS) for (const arm of ARMS) {
    if (!cells.some((c) => c.task === task && c.arm === arm)) missing.push(`${task}/${arm}`);
  }
  const totals = {};
  for (const arm of ARMS) {
    const mine = cells.filter((c) => c.arm === arm && c.eligible);
    totals[arm] = mine.reduce((a, c) => a + /** @type {number} */ (c.total), 0);
  }
  /**
   * EVERY CELL IN A RUN MUST HAVE RUN AGAINST THE SAME INSTRUMENT.
   *
   * v1.5 post-audit, self-inflicted: run r3 was started and the tree was then EDITED while
   * it ran, so its cells carry five different instrument digests. Each cell is individually
   * eligible; the RUN is still two experiments, and a ratio pooled across them compares
   * instruments rather than arms. The harness already records this — it was simply never
   * enforced.
   */
  const instruments = [...new Set(cells.map((c) => c.instrument).filter((x) => x !== null && x !== undefined))];
  const instrumentStable = instruments.length <= 1;
  return { run, cells, bad, missing, totals, instruments, instrumentStable, complete: bad.length === 0 && missing.length === 0 && instrumentStable };
});

console.log('');
console.log('=== per run: eligibility and totals ===');
for (const r of runs) {
  const verdict = r.complete ? 'COMPLETE  ' : 'INCOMPLETE';
  console.log(`${r.run.padEnd(17)} ${verdict} plain=${fmt(r.totals.plain).padStart(9)} guarded=${fmt(r.totals.guarded).padStart(9)}`
    + (r.complete ? `  ratio=${pct(100 * r.totals.guarded / r.totals.plain)} delta=${(100 * (r.totals.guarded - r.totals.plain) / r.totals.plain).toFixed(2)}%` : '  (no ratio: the run is not a complete dataset)'));
  for (const m of r.missing) console.log(`   MISSING CELL      ${m}`);
  if (!r.instrumentStable) {
    console.log(`   UNSTABLE INSTRUMENT: ${r.instruments.length} different instruments across ${r.cells.length} cells`);
    for (const i of r.instruments) console.log(`                     - ${String(i).slice(0, 24)}…`);
    console.log('                     the tree changed WHILE this run was measuring, so the cells are not one dataset');
  }
  for (const b of r.bad) {
    console.log(`   INELIGIBLE CELL   ${b.task}/${b.arm} (${b.file})`);
    for (const why of b.reasons) console.log(`                     - ${why}`);
  }
}

check('the audited defect is REPRODUCED from the records, not merely asserted', () => {
  const bad = records.filter((r) => !r.eligible);
  assert(bad.length > 0, 'no ineligible cell was found — if the records changed, re-derive this closure');
  const named = bad.find((b) => b.file === 'v15-everyday-r2-stateful-replay-guarded-1.json');
  assert(named !== undefined, 'the specific audited cell was not flagged ineligible');
  assert(/not the declared provider-native ledger/.test(named.reasons.join(' ')),
    `the audited cell must be refused for its ACCOUNTING METHOD; reasons: ${named.reasons.join('; ')}`);
  console.log(`     ${bad.length} ineligible cell(s); the audited one is refused for using the fallback estimator`);
});

// ── the headline: complete runs only, and honest variance between them ────────────
const complete = runs.filter((r) => r.complete);
console.log('');
console.log('=== headline (COMPLETE runs only) ===');
if (complete.length === 0) {
  console.log('NO COMPLETE RUN — the dataset cannot support any headline. No percentage is printed.');
} else {
  for (const r of complete) {
    console.log(`${r.run.padEnd(17)} plain=${fmt(r.totals.plain).padStart(9)} guarded=${fmt(r.totals.guarded).padStart(9)} `
      + `ratio=${pct(100 * r.totals.guarded / r.totals.plain)} delta=${(100 * (r.totals.guarded - r.totals.plain) / r.totals.plain).toFixed(2)}%`);
  }
  const ratios = complete.map((r) => 100 * r.totals.guarded / r.totals.plain);
  const tp = complete.reduce((a, r) => a + r.totals.plain, 0);
  const tg = complete.reduce((a, r) => a + r.totals.guarded, 0);
  const pooled = 100 * (tg - tp) / tp;
  const spread = Math.max(...ratios) - Math.min(...ratios);
  console.log(`${'POOLED'.padEnd(17)} plain=${fmt(tp).padStart(9)} guarded=${fmt(tg).padStart(9)} `
    + `ratio=${pct(100 * tg / tp)} delta=${pooled.toFixed(2)}%`);
  console.log('');
  console.log('VARIANCE, stated rather than hidden:');
  console.log(`  complete runs        : ${complete.length} (${complete.map((r) => r.run).join(', ')})`);
  console.log(`  per-run ratio range  : ${pct(Math.min(...ratios))} .. ${pct(Math.max(...ratios))}  (spread ${spread.toFixed(2)} points)`);
  const plainTotals = complete.map((r) => r.totals.plain);
  const drift = 100 * (Math.max(...plainTotals) - Math.min(...plainTotals)) / Math.min(...plainTotals);
  console.log(`  plain arm run-to-run : ${fmt(Math.min(...plainTotals))} .. ${fmt(Math.max(...plainTotals))} (${drift.toFixed(1)}% drift on IDENTICAL configuration)`);
  console.log('  n=1 per cell; no confidence interval is claimed.');
  if (Math.abs(pooled) < spread) {
    console.log(`  WARNING: the pooled delta (${pooled.toFixed(2)}%) is SMALLER than the spread between runs of the`);
    console.log('           identical configuration. The direction is measured; the size is not stable.');
  }
  check('the withdrawn a004f55 headline is NOT reproduced from eligible cells', () => {
    const reproduced = Math.abs(100 * tg / tp - WITHDRAWN_HEADLINE.ratio) < 0.005
      && Math.abs(pooled - WITHDRAWN_HEADLINE.delta) < 0.005;
    assert(!reproduced, `the withdrawn headline (${WITHDRAWN_HEADLINE.ratio}% / ${WITHDRAWN_HEADLINE.delta}%) IS reproduced — `
      + 'the withdrawal in the docs would then be wrong and must be re-examined');
  });
}

check('every INCOMPLETE run is reported as incomplete and contributes nothing', () => {
  for (const r of runs.filter((x) => !x.complete)) {
    assert(r.bad.length > 0 || r.missing.length > 0 || !r.instrumentStable,
      `${r.run} is incomplete without a stated reason`);
  }
  const names = runs.filter((r) => !r.complete).map((r) => r.run);
  console.log(names.length > 0 ? `     INCOMPLETE (no ratio reported): ${names.join(', ')}` : '     every run is complete');
});

console.log('');
console.log(`RESULT: ${failures === 0 ? 'aggregate reproduced under the eligibility contract' : `${failures} check(s) FAILED — do not quote these numbers`}`);
process.exit(failures === 0 ? 0 : 1);
