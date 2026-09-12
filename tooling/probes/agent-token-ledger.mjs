#!/usr/bin/env node
/**
 * THE TOKEN LEDGER, AGAINST A REAL AGENT STREAM.
 *
 * `stream.mjs` parses `--output-format stream-json`; its unit tests use synthetic events. This
 * probe closes the gap that matters: it runs ONE small real agent task, parses the REAL stream,
 * and checks the ledger against the CLI's own accounting — because a parser that agrees with its
 * own fixtures proves nothing about the shape the CLI actually emits.
 *
 * It also measures the thing the product is supposed to remove: the model running the project's
 * checks itself, and the bytes of runner output that enter its context as a result. That number is
 * the floor for what Canary can save the model.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseStream } from '../benchmark/stream.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ledger-'));
fs.writeFileSync(path.join(TMP, 'package.json'), `${JSON.stringify({
  name: 'ledger-fixture', private: true, scripts: { test: 'node run-tests.js' },
}, null, 2)}\n`);
fs.writeFileSync(path.join(TMP, 'run-tests.js'), [
  "'use strict';",
  "for (let i = 1; i <= 3; i += 1) console.log('ok ' + i + ' - ledger check ' + i);",
  "console.log('3 passing (0.01s)');",
  '',
].join('\n'));

const prompt = 'Run the project test command (npm test) in this directory, then reply with ONLY the number of passing tests.';

console.log('running one small real agent task to capture a stream…');
const run = spawnSync('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--allowedTools', 'Bash', 'Read', 'Glob'],
{ cwd: TMP, encoding: 'utf8', timeout: 300_000, windowsHide: true });
const stdout = run.stdout ?? '';
fs.writeFileSync(path.join(TMP, 'stream.jsonl'), stdout);
console.log(`agent exit ${run.status}; stream ${stdout.length} chars`);
if (process.argv.includes('--keep')) console.log(`stream kept at ${path.join(TMP, 'stream.jsonl')}`);

const ledger = parseStream(stdout);
console.log('\n--- ledger ---');
console.log(`  turns:              ${ledger.turns} (${ledger.assistantEvents} assistant event(s) over ${ledger.messages} message(s))`);
console.log(`  tokens:             total ${ledger.usage.total} (in ${ledger.usage.input} / out ${ledger.usage.output} / cache-read ${ledger.usage.cacheRead} / cache-create ${ledger.usage.cacheCreation}) from ${ledger.usage.source}`);
console.log(`  session total:      ${ledger.sessionUsage === null ? 'not reported by this CLI' : ledger.sessionUsage.total}`);
console.log(`  per-message figure: ${ledger.streamedUsage.total} usable=${ledger.streamedUsageUsable}`);
console.log(`  tool calls:         ${ledger.toolCalls.length} (${[...new Set(ledger.toolCalls.map((c) => c.name))].join(', ') || 'none'})`);
console.log(`  agent-visible bytes:${ledger.bytes.toolResultTotal} (largest single ${ledger.bytes.largestToolResult})`);
console.log(`  checks run by model:${ledger.commands.checks}   canary commands: ${ledger.commands.canary}`);
console.log(`  commands:           ${JSON.stringify(ledger.commands.canaryCommands)}`);
console.log(`  result event:       ${ledger.sawResult ? `subtype=${ledger.result?.subtype} num_turns=${ledger.result?.numTurns}` : 'MISSING'}`);
console.log(`  unknown event types:${JSON.stringify(ledger.unknownTypes)}`);
console.log(`  parse errors:       ${ledger.parseErrors}`);

check('1. the stream produced a result event and a measurable ledger', () => {
  assert(run.status === 0, `the agent must exit cleanly: ${(run.stderr ?? '').slice(0, 300)}`);
  assert(ledger.sawResult, 'the CLI must emit a result event; without it the ledger cannot be trusted');
  assert(ledger.turns >= 2, `expected at least two turns (a tool call and an answer), got ${ledger.turns}`);
  assert(ledger.usage.total > 0, 'the ledger must record tokens');
});

check('2. the ledger\'s headline total is the CLI\'s own result-event figure, and it says so', () => {
  const perMessage = ledger.perTurn.reduce((a, t) => a + t.usage.total, 0);
  // The FIRST version of this probe asserted `per-message sum === result total` and failed on a
  // real run (101,958 vs 53,680). That was not a parser bug to paper over: the CLI emits one
  // assistant event PER CONTENT BLOCK (several sharing one `message.id`) and their `usage` is
  // partial (`output_tokens: 0` on every one). So the probe's assumption was wrong, and the
  // ledger now (a) de-duplicates messages, (b) flags per-message usage as unusable when it is,
  // and (c) takes its headline from the result event. This check pins exactly that behaviour.
  assert(ledger.usage.total > 0, 'the headline total must come from the result event');
  assert(/result\.usage|modelUsage/.test(String(ledger.usage.source)),
    `the ledger must name where the total came from (got ${JSON.stringify(ledger.usage.source)})`);
  assert(ledger.messages <= ledger.assistantEvents,
    'one message may arrive as several events, never the reverse');
  if (ledger.usage.output > 0 && perMessage === 0) {
    assert(ledger.streamedUsageUsable === false,
      'per-message usage with no output accounting is PARTIAL and must be flagged unusable');
  }
  console.log(`      → ${ledger.assistantEvents} assistant event(s) over ${ledger.messages} message(s); headline ${ledger.usage.total} from "${ledger.usage.source}"; per-message figure usable: ${ledger.streamedUsageUsable}`);
  if (ledger.sessionUsage !== null) {
    const wider = ledger.sessionUsage.total - ledger.usage.total;
    console.log(`      → the CLI's per-model session total is ${ledger.sessionUsage.total} (${wider >= 0 ? '+' : ''}${wider} vs the headline)`);
  }
});

check('3. it measured the model running the project checks, and paying for the output', () => {
  assert(ledger.commands.checks >= 1,
    `the model was asked to run the checks and the ledger must see it: ${JSON.stringify(ledger.toolCalls.map((c) => c.command))}`);
  assert(ledger.bytes.toolResultTotal > 0, 'the model read something, so visible bytes must be > 0');
  console.log(`      → this is what Canary can remove: ${ledger.bytes.toolResultTotal} bytes of tool output and ${ledger.commands.total} model-run command(s)`);
});

check('4. Canary-visible bytes are attributable (and are zero when Canary was not used)', () => {
  assert(ledger.bytes.canaryVisible === 0,
    `this run never invoked Canary, so its share must be 0 (got ${ledger.bytes.canaryVisible})`);
});

check('5. the tail is reported honestly when no file was edited', () => {
  assert(ledger.tail.lastFileEditTurn === -1, 'no file was edited in this task');
  assert(ledger.tail.turnsAfterLastEdit === 0, 'with no edit there is no tail to attribute');
  assert(ledger.tail.tokensAfterLastEdit === (ledger.streamedUsageUsable ? 0 : null),
    'either a measured zero or an explicit null — never a number the stream cannot support');
});

if (!process.argv.includes('--keep')) fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== token ledger: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
