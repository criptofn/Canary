#!/usr/bin/env node
/** Audit one complete paired native capture without changing its evidence. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseAnthropicUsage, claudeUsageMatchesNative } from './v15-anthropic-usage.mjs';

const [root, output] = process.argv.slice(2);
assert.ok([root, output].every(p => p && path.isAbsolute(p)) && !fs.existsSync(output));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
let verified = 0;
for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const [, digest, relative] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
  assert.ok(digest && relative);
  const target = path.resolve(root, relative), contained = path.relative(root, target);
  assert.ok(contained && !contained.startsWith('..') && !path.isAbsolute(contained));
  assert.equal(hash(fs.readFileSync(target)), digest, relative); verified++;
}
const summary = read('summary.json'), outcomes = read('pilot-outcomes.json'), protocol = read('pilot-protocol.json');
assert.equal(summary.status, 'complete'); assert.equal(summary.failure, null);
assert.equal(summary.sessions.length, 12); assert.equal(outcomes.length, 12);
assert.equal(protocol.schedule.length, 12); assert.equal(protocol.oracleOptions.H1.strictAge, true);
assert.equal(hash(fs.readFileSync(path.join(root, 'instrument.mjs'))), summary.instrumentSha256);
assert.equal(hash(fs.readFileSync(path.join(root, 'oracle-instrument.mjs'))), protocol.oracleSha256);
const seenCalls = new Set();
const rows = summary.sessions.map(session => {
  const record = read(`${session.name}/record.json`), outcome = outcomes.find(o => o.name === session.name);
  assert.deepEqual(record, session); assert.ok(outcome);
  assert.equal(record.captureComplete, true); assert.equal(outcome.sessionCaptured, true);
  assert.equal(outcome.protectedUnchanged, true); assert.equal(outcome.baselinePreserved, true);
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const number of record.calls) {
    assert.ok(!seenCalls.has(number), 'a model call belongs to exactly one session'); seenCalls.add(number);
    const request = summary.requests.find(r => r.number === number);
    assert.equal(request.route, '/v1/messages'); assert.equal(request.httpStatus, 200);
    const parsed = parseAnthropicUsage(fs.readFileSync(path.join(root, `api-${number}.response.txt`), 'utf8'));
    assert.equal(parsed.complete, true); assert.deepEqual(parsed.usage, request.usage);
    for (const key of Object.keys(usage)) usage[key] += parsed.usage[key];
  }
  assert.deepEqual(usage, record.nativeUsage); assert.deepEqual(usage, outcome.nativeUsage);
  assert.equal(claudeUsageMatchesNative(record.terminal, usage, summary.model), true);
  const oracle = read(`oracle-${session.name}-final/oracle-result.json`);
  assert.equal(oracle.testPassed ? 'pass' : 'fail', outcome.correctness);
  const complete = record.exitCode === 0 && !record.timedOut && record.terminal.is_error === false;
  assert.equal(complete, outcome.sessionComplete);
  const currentStop = record.hookFired && record.checkpointChanged && record.checkpoint?.source === 'checkpoint';
  const blocks = record.hookEvents.filter(e => {
    try { return JSON.parse(e.stdout).decision === 'block'; } catch { return false; }
  }).length;
  return { name: session.name, arm: outcome.arm, correct: oracle.testPassed, complete,
    currentStop, passedStop: currentStop && record.checkpoint.status === 'pass',
    currentStatus: currentStop ? record.checkpoint.status : null, storedStatus: record.checkpoint?.status ?? null,
    stopBlocks: blocks, turns: record.terminal.num_turns,
    seconds: (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000,
    tokens: usage.input_tokens + usage.output_tokens, usage,
    mcpCalls: record.toolCalls.filter(call => call.name.startsWith('mcp__')).length,
    providerUsdCharge: outcome.providerUsdCharge, manualInterventions: outcome.manualInterventions };
});
assert.equal(seenCalls.size, summary.requests.filter(r => r.route === '/v1/messages').length);
const totals = ['plain', 'canary'].map(arm => {
  const selected = rows.filter(r => r.arm === arm); assert.equal(selected.length, 6);
  return { arm, correct: selected.filter(r => r.correct).length, complete: selected.filter(r => r.complete).length,
    passedStop: selected.filter(r => r.passedStop).length,
    tokens: selected.reduce((n, r) => n + r.tokens, 0), seconds: selected.reduce((n, r) => n + r.seconds, 0),
    providerUsdCharge: selected.reduce((n, r) => n + r.providerUsdCharge, 0) };
});
const result = { verified, source: root, instrumentSha256: hash(fs.readFileSync(import.meta.filename)),
  summarySha256: hash(fs.readFileSync(path.join(root, 'summary.json'))), rows, totals,
  limitation: 'One local model, six pairs. A stored setup PASS is not a current Stop PASS. No general token savings or automatic product rating.' };
fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
