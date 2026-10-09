#!/usr/bin/env node
/** Derive final evidence and tool usage from immutable pilot records; never rewrite raw data. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canaryEvidenceStatus, pilotSessionComplete } from './v15-ollama-native-agent.mjs';

const [pilot, output] = process.argv.slice(2);
assert.ok(pilot && output && !fs.existsSync(output), 'usage: <pilot directory> <new report.json>');
const summaryFile = path.join(pilot, 'pilot-summary.json');
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
assert.ok(Array.isArray(summary.sessions) && summary.sessions.length > 0);
const rows = summary.sessions.map(session => {
  const record = JSON.parse(fs.readFileSync(path.join(session.attemptDir, 'record.json'), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(session.attemptDir, 'ledger.json'), 'utf8'));
  const events = fs.readFileSync(path.join(session.attemptDir, 'agent.stream.raw.txt'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const assistant = events.filter(event => event.type === 'assistant');
  for (const event of assistant) assert.ok(Number.isSafeInteger(event.message.usage.input_tokens) && Number.isSafeInteger(event.message.usage.output_tokens));
  assert.equal(assistant.reduce((sum, event) => sum + event.message.usage.input_tokens, 0), ledger.usage.input_tokens);
  assert.equal(assistant.reduce((sum, event) => sum + event.message.usage.output_tokens, 0), ledger.usage.output_tokens);
  const calls = assistant.flatMap(event => event.message.content).filter(block => block.type === 'tool_use');
  const checkpoint = record.checkpointFinal ? JSON.parse(record.checkpointFinal) : null;
  const response = record.manuallyDriven?.stdout ? JSON.parse(record.manuallyDriven.stdout) : null;
  return { label: session.label, arm: session.arm, captureComplete: pilotSessionComplete(session), captureExitCode: session.runExitCode,
    sourceCorrectness: session.correctnessStatus, seconds: ledger.wallSeconds,
    inputTokens: ledger.usage.input_tokens, outputTokens: ledger.usage.output_tokens, model: ledger.model,
    modelDigest: ledger.localModelRuntime.after.match.digest,
    toolCalls: calls.reduce((counts, call) => ({ ...counts, [call.name]: (counts[call.name] ?? 0) + 1 }), {}),
    checkpoints: record.agentManualCheckpoints?.length ?? 0, nativeHookFired: record.hookFiredDuringRun,
    sessionOutcome: ledger.agentSessionOutcome, checkpointStatus: checkpoint?.status ?? null,
    originalEvidenceLabel: record.verification.evidenceStatus,
    finalEvidenceLabel: session.arm === 'plain' ? 'not_applicable_plain_arm' : canaryEvidenceStatus(response, checkpoint),
    sourceRecord: path.join(session.attemptDir, 'record.json') };
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { probeSha256: hash(fs.readFileSync(import.meta.filename)), sourceSummarySha256: hash(fs.readFileSync(summaryFile)),
  sharedHelperSha256: hash(fs.readFileSync(path.join(import.meta.dirname, 'v15-ollama-native-agent.mjs'))),
  rawPilotStatus: summary.status, captureStatus: !summary.stopReason && rows.every(row => row.captureComplete) ? 'complete' : 'incomplete', rows,
  scope: 'Four local tool-agent sessions, not native Claude/Codex hooks. Native input/output counts only; Ollama does not provide separate cache or reasoning counters here.' };
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
for (const row of rows) console.log(`PASS native counter validation ${row.label}/${row.arm}: capture=${row.captureComplete ? 'complete' : 'incomplete'} (exit ${row.captureExitCode}), oracle=${row.sourceCorrectness}, final=${row.finalEvidenceLabel}, check calls=${row.toolCalls.run_check ?? 0}, native tokens=${row.inputTokens}+${row.outputTokens}, seconds=${row.seconds}`);
