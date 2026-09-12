#!/usr/bin/env node
/**
 * WHY DID THE TOKENS GO DOWN? — the mechanism behind the raw-token delta.
 *
 * The owner's requirement is NEGATIVE overhead: with Canary, the same agent must spend FEWER model
 * tokens than without it. A total is not an explanation, and an explanation is what tells us
 * whether the saving generalises or is an artefact of one arm's prompt. This probe reads a stored
 * bench report plus its per-trial records and decomposes the delta into the quantities the ledger
 * measures per trial:
 *
 *   - model turns (each turn re-reads the accumulated context, so turns dominate cache reads),
 *   - how many times the MODEL ran the project's own checks (the work Canary takes over),
 *   - the bytes of tool output the model was shown,
 *   - the tokens the model spent AFTER its last file edit (verification/ceremony, when attributable).
 *
 * It prints per-arm means, the delta against the nominated baseline arm, and the per-trial rows so
 * a reader can see whether the saving is uniform or carried by a few runs.
 *
 * Usage: node tooling/probes/token-overhead-mechanism.mjs [--label bench-r4] [--baseline plain]
 */
import fs from 'node:fs';
import path from 'node:path';

const BENCH = path.resolve(import.meta.dirname, '..', 'benchmark');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const label = arg('label', 'bench-r4');
const baseline = arg('baseline', 'plain');
const resultsDir = path.join(BENCH, 'results');

const recordFiles = fs.readdirSync(resultsDir)
  .filter((f) => f.startsWith(`${label}-`) && f.endsWith('.json') && f !== `${label}.json`)
  .sort();
if (recordFiles.length === 0) {
  console.error(`no trial records for label "${label}" in ${resultsDir}`);
  process.exit(2);
}
const records = recordFiles.map((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')));

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const collect = (rs, get) => rs.map(get).filter((v) => typeof v === 'number');

const arms = [...new Set(records.map((r) => r.arm))].sort();
const summary = {};
for (const arm of arms) {
  const rs = records.filter((r) => r.arm === arm);
  summary[arm] = {
    trials: rs.length,
    tokens: r1(mean(collect(rs, (r) => num(r.agentResult?.usage?.totalTokens)))),
    cacheRead: r1(mean(collect(rs, (r) => num(r.agentResult?.usage?.cacheReadTokens)))),
    output: r1(mean(collect(rs, (r) => num(r.agentResult?.usage?.outputTokens)))),
    turns: r1(mean(collect(rs, (r) => num(r.agentResult?.numTurns)))),
    checksByModel: r1(mean(collect(rs, (r) => num(r.stream?.commands?.checks)))),
    visibleBytes: r1(mean(collect(rs, (r) => num(r.stream?.bytes?.toolResultTotal)))),
    canaryBytes: r1(mean(collect(rs, (r) => num(r.stream?.bytes?.canaryVisible)))),
    tailTokens: r1(mean(collect(rs, (r) => num(r.stream?.tail?.tokensAfterLastEdit)))),
    tailTrials: collect(rs, (r) => num(r.stream?.tail?.tokensAfterLastEdit)).length,
    secs: r1(mean(collect(rs, (r) => num(r.agent?.secs)))),
  };
}

console.log(`label: ${label}   baseline: ${baseline}   records: ${records.length}`);
console.log(`instrument(s): ${[...new Set(records.map((r) => r.instrument?.version ?? 'unknown'))].join(', ')}\n`);
const cols = ['trials', 'tokens', 'cacheRead', 'output', 'turns', 'checksByModel', 'visibleBytes', 'canaryBytes', 'tailTokens', 'secs'];
console.log(`arm        | ${cols.map((c) => c.padStart(13)).join(' | ')}`);
for (const arm of arms) {
  const s = summary[arm];
  console.log(`${arm.padEnd(10)} | ${cols.map((c) => String(s[c] ?? 'n/a').padStart(13)).join(' | ')}`);
}

const base = summary[baseline];
if (base === undefined) {
  console.log(`\n(no "${baseline}" arm in this label — nothing to compare against)`);
} else {
  console.log(`\n=== delta against "${baseline}" (negative tokens is the product requirement) ===`);
  for (const arm of arms) {
    if (arm === baseline) continue;
    const s = summary[arm];
    const pct = (a, b) => (b === null || b === 0 || a === null ? null : `${a - b >= 0 ? '+' : ''}${(Math.round(((a - b) / b) * 1000) / 10)}%`);
    console.log(`${arm}:`);
    console.log(`  raw tokens      ${s.tokens} vs ${base.tokens}   ${pct(s.tokens, base.tokens)}`);
    console.log(`  turns           ${s.turns} vs ${base.turns}   ${pct(s.turns, base.turns)}`);
    console.log(`  checks by model ${s.checksByModel} vs ${base.checksByModel}   ${pct(s.checksByModel, base.checksByModel)}`);
    console.log(`  visible bytes   ${s.visibleBytes} vs ${base.visibleBytes}   ${pct(s.visibleBytes, base.visibleBytes)}`);
    console.log(`  wall seconds    ${s.secs} vs ${base.secs}   ${pct(s.secs, base.secs)}`);
  }
  console.log('\n=== per-trial rows (tokens / turns / checks / visible bytes / secs) ===');
  for (const r of records.slice().sort((a, b) => (a.arm === b.arm ? a.label.localeCompare(b.label) : a.arm.localeCompare(b.arm)))) {
    console.log(`  ${(r.label ?? '?').padEnd(44)} ${String(r.agentResult?.usage?.totalTokens ?? 'n/a').padStart(8)} ${String(r.agentResult?.numTurns ?? '?').padStart(4)} ${String(r.stream?.commands?.checks ?? '?').padStart(3)} ${String(r.stream?.bytes?.toolResultTotal ?? '?').padStart(7)} ${String(r.agent?.secs ?? '?').padStart(6)}`);
  }
  // The saving must be visible per task, not only in the pooled mean — one long run can carry a mean.
  const tasks = [...new Set(records.map((r) => r.task))].sort();
  console.log('\n=== per-task token means ===');
  for (const task of tasks) {
    const row = arms.map((arm) => {
      const rs = records.filter((r) => r.task === task && r.arm === arm);
      return `${arm}=${r1(mean(collect(rs, (r) => num(r.agentResult?.usage?.totalTokens)))) ?? 'n/a'}`;
    });
    console.log(`  ${task.padEnd(26)} ${row.join('   ')}`);
  }
}

console.log('\nReading note: a per-message ledger is PARTIAL on this CLI, so `tailTokens` counts only');
console.log('the trials where it is attributable; `n/a` means "not measurable here", never zero.');
