#!/usr/bin/env node
/** Recompute repair medians and verify every archived byte before reporting. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [hermesRoot, refactronRoot, setupRoot, out] = process.argv.slice(2);
assert.ok([hermesRoot, refactronRoot, setupRoot, out].every((value) => value && path.isAbsolute(value)));
assert.ok(!fs.existsSync(out));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
let verifiedFiles = 0;
function load(root) {
  for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line.trim()); assert.ok(match);
    const target = path.join(root, match[2]), relative = path.relative(root, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(hash(fs.readFileSync(target)), match[1], target); verifiedFiles++;
  }
  return JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8'));
}
const hermes = load(hermesRoot), refactron = load(refactronRoot), setup = load(setupRoot);
assert.equal(hermes.status, 'incomplete'); assert.match(hermes.failure, /Refactron-after-broken/);
assert.equal(refactron.status, 'complete'); assert.equal(refactron.failure, null);
assert.equal(setup.status, 'complete'); assert.equal(setup.failure, null);
for (const key of ['beforeCliSha256', 'afterCliSha256', 'beforePackageSha256', 'afterPackageSha256', 'repeats', 'warmupsPerArm', 'node', 'platform']) assert.equal(hermes[key], refactron[key]);
assert.equal(hermes.repeats, 5); assert.equal(hermes.warmupsPerArm, 1);
for (const [arm, index] of [['before', 0], ['after', 1]]) {
  assert.equal(hermes[`${arm}PackageSha256`], setup.arms[index].packageSha256);
  assert.equal(hermes[`${arm}CliSha256`], setup.arms[index].cliSha256);
  assert.equal(hash(fs.readFileSync(hermes[`${arm}Cli`])), hermes[`${arm}CliSha256`]);
  assert.equal(hash(fs.readFileSync(hermes[`${arm}Package`])), hermes[`${arm}PackageSha256`]);
}
assert.equal(hermes.beforePackageSha256, '530707e3cb6d293ec0e407a62235ac8aa2b028b10fc780c28b6e82f866d19b89');
assert.equal(hermes.afterPackageSha256, '806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975');
const comparisons = [['Hermes', hermes, 2], ['Refactron', refactron, 3]].map(([project, run, fullCount]) => {
  const median = (arm) => {
    const rows = run.rows.filter((row) => row.project === project && row.arm === arm);
    assert.equal(rows.length, 5); assert.deepEqual(rows.map((row) => row.round), [1, 2, 3, 4, 5]);
    for (const row of rows) {
      assert.equal(row.status, arm === 'before' ? 'READY' : 'PARTIAL');
      assert.equal(row.executedChecks, arm === 'before' ? fullCount : 1);
      assert.ok(row.steps.every((step) => step.ok));
      assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0);
    }
    return rows.map((row) => row.elapsedMs).toSorted((a, b) => a - b)[2];
  };
  for (const arm of ['before', 'after']) assert.ok(run.controls.find((control) => control.name === `${project}-${arm}-broken`).steps.some((step) => !step.ok));
  const partial = run.controls.find((control) => control.name === `${project}-other-failure-partial`);
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.executedChecks, 1); assert.ok(partial.steps.every((step) => step.ok));
  assert.ok(run.controls.find((control) => control.name === `${project}-other-failure-full`).steps.some((step) => !step.ok));
  const final = run.controls.find((control) => control.name === `${project}-final-full`);
  assert.equal(final.status, 'READY'); assert.equal(final.executedChecks, fullCount); assert.ok(final.steps.every((step) => step.ok));
  const beforeMs = median('before'), afterMs = median('after'), reduction = 100 * (1 - afterMs / beforeMs);
  assert.equal(beforeMs, run.comparisons.find((row) => row.project === project).beforeMedianMs);
  assert.equal(afterMs, run.comparisons.find((row) => row.project === project).afterMedianMs);
  assert.ok(afterMs <= beforeMs * 0.75, `${project}: 25% target not met`);
  console.log(`PASS ${project}: ${beforeMs.toFixed(1)} -> ${afterMs.toFixed(1)} ms; ${reduction.toFixed(1)}% less median repair-check time`);
  return { project, beforeMs, afterMs, reduction, fullCount };
});
assert.equal(setup.rows.find((row) => row.arm === 'before' && row.control.startsWith('late')).restored, false);
assert.equal(setup.rows.find((row) => row.arm === 'after' && row.control.startsWith('late')).restored, true);
const text = `# Canary: nachgewiesener Fortschritt des Reparaturplans\n\n` +
  `## Ergebnis\n\nDie geplante Schwelle von mindestens 25 % kürzerer medianer Reparaturprüfzeit ist auf **beiden Projekten erreicht**. Gemessen wurden fünf Wiederholungen je Variante nach einem ausgeschlossenen Aufwärmlauf, mit wechselnder Reihenfolge. Es sind kontrollierte Bedienabläufe ohne Modellaufrufe.\n\n` +
  `| Projekt | Vor Plan: vollständiger Check | Jetzt: gezielter Check | Weniger Zeit | Ausgeführte Checks |\n|---|---:|---:|---:|---|\n` +
  comparisons.map((row) => `| ${row.project} | ${(row.beforeMs / 1000).toFixed(3)} s | ${(row.afterMs / 1000).toFixed(3)} s | ${row.reduction.toFixed(1)} % | ${row.fullCount} → 1 |`).join('\n') +
  `\n\nDie Ersparnis gilt für die **erneute Prüfung einer bekannten Reparatur**, nicht für den gesamten Arbeitsauftrag. Ein vollständiger Check bleibt am Ende erforderlich. Hermes erhielt vor dem Versiegeln in beiden Varianten seinen vorhandenen echten Server-Smoke-Test zusätzlich als e2e; sein Standardplan besitzt sonst nur einen Check. Es wurden keine Wartezeiten oder künstlich langsamen Prüfungen hinzugefügt. Refactron verwendet seinen regulären Plan aus Typecheck, Tests und Build.\n\n` +
  `## Schutz und Einrichtung\n\n- Beide Projekte: eingebauter Fehler abgewiesen, reparierter Check bestanden; anschließend unabhängiger Fehler im anderen Check, grüner Teilcheck PARTIAL, vollständige Prüfung weiterhin rot; nach Reparatur vollständig READY. Der Teilcheck ließ die vollständige Checkpoint-Datei bytegleich.\n- Später Fehler beim Speichern der Autorität: vor dem Plan blieben geänderte Integrationsdateien zurück; jetzt werden Claude-, Codex- und MCP-Dateien bytegenau wiederhergestellt.\n- Zweimaliger Setup-Neuversuch: Benutzereinstellungen und fremde Hooks/MCP-Einträge erhalten; genau ein Canary-Eintrag pro Harness.\n- Ungültige Einstellungen bleiben unangetastet; ein roter Projektcheck behält die Integration und einen roten Checkpoint. Diese Gegenfälle bestanden auch im Ausgangspaket; dafür wird keine neue Verbesserung behauptet.\n- Kein manueller Eingriff während der Läufe. Eingebaute Fehler und Reparaturen wurden ausdrücklich durch das Versuchsprogramm vorgenommen.\n\n` +
  `## Eingefrorene Pakete und Rohbelege\n\nAusgangsstand: Commit 2171535496f4fda3af060c03449e6b1a65b6380f, Paket ${hermes.beforePackageSha256}, CLI ${hermes.beforeCliSha256}. Er wurde isoliert aus dem exakten Commit rekonstruiert; Paket und CLI stimmen mit den früher archivierten Prüfsummen überein.\n\nVerbesserung: Produktquelle dd017c4, Paket ${hermes.afterPackageSha256}, CLI ${hermes.afterCliSha256}. Beide zeigen Version 1.5.0; der Verbesserungsstand ist unveröffentlicht. Kein Rückgriff auf einen Entwicklungsbuild.\n\n` +
  `- Hermes: ${hermesRoot}, Instrument ${hermes.instrumentSha256}. Der übergreifende Erstversuch ist **unvollständig**: sein Refactron-Testfehler lag außerhalb der Typecheck-Eingaben. Nur die abgeschlossenen Hermes-Messungen und Gegenfälle werden verwendet.\n- Refactron: ${refactronRoot}, korrigiertes Instrument ${refactron.instrumentSha256}. Der typisierte Testhelfer liegt im tatsächlich geprüften src/**; der separate Vitest-Test prüft denselben Wert. Nur Refactron wurde wiederholt.\n- Setup: ${setupRoot}, Instrument ${setup.instrumentSha256}.\n\n**${verifiedFiles} Rohbelegdateien** wurden von diesem Reporter erneut per SHA-256 geprüft; Mediane aus den Einzelmessungen neu berechnet. Alle ausgeführten Befehle, Fehlerausgaben und Canary-Verifikationsbündel sind erhalten. Der abgebrochene Versuch wird nicht als insgesamt bestanden dargestellt.\n\n` +
  `## Einordnung\n\nDas ist belegter Produktfortschritt bei Einrichtung und Reparaturschleife. Eine allgemeine Tokenersparnis ist weiterhin nicht nachgewiesen: der [native H3-Vergleich](POST-V15-IMPORTED-CHECK-NATIVE-2026-10-01.md) beendet nun korrekt, kostet aber erheblich mehr Tokens; [Refactron](POST-V15-REFACTRON-NATIVE-FOLLOWUP-2026-10-01.md) liefert eine korrekte Lösung, erreicht jedoch keinen normalen Agentenabschluss. Der bezahlte Pilot ist laut diesem Plan keine Abnahmevoraussetzung.\n`;
fs.writeFileSync(out, text, { flag: 'wx' });
console.log(`PASS repair progress: two 25% thresholds, preserved negative controls, ${verifiedFiles} verified files; ${out}`);
