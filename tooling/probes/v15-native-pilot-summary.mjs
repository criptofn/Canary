#!/usr/bin/env node
/** Combine the preserved ten-session run, untouched S1 follow-up and explicit H1 post-check. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseAnthropicUsage, claudeUsageMatchesNative } from './v15-anthropic-usage.mjs';

const arg = (key) => { const index = process.argv.indexOf(`--${key}`); return index < 0 ? null : process.argv[index + 1]; };
const paths = Object.fromEntries(['main', 's1', 'postchecks', 'out'].map((key) => [key, arg(key)]));
for (const [key, value] of Object.entries(paths)) assert.ok(value && path.isAbsolute(value), `absolute --${key} required`);
assert.ok(!fs.existsSync(paths.out), 'new report path required');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
let verified = 0;
for (const root of [paths.main, paths.s1, paths.postchecks]) {
  for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [, digest, file] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
    assert.ok(digest && file);
    assert.equal(hash(fs.readFileSync(path.join(root, file))), digest, file);
    verified++;
  }
}
const main = read(paths.main, 'summary.json'), s1 = read(paths.s1, 'summary.json');
for (const key of ['cliSha256', 'modelDigest', 'contextLength', 'maxOutputTokens', 'maxTurns']) assert.equal(main[key], s1[key]);
const rows = [];
for (const [root, summary] of [[paths.main, main], [paths.s1, s1]]) {
  for (const session of summary.sessions) {
    const usage = { input_tokens: 0, output_tokens: 0 };
    for (const number of session.calls) {
      const call = summary.requests.find((entry) => entry.number === number);
      assert.equal(call.httpStatus, 200);
      const parsed = parseAnthropicUsage(fs.readFileSync(path.join(root, `api-${number}.response.txt`), 'utf8'));
      assert.equal(parsed.complete, true);
      for (const key of Object.keys(usage)) usage[key] += parsed.usage[key];
    }
    assert.deepEqual(session.nativeUsage, usage);
    assert.equal(claudeUsageMatchesNative(session.terminal, usage, summary.model), true);
    const outcome = read(root, `${session.name}-outcome.json`);
    assert.equal(outcome.protectedUnchanged, true); assert.equal(outcome.baselinePreserved, true);
    const strict = outcome.label === 'H1' ? read(paths.postchecks, `${session.name}-strict/oracle-result.json`) : null;
    rows.push({ name: session.name, arm: outcome.arm, originalCorrect: outcome.correctness === 'pass',
      correct: outcome.correctness === 'pass' && (!strict || strict.testPassed),
      complete: session.exitCode === 0 && !session.timedOut && session.terminal.is_error === false,
      passedGate: session.hookFired && session.checkpointChanged && session.checkpoint?.source === 'checkpoint' && session.checkpoint?.status === 'pass',
      input: usage.input_tokens, output: usage.output_tokens });
  }
}
assert.equal(rows.length, 12); assert.equal(new Set(rows.map((row) => row.name)).size, 12);
const totals = ['plain', 'canary'].map((arm) => {
  const selected = rows.filter((row) => row.arm === arm); assert.equal(selected.length, 6);
  return { arm, correct: selected.filter((row) => row.correct).length, normalCompletion: selected.filter((row) => row.complete).length,
    passedGate: selected.filter((row) => row.passedGate).length, tokens: selected.reduce((n, row) => n + row.input + row.output, 0) };
});
const table = ['| Sitzung | Ursprünglich korrekt | Mit H1-Nachprüfung korrekt | Normal beendet | Stop PASS | Input | Output |',
  '|---|---|---|---|---|---:|---:|', ...rows.map((r) => `| ${r.name} | ${r.originalCorrect} | ${r.correct} | ${r.complete} | ${r.passedGate} | ${r.input} | ${r.output} |`)];
fs.writeFileSync(paths.out, `# Canary: Ergebnis der zwölf nativen Sitzungen\n\n${verified} Rohdateien gegen SHA-256 geprüft. Native API-Zähler stimmen in **12/12** Sitzungen mit Claudes vollständigem Modellzähler überein. Anbieterrechnung: **0 USD**, lokales ${main.model}.\n\n` +
  table.join('\n') + '\n\n' + totals.map((t) => `- ${t.arm}: **${t.correct}/6 korrekt**, ${t.normalCompletion}/6 normal beendet, ${t.passedGate}/6 mit bestandenem Stop-Hook; ${t.tokens} native Input- und Outputtokens.`).join('\n') +
  `\n\nCanary/plain: ${(totals[1].tokens / totals[0].tokens).toFixed(2)} × Tokens in diesem Pilot, einschließlich der fehlgeschlagenen Sitzung. Das ist keine allgemeine Kostenprognose.\n\n` +
  `Die H1-Altersfälle wurden nachträglich ergänzt; die ursprüngliche Prüfung bestand in beiden Armen. Canary meldete H1 unproven. R1 mit Canary scheiterte an einer veränderten öffentlichen API und am Schrittlimit; ein früherer doctor-PASS war kein Abschlussbeleg. Der frühere abgebrochene und vom Operator gestoppte Versuch ist separat dokumentiert und zählt nicht zu diesen zwölf Sitzungen.\n\n` +
  `CLI SHA-256: \`${main.cliSha256}\`. Modell-Digest: \`${main.modelDigest}\`. Produkt und Aufgaben blieben gleich; die vollständige Modellabrechnung wurde zwischen den zehn Hauptsitzungen und S1 korrigiert. Instrumenthashes: \`${main.instrumentSha256}\`, \`${s1.instrumentSha256}\`. Ein kontinuierlicher Lauf mit nur einer Instrumentenversion wird nicht behauptet.\n\n` +
  `Rohbelege: \`${paths.main}\`, \`${paths.s1}\`, \`${paths.postchecks}\`. LOCAL bleibt dieselbe Benutzeridentität; experimentelle Werkzeugregeln sind keine Betriebssystem-Isolation.\n\n` +
  `Der Pilot rechtfertigt keine höhere Produktbewertung. Der nächste Produktansatz ist, wiederholte Prüfungen und Versuche zum Neuversiegeln durch eindeutige Agentenhinweise zu reduzieren. Eine Verbesserung muss an neuen, separat ausgewiesenen Sitzungen beobachtet werden.\n`, { flag: 'wx' });
console.log(JSON.stringify({ verified, sessions: rows.length, nativeAccountingComplete: 12, totals, report: paths.out }, null, 2));
