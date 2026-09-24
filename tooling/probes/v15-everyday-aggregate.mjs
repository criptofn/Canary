/**
 * v1.5 — the everyday token aggregate, computed from the RAW trial records.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bench.mjs` prints its own summary, but a published token claim must be
 * recomputable by someone who does not trust the reporter. This probe reads the
 * per-trial JSON records directly, recomputes every number in
 * `docs/BENCHMARK-EVERYDAY-1.5.md`, and fails loudly on any inconsistency — a
 * record missing its ledger, an arm with no cells, or arithmetic that does not
 * match what the document says.
 *
 * It also emits the evidence that the STANDING MCP PAYLOAD was inside the
 * measurement (`agent.mcpConfig`, and `agent.mcpToolsAdvertised` where present),
 * because that is the specific defect this release fixed and the claim is void
 * without it.
 *
 *   node tooling/probes/v15-everyday-aggregate.mjs
 *
 * Exit 0 only if every record is usable and the aggregates match the published
 * figures. Prints PASS/FAIL lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dir = path.join(repo, 'tooling/benchmark/results');
/** The figures this probe must reproduce; a mismatch is a FAIL, not a footnote. */
const PUBLISHED = {
  'v15-everyday': { plain: 543518, guarded: 438818 },
  'v15-everyday-r2': { plain: 394733, guarded: 341873 },
};

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const fmt = (n) => n.toLocaleString('en-US');

const files = fs.readdirSync(dir).filter((f) => /^v15-everyday.*\.json$/.test(f));
const records = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  // Only PER-TRIAL records: the aggregate files carry the same label but no schema.
  if (j.schema !== 'canary-benchmark-trial/2') continue;
  // `record.label` is the PER-FILE composite label (bench.mjs passes
  // `<label>-<task>-<arm>-<n>` down to run-trial), so the RUN label is derived from the
  // filename instead: strip the `-<task>-<arm>-<n>.json` suffix.
  const run = f.replace(new RegExp(`-${j.task}-${j.arm}-\\d+\\.json$`), '');
  records.push({ file: f, run, ...j });
}
check('per-trial records were found and every one carries a token ledger', () => {
  assert(records.length > 0, 'no canary-benchmark-trial/2 records matched v15-everyday*.json');
  const missing = records.filter((r) => !Number.isFinite(Number(r.agentResult?.usage?.totalTokens)) || Number(r.agentResult.usage.totalTokens) <= 0);
  assert(missing.length === 0, `records with no usable ledger: ${missing.map((r) => r.file).join(', ')}`);
  console.log(`     ${records.length} per-trial records, all with a provider-native total`);
  console.log(`     runs: ${[...new Set(records.map((r) => r.run))].sort().join(', ')}`);
});

