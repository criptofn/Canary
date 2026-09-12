#!/usr/bin/env node
/**
 * WHAT DOES THE CLI'S USAGE ACCOUNTING ACTUALLY MEAN?
 *
 * `tooling/probes/agent-token-ledger.mjs` ran ONE real agent task and found that the sum of the
 * per-assistant-turn usages (101,958) does NOT equal the `result` event's usage total (53,680) —
 * a factor of ~1.9. That is a measurement defect either in the ledger or in the probe's
 * assumption, and it cannot be left as "one of them is wrong": the whole NEGATIVE-OVERHEAD
 * requirement is a claim about raw model tokens, so the harness must know which number is the
 * cost of the run.
 *
 * This probe dumps the actual shape, from a real run, so the answer is observed rather than
 * assumed:
 *
 *   - every event type and how often it occurs (the first run reported 49 `system` events, which
 *     no synthetic fixture models),
 *   - the `system` subtypes,
 *   - the usage carried by EVERY assistant event, in order,
 *   - the usage carried by the `result` event,
 *   - and the arithmetic relationships between them.
 *
 * It asserts nothing about tokens — it is an observation instrument. Its job is to make the
 * ledger's definition defensible, and to be re-runnable when the CLI changes shape.
 *
 * Usage: node tooling/probes/stream-usage-shape.mjs [--keep]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const keep = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-stream-shape-'));
fs.writeFileSync(path.join(TMP, 'VERSION.txt'), 'shape-fixture\n');

// A prompt that forces exactly one tool call and then an answer: two requests, so per-request
// accounting and session accounting can differ (which is the question).
const prompt = 'Read VERSION.txt in this directory, then reply with ONLY its contents.';

console.log('running one small real agent task to observe the stream shape…');
const run = spawnSync('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--allowedTools', 'Read', 'Bash'],
{ cwd: TMP, encoding: 'utf8', timeout: 300_000, windowsHide: true });
const stdout = run.stdout ?? '';
console.log(`agent exit ${run.status}; stream ${stdout.length} chars, ${stdout.split('\n').filter((l) => l.trim() !== '').length} line(s)\n`);
if (keep) {
  fs.writeFileSync(path.join(TMP, 'stream.jsonl'), stdout);
  console.log(`stream kept at ${path.join(TMP, 'stream.jsonl')}\n`);
}

const events = [];
let bad = 0;
for (const line of stdout.split('\n')) {
  if (line.trim() === '') continue;
  try { events.push(JSON.parse(line)); } catch { bad += 1; }
}

const typeCounts = {};
const systemSubtypes = {};
for (const ev of events) {
  const t = String(ev?.type ?? 'missing');
  typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  if (t === 'system') {
    const s = String(ev?.subtype ?? 'none');
    systemSubtypes[s] = (systemSubtypes[s] ?? 0) + 1;
  }
}

console.log('--- event types ---');
for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(16)} ${c}`);
console.log(`  unparseable lines ${bad}`);
console.log('\n--- system subtypes ---');
for (const [s, c] of Object.entries(systemSubtypes).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(24)} ${c}`);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

console.log('\n--- usage on EVERY assistant event (in order) ---');
const perAssistant = [];
for (const ev of events) {
  if (ev?.type !== 'assistant') continue;
  const u = ev?.message?.usage ?? null;
  const rows = [];
  const blocks = Array.isArray(ev?.message?.content) ? ev.message.content : [];
  for (const b of blocks) if (b?.type === 'tool_use') rows.push(String(b.name));
  const t = ev?.message?.id === undefined ? '(no message id)' : '';
  perAssistant.push({ u });
  console.log(`  ${u === null ? 'NO USAGE' : `in ${num(u.input_tokens)} out ${num(u.output_tokens)} cacheRead ${num(u.cache_read_input_tokens)} cacheCreate ${num(u.cache_creation_input_tokens)}`}  tools=[${rows.join(',')}] ${t}`);
}
console.log(`  assistant events: ${perAssistant.length}`);

/** Duplicate-message detection: a repeated message id means the CLI re-emitted, not re-billed. */
const ids = {};
for (const ev of events) {
  if (ev?.type !== 'assistant') continue;
  const id = ev?.message?.id ?? '(none)';
  ids[id] = (ids[id] ?? 0) + 1;
}
const repeated = Object.entries(ids).filter(([, c]) => c > 1);
console.log(`  distinct assistant message ids: ${Object.keys(ids).length}; repeated: ${JSON.stringify(repeated)}`);

const result = events.find((ev) => ev?.type === 'result') ?? null;
const ru = result?.usage ?? {};
console.log('\n--- usage on the result event ---');
console.log(`  in ${num(ru.input_tokens)} out ${num(ru.output_tokens)} cacheRead ${num(ru.cache_read_input_tokens)} cacheCreate ${num(ru.cache_creation_input_tokens)}`);
console.log(`  total ${num(ru.input_tokens) + num(ru.output_tokens) + num(ru.cache_read_input_tokens) + num(ru.cache_creation_input_tokens)}; num_turns=${result?.num_turns ?? '?'}`);

/** Every usage-bearing field on the result event, including ones the ledger ignores today. */
console.log('\n--- every numeric field on the result event ---');
const flat = [];
(function walk(o, p) {
  if (o === null || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number') flat.push(`${p}${k}=${v}`);
    else if (v !== null && typeof v === 'object') walk(v, `${p}${k}.`);
  }
})(result, '');
console.log(`  ${flat.join('\n  ') || '(none)'}`);

const sum = (f) => perAssistant.reduce((a, x) => a + f(x.u ?? {}), 0);
const sumTotal = sum((u) => num(u.input_tokens) + num(u.output_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens));
const resultTotal = num(ru.input_tokens) + num(ru.output_tokens) + num(ru.cache_read_input_tokens) + num(ru.cache_creation_input_tokens);
const last = perAssistant.length === 0 ? {} : (perAssistant[perAssistant.length - 1].u ?? {});
const lastTotal = num(last.input_tokens) + num(last.output_tokens) + num(last.cache_read_input_tokens) + num(last.cache_creation_input_tokens);

console.log('\n--- relationships (the reason this probe exists) ---');
console.log(`  sum of per-assistant-event tokens : ${sumTotal}`);
console.log(`  result event tokens               : ${resultTotal}`);
console.log(`  LAST assistant event tokens       : ${lastTotal}`);
console.log(`  sum == result ?                   : ${sumTotal === resultTotal}`);
console.log(`  last == result ?                  : ${lastTotal === resultTotal}`);
console.log(`  sum - result                      : ${sumTotal - resultTotal}`);
console.log(`  output: sum ${sum((u) => num(u.output_tokens))} vs result ${num(ru.output_tokens)}`);
console.log(`  cacheRead: sum ${sum((u) => num(u.cache_read_input_tokens))} vs result ${num(ru.cache_read_input_tokens)}`);

if (!keep) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`\n(temp dir kept: ${TMP})`);
console.log('\n=== stream shape observed; no claim asserted here ===');
process.exit(0);
