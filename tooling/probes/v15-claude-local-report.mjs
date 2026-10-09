#!/usr/bin/env node
/** Verify native evidence bytes and generate a factual report without rating inference. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseAnthropicUsage, claudeUsageMatchesNative } from './v15-anthropic-usage.mjs';

const arg = (key) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? null : process.argv[i + 1]; };
const evidence = arg('evidence'), out = arg('out'), compareEvidence = arg('compare-evidence'), verificationRoot = arg('verification-root');
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
  const reconciled = complete && claudeUsageMatchesNative(record.terminal, usage, summary.model);
  const file = `${record.name}-outcome.json`;
  const outcome = fs.existsSync(path.join(evidence, file)) ? JSON.parse(read(file)) : null;
  rows.push({ name: record.name, correctness: outcome?.correctness ?? 'control',
    complete: record.exitCode === 0 && !record.timedOut && record.terminal?.is_error === false && reconciled,
    captured: reconciled && record.terminal !== null,
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
let comparison = '';
if (compareEvidence) {
  assert.ok(path.isAbsolute(compareEvidence));
  const previous = JSON.parse(fs.readFileSync(path.join(compareEvidence, 'summary.json'), 'utf8'));
  for (const line of fs.readFileSync(path.join(compareEvidence, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [, expected, file] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
    assert.ok(expected && file);
    assert.equal(hash(fs.readFileSync(path.join(compareEvidence, file))), expected, `altered previous evidence: ${file}`);
  }
  for (const key of ['modelDigest', 'contextLength', 'maxOutputTokens', 'maxTurns']) assert.equal(summary[key], previous[key]);
  const attempts = (record) => record.toolCalls.filter((call) =>
    (call.name === 'Bash' && /(?:\bcanary(?:\.cmd|\.exe)?|\bmain\.js)["']?\s+(?:setup|bind|accept)\b/i.test(call.input?.command ?? ''))
    || (['Edit', 'Write'].includes(call.name) && /(?:^|[\\/])(?:\.(?:canary|claude)[\\/]|\.mcp\.json$)/.test(call.input?.file_path ?? ''))).length;
  const compared = [];
  for (const current of summary.sessions) {
    const old = previous.sessions.find((record) => record.name === current.name);
    assert.ok(old, `no earlier session ${current.name}`);
    for (const [label, record] of [['vorher', old], ['danach', current]]) {
      assert.equal(claudeUsageMatchesNative(record.terminal, record.nativeUsage, summary.model), true);
      const passed = record.hookFired && record.checkpointChanged && record.checkpoint?.source === 'checkpoint' && record.checkpoint?.status === 'pass';
      compared.push(`| ${current.name} ${label} | ${record.nativeUsage.input_tokens + record.nativeUsage.output_tokens} | ${record.terminal.num_turns} | ${record.terminal.permission_denials.length} | ${attempts(record)} | ${passed} |`);
    }
  }
  comparison = '\n## Separater Vorher-/Nachher-Vergleich\n\n' +
    '| Sitzung | Native Tokens | Turns | Abweisungen | Versuche setup/bind/accept oder Canary-Konfiguration zu ändern | Stop PASS |\n' +
    '|---|---:|---:|---:|---:|---|\n' + compared.join('\n') + '\n\n' +
    `Vorher: \`${compareEvidence}\`, CLI SHA-256 \`${previous.cliSha256}\`. Danach: CLI SHA-256 \`${summary.cliSha256}\`. ` +
    'Gleiches Modell und gleiche Grenzwerte, frische Ausgangskopien. Je eine Beobachtung pro Zelle; keine allgemeine Tokenersparnis oder kausale Effektgröße. ' +
    'Gezählte Befehlsversuche sind lesbare Werkzeugaufrufe, keine Messung einer Sicherheitsgrenze.\n';
}
let verification = '';
if (verificationRoot) {
  assert.ok(path.isAbsolute(verificationRoot));
  const unitFile = path.join(verificationRoot, 'unit.log'), productFile = path.join(verificationRoot, 'productization.log');
  const unit = fs.readFileSync(unitFile, 'utf8'), product = fs.readFileSync(productFile, 'utf8');
  const counts = Object.fromEntries([...unit.matchAll(/^ℹ\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)].map((match) => [match[1], Number(match[2])]));
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.ok(Number.isSafeInteger(counts[key]), `missing unit count ${key}`);
  assert.equal(counts.fail + counts.cancelled + counts.todo, 0);
  assert.equal(counts.tests, counts.pass + counts.skipped);
  const unitSkipReasons = unit.split('\n').filter((line) => /^\s*﹣\s/.test(line));
  assert.ok(unitSkipReasons.length >= counts.skipped, 'unit skip reasons missing (a skipped zero-test suite adds a line but no test)');
  const terminal = product.trim().split('\n').at(-1);
  assert.match(terminal, /^VERIFY-PRODUCTIZATION: PASS(?: \(| WITH EXPLICIT SKIPS \()/, 'product chain must finish');
  const summaryTable = product.split('=== VERIFY-PRODUCTIZATION SUMMARY ===').at(-1);
  assert.ok(summaryTable && summaryTable !== product);
  assert.doesNotMatch(summaryTable, /^(?:FAIL|INCOMPLETE|NOT RUN)\s/m);
  const skipReasons = summaryTable.split('\n').filter((line) => line.startsWith('SKIP  '));
  const files = [unitFile, productFile, path.join(verificationRoot, 'final.tgz'), summary.cli];
  assert.equal(hash(fs.readFileSync(summary.cli)), summary.cliSha256);
  verification = '\n## Vollständige Prüfung des eingefrorenen Pakets\n\n' +
    `Unit: **${counts.pass} bestanden, ${counts.skipped} übersprungen, ${counts.fail} Fehler**, ${counts.tests} insgesamt.\n\n` +
    `${terminal}\n\n` + skipReasons.map((line) => `- ${line.trim()}`).join('\n') + '\n\n' +
    'Übersprungene Tests oder Suites, aus dem ausgeführten Reporter (eine Suite mit null Tests erhöht nicht die Zahl übersprungener Tests):\n\n' + unitSkipReasons.map((line) => `- ${line.trim()}`).join('\n') +
    '\n\nÜbersprungene Prüfungen sind keine bestandenen Prüfungen.\n\n' +
    files.map((file) => `- \`${file}\`: SHA-256 \`${hash(fs.readFileSync(file))}\``).join('\n') + '\n';
}
const text = `# Native Claude: ${summary.preparedRoot ? 'gepaarter lokaler Pilot' : 'Reparaturkontrolle'}\n\n` +
  `Erfasst: ${summary.startedAt} bis ${summary.finishedAt}. Status: **${summary.status}**.\n\n` +
  `Rohbelege: \`${evidence}\`. ${lines.length} Dateien anhand SHA-256 erneut geprüft.\n\n` +
  `CLI: \`${summary.cliVersion}\`, SHA-256 \`${summary.cliSha256}\`. Claude: \`${summary.claudeVersion}\`. Ollama: \`${summary.ollamaVersion.version}\`.\n\n` +
  `Modell: \`${summary.model}\`, Digest \`${summary.modelDigest}\`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: \`${summary.instrumentSha256}\`.\n\n` +
  table.join('\n') + '\n\n' +
  (summary.preparedRoot ? arms.map((a) => `- ${a.arm}: ${a.correct}/${a.attempted} externe Korrektheitsprüfungen bestanden; ${a.complete} normal beendet; ${a.captured} vollständig abgerechnet; ${a.passedCheckpoints} tatsächliche bestandene Stop-Checkpoints; native Tokens ${a.nativeTokens ?? 'unvollständig'}.`).join('\n') + '\n\n' : '') +
  `Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.\n\n` +
  `Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Dieser begrenzte Pilot beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.\n\n` +
  `Bereinigung: \`${JSON.stringify(summary.cleanup)}\`. Fehler: \`${summary.failure ?? 'none'}\`.\n` + comparison + verification;
fs.writeFileSync(out, text, { flag: 'wx' });
console.log(`PASS evidence integrity: ${lines.length} files; ${rows.length} sessions; ${out}`);
