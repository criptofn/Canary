#!/usr/bin/env node
/** Compare archived no-model controls; reject incomplete or altered evidence. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [beforeRoot, afterRoot, out, baselinePackageSha] = process.argv.slice(2);
if (baselinePackageSha) assert.match(baselinePackageSha, /^[a-f0-9]{64}$/);
const beforeLabel = baselinePackageSha ? 'Vor Plan' : 'Release';
assert.ok([beforeRoot, afterRoot, out].every((value) => value && path.isAbsolute(value)));
assert.ok(!fs.existsSync(out));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const labels = ['H1', 'H2', 'H3', 'H5', 'R1', 'S1'];
function load(root) {
  const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const manifest = json('export-manifest.json');
  assert.equal(manifest.captureStatus, 'complete');
  for (const file of manifest.files) {
    const target = path.join(root, file.path), relative = path.relative(root, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(hash(fs.readFileSync(target)), file.sha256, `altered archive: ${file.path}`);
  }
  const summary = json('summary.json'), preparation = json('prepared/preparation-summary.json');
  assert.equal(summary.status, 'complete'); assert.equal(summary.failure, null);
  assert.equal(summary.rows.length, 12); assert.equal(preparation.records.length, 12);
  assert.deepEqual(preparation.tasks, labels); assert.equal(preparation.model, null);
  assert.ok(summary.commands.every((command) => command.exitCode === 0 && !command.error));
  for (const label of labels) {
    for (const role of ['positive', 'negative']) {
      const row = summary.rows.find((item) => item.label === label && item.role === role);
      assert.ok(row?.passed); assert.equal(row.checkpoint.source, 'checkpoint');
      assert.equal(row.checkpoint.status, role === 'positive' ? 'pass' : 'fail');
      assert.equal(row.hookBlocked, role === 'negative');
    }
  }
  for (const role of ['baseline', 'positive', 'negative']) {
    assert.ok(summary.commands.find((command) => command.name === `H1-${role}-oracle`).args.includes('--strict-age'));
  }
  for (const record of preparation.records) {
    assert.equal(record.status, 'complete'); assert.equal(record.source.clean, true);
    assert.deepEqual(record.source.visibleHistory, [record.source.baseCommit]);
    assert.deepEqual(record.source.remotes, []); assert.equal(record.source.shallow, true);
    if (record.arm === 'canary') assert.equal(record.canaryVerdict, 'READY');
  }
  assert.equal(hash(fs.readFileSync(summary.cli)), summary.cliSha256);
  assert.equal(hash(fs.readFileSync(summary.package)), summary.packageSha256);
  return { summary, preparation, files: manifest.files.length };
}
const before = load(beforeRoot), after = load(afterRoot);
assert.deepEqual(before.summary.instruments, after.summary.instruments);
assert.deepEqual(before.summary.solutions, after.summary.solutions);
assert.equal(before.preparation.timeoutMs, after.preparation.timeoutMs);
for (const record of before.preparation.records) {
  const current = after.preparation.records.find((item) => item.label === record.label && item.arm === record.arm);
  assert.equal(record.source.baseCommit, current.source.baseCommit);
  assert.deepEqual(record.toolchainDirectories, current.toolchainDirectories);
}
assert.equal(before.summary.packageSha256, baselinePackageSha ?? 'cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386');
const rows = labels.map((label) => {
  const base = before.preparation.records.find((record) => record.label === label).source.baseCommit;
  return `| ${label} | \`${base}\` | pass / fail, Fehler blockiert | pass / fail, Fehler blockiert |`;
});
const text = `# Direkter Vergleich: ${baselinePackageSha ? 'Arbeitsstand vor dem Plan' : 'veröffentlichtes Canary 1.5.0'} und Verbesserungsstand\n\n` +
  'Sechs unabhängige Aufgaben auf Hermes, Refactron und Schniedelsmp, jeweils korrekte historische Lösung und bewusst wiederhergestellte fehlerhafte Implementierung. ' +
  'Beide Pakete bestehen **12/12 Kontrollen** und alle zwölf Einrichtungsprüfungen (sechs regulär, sechs mit Canary).\n\n' +
  `| Aufgabe | Ausgangscommit | ${beforeLabel}: korrekt / alter Fehler | Verbesserung: korrekt / alter Fehler |\n|---|---|---|---|\n` + rows.join('\n') + '\n\n' +
  [before, after].map((run, index) => `- ${index ? 'Verbesserung' : beforeLabel}: Paket SHA-256 \`${run.summary.packageSha256}\`; CLI \`${run.summary.cliSha256}\`; ${run.files} archivierte Dateien erneut bytegenau geprüft. Rohbelege: \`${index ? afterRoot : beforeRoot}\`.`).join('\n') + '\n\n' +
  'Instrumente, historische Lösungspatches, Ausgangscommits, Toolchain-Verzeichnisse und Zeitgrenzen stimmen zwischen den Varianten überein. ' +
  'H1 berücksichtigt zusätzlich eine Stunde alte Dateien und Bruchteile von Tagen; diese Ergänzung gehört zum nachträglichen Kontrollversuch, nicht zum ursprünglichen nativen Pilot. ' +
  'Alle Checkpoints stammen aus tatsächlichen CLI-Aufrufen. Es sind keine nativen Agentensitzungen; Sitzungsende oder Tokenersparnis wird hier nicht gemessen.\n\n' +
  'Dieser Vergleich zeigt, dass die bestehenden sechs Abläufe funktionieren. Der zusätzliche [H3-Nachweis](POST-V15-IMPORTED-CHECK-REPAIR-2026-10-01.md) zeigt die behobene falsche Blockade am Release. ' +
  'Die zwölf ursprünglichen Pilotsitzungen bleiben unverändert; eine höhere Produktbewertung braucht einen neuen Nachweis weniger Eingriffe oder kürzerer autonomer Arbeit.\n';
fs.writeFileSync(out, text, { flag: 'wx' });
console.log(`PASS comparison: 24/24 controls, ${before.files + after.files} verified files; ${out}`);
