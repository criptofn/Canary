#!/usr/bin/env node
/** Verify native evidence bytes and generate a factual report without rating inference. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseAnthropicUsage } from './v15-anthropic-usage.mjs';

const arg = (key) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? null : process.argv[i + 1]; };
const evidence = arg('evidence'), out = arg('out');
assert.ok(evidence && out && path.isAbsolute(evidence) && path.isAbsolute(out));
assert.ok(!fs.existsSync(out), 'new report path required');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => fs.readFileSync(path.join(evidence, file), 'utf8');
const summary = JSON.parse(read('summary.json'));
const lines = read('SHA256SUMS').trim().split('\n');
for (const line of lines) {
  const [, expected, file] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
  assert.ok(expected && file); assert.equal(hash(fs.readFileSync(path.join(evidence, file))), expected, `altered evidence: ${file}`);
}
assert.equal(hash(fs.readFileSync(path.join(evidence, 'instrument.mjs'))), summary.instrumentSha256);
const rows = [];
for (const record of summary.sessions) {
  const calls = record.calls.map((number) => summary.requests.find((r) => r.number === number));
  let usage = { input_tokens: 0, output_tokens: 0 }, complete = calls.length > 0;
  for (const call of calls) {
    const file = `api-${call.number}.response.txt`;
    const observed = fs.existsSync(path.join(evidence, file)) ? parseAnthropicUsage(read(file)) : { complete: false };
    complete &&= observed.complete && call.httpStatus === 200;
    if (observed.complete) {
      assert.deepEqual(observed.usage, call.usage);
      usage.input_tokens += observed.usage.input_tokens; usage.output_tokens += observed.usage.output_tokens;
    }
  }
  if (complete) assert.deepEqual(usage, record.nativeUsage);
  const file = `${record.name}-outcome.json`;
  const outcome = fs.existsSync(path.join(evidence, file)) ? JSON.parse(read(file)) : null;
  rows.push({ name: record.name, correctness: outcome?.correctness ?? 'control',
    complete: record.exitCode === 0 && !record.timedOut && record.terminal?.is_error === false && complete && record.accountingMatches,
    captured: complete && record.accountingMatches && record.terminal !== null,
    hook: record.hookFired, checkpoint: record.checkpoint
      ? `${record.checkpoint.status} (${record.checkpointChanged ? record.checkpoint.source : 'historical'})` : 'none',
    input: complete ? usage.input_tokens : null, output: complete ? usage.output_tokens : null,
    turns: record.terminal?.num_turns ?? null, permissionDenials: record.terminal?.permission_denials?.length ?? null,
    successfulMcp: record.toolCalls?.filter((call) => call.name.startsWith('mcp__') && call.result && !call.result.is_error).length ?? 0,
    protectedUnchanged: outcome?.protectedUnchanged ?? null });
}
const table = ['| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |',
  '|---|---|---|---|---|---|---:|---:|---:|---:|---:|', ...rows.map((r) => `| ${r.name} | ${r.correctness} | ${r.complete} | ${r.captured} | ${r.hook} | ${r.checkpoint} | ${r.input ?? 'missing'} | ${r.output ?? 'missing'} | ${r.turns ?? 'missing'} | ${r.permissionDenials ?? 'missing'} | ${r.successfulMcp} |`)];
const arms = ['plain', 'canary'].map((arm) => {
  const matches = rows.filter((r) => r.name.endsWith(`-${arm}`));
  return { arm, attempted: matches.length, correct: matches.filter((r) => r.correctness === 'pass').length,
    complete: matches.filter((r) => r.complete).length, captured: matches.filter((r) => r.captured).length,
    passedCheckpoints: matches.filter((r) => r.hook && r.checkpoint === 'pass (checkpoint)').length,
    nativeTokens: matches.every((r) => r.input !== null && r.output !== null) ? matches.reduce((sum, r) => sum + r.input + r.output, 0) : null };
});
const text = `# Native Claude: ${summary.preparedRoot ? 'gepaarter lokaler Pilot' : 'Reparaturkontrolle'}\n\n` +
  `Erfasst: ${summary.startedAt} bis ${summary.finishedAt}. Status: **${summary.status}**.\n\n` +
  `Rohbelege: \`${evidence}\`. ${lines.length} Dateien anhand SHA-256 erneut geprüft.\n\n` +
  `CLI: \`${summary.cliVersion}\`, SHA-256 \`${summary.cliSha256}\`. Claude: \`${summary.claudeVersion}\`. Ollama: \`${summary.ollamaVersion.version}\`.\n\n` +
  `Modell: \`${summary.model}\`, Digest \`${summary.modelDigest}\`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: \`${summary.instrumentSha256}\`.\n\n` +
  table.join('\n') + '\n\n' +
  (summary.preparedRoot ? arms.map((a) => `- ${a.arm}: ${a.correct}/${a.attempted} externe Korrektheitsprüfungen bestanden; ${a.complete} normal beendet; ${a.captured} vollständig abgerechnet; ${a.passedCheckpoints} tatsächliche bestandene Stop-Checkpoints; native Tokens ${a.nativeTokens ?? 'unvollständig'}.`).join('\n') + '\n\n' : '') +
  `Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.\n\n` +
  `Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.\n\n` +
  `Bereinigung: \`${JSON.stringify(summary.cleanup)}\`. Fehler: \`${summary.failure ?? 'none'}\`.\n`;
fs.writeFileSync(out, text, { flag: 'wx' });
console.log(`PASS evidence integrity: ${lines.length} files; ${rows.length} sessions; ${out}`);