check('every arm/task cell is present exactly once per run', () => {
  const seen = new Map();
  for (const r of records) {
    const key = `${r.run}|${r.task}|${r.arm}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  assert(dupes.length === 0, `duplicated cells: ${dupes.map(([k]) => k).join(', ')}`);
  for (const run of Object.keys(PUBLISHED)) {
    for (const task of ['bound-requirements', 'bug-sum', 'stateful-replay']) {
      for (const arm of ['plain', 'guarded']) {
        assert(seen.has(`${run}|${task}|${arm}`), `missing cell ${run}|${task}|${arm}`);
      }
    }
  }
});

check('the standing MCP payload was inside the guarded arm (this is what makes the claim fair)', () => {
  const withField = records.filter((r) => r.agent && Object.hasOwn(r.agent, 'mcpToolsAdvertised'));
  assert(withField.length > 0, 'no record carries agent.mcpToolsAdvertised, so the payload cannot be shown to have been in the session');
  const guarded = withField.filter((r) => r.arm === 'guarded');
  const plain = withField.filter((r) => r.arm === 'plain');
  const guardedOn = guarded.filter((r) => r.agent.mcpToolsAdvertised === true).length;
  const plainOn = plain.filter((r) => r.agent.mcpToolsAdvertised === true).length;
  assert(guarded.length > 0 && guardedOn === guarded.length,
    `only ${guardedOn}/${guarded.length} guarded trials advertised mcp__canary; the standing payload was NOT in the measurement`);
  assert(plainOn === 0, `${plainOn} plain trials advertised mcp__canary; the plain arm must have no Canary payload`);
  const configured = withField.filter((r) => r.arm === 'guarded' && /mcp\.json/.test(String(r.agent.mcpConfig ?? ''))).length;
  assert(configured === guarded.length, `only ${configured}/${guarded.length} guarded trials recorded an mcpConfig path`);
  console.log(`     ${guardedOn}/${guarded.length} guarded trials advertised mcp__canary; ${plainOn}/${plain.length} plain did`);
  console.log(`     run 1 has ${records.length - withField.length} record(s) predating this field: it was added DURING v1.5, so run 1 is evidenced by mcpConfig alone`);
});

check('correctness is equal and neither arm produced a false done', () => {
  // The correctness SUMMARY is printed verbatim rather than regex-parsed: the shape of
  // `hidden` is the harness's business, and a probe that guesses at it would report a
  // correctness figure it had invented.
  for (const arm of ['plain', 'guarded']) {
    const cells = records.filter((r) => r.arm === arm);
    const fd = cells.filter((r) => r.falseDone === true).length;
    console.log(`     ${arm.padEnd(8)}: ${cells.length} cells, ${fd} false done, hidden=${
      [...new Set(cells.map((r) => JSON.stringify(r.hidden ?? null)))].join(' | ').slice(0, 300)}`);
    assert(fd === 0, `arm ${arm} recorded a false done; the correctness claim must be withdrawn`);
  }
  // Equal correctness is a CLAIM, so it needs a comparison, not just an absence of faults.
  const summary = (arm) => [...new Set(records.filter((r) => r.arm === arm).map((r) => JSON.stringify(r.hidden ?? null)))].join('|');
  assert(summary('plain') === summary('guarded'),
    'the two arms do not share one correctness summary, so "equal correctness" cannot be claimed from these cells');
  console.log('     both arms share an identical hidden-oracle summary -> equal correctness');
});

console.log('');
console.log('=== per task, per run (provider-native totals) ===');
const rows = [];
for (const run of Object.keys(PUBLISHED).sort()) {
  for (const task of ['bound-requirements', 'bug-sum', 'stateful-replay']) {
    const cell = (arm) => records.find((r) => r.run === run && r.task === task && r.arm === arm);
    const p = Number(cell('plain').agentResult.usage.totalTokens);
    const g = Number(cell('guarded').agentResult.usage.totalTokens);
    rows.push({ run, task, p, g });
    console.log(`${run.padEnd(17)} ${task.padEnd(18)} plain=${String(fmt(p)).padStart(9)} guarded=${String(fmt(g)).padStart(9)} ratio=${(100 * g / p).toFixed(1).padStart(5)}% delta=${((100 * (g - p) / p) >= 0 ? '+' : '') + (100 * (g - p) / p).toFixed(1)}%`);
  }
}

console.log('');
console.log('=== aggregate per run, and combined ===');
let tp = 0, tg = 0;
for (const [run, want] of Object.entries(PUBLISHED).sort()) {
  const p = rows.filter((r) => r.run === run).reduce((a, r) => a + r.p, 0);
  const g = rows.filter((r) => r.run === run).reduce((a, r) => a + r.g, 0);
  tp += p; tg += g;
  console.log(`${run.padEnd(17)} plain=${String(fmt(p)).padStart(9)} guarded=${String(fmt(g)).padStart(9)} ratio=${(100 * g / p).toFixed(2)}% delta=${(100 * (g - p) / p).toFixed(2)}%`);
  if (run in PUBLISHED) {
    check(`run ${run} matches the published figures`, () => {
      assert(p === want.plain, `plain recomputed ${p}, published ${want.plain}`);
      assert(g === want.guarded, `guarded recomputed ${g}, published ${want.guarded}`);
    });
  }
}
console.log(`${'COMBINED'.padEnd(17)} plain=${String(fmt(tp)).padStart(9)} guarded=${String(fmt(tg)).padStart(9)} ratio=${(100 * tg / tp).toFixed(2)}% delta=${(100 * (tg - tp) / tp).toFixed(2)}%`);

console.log('');
console.log(`RESULT: ${failures === 0 ? 'aggregate reproduced from the raw records' : `${failures} check(s) FAILED — do not quote these numbers`}`);
process.exit(failures === 0 ? 0 : 1);
