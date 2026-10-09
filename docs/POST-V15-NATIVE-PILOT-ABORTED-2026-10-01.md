# Native Claude: gepaarter lokaler Pilot

## Korrektur zur Interpretation

Dieser Versuch wurde nach zwei gestarteten Sitzungen durch den Operator beendet: Claude nahm 200.000 Kontexttokens an, Ollama verwendete 65.536; der laufende Prompt erreichte 64.034 Tokens. Der Abschluss der Canary-Sitzung fehlt. Ihr ursprüngliches Feld `manualInterventions: 0` ist falsch; es gab einen gezielten Prozessabbruch. Die Rohdateien wurden nicht nachträglich überschrieben.

Zusätzlich änderte der Agent `package.json`, versiegelte die Canary-Konfiguration neu und bearbeitete die Claude-Hooks. Der spätere `doctor`-Status pass ist deshalb kein unveränderter Abschlussnachweis. Die bestandene externe H1-Prüfung zählt in diesem abgebrochenen Versuch **nicht als Canary-Nutzen**.

Das ergänzende Archiv `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-paired-20261001-archive` enthält die 181 Einrichtungs-/Arbeitsdateien, Git-Historie und vollständige Änderungen seit dem ursprünglichen Setup-Commit. Das repariert eine weitere Messlücke: Der erste Sammler verglich gegen den nach Agentencommits aktuellen HEAD und archivierte diese bereits committed Änderungen nicht. Die Originalbelege bleiben erhalten.

Die Tabellenwerte unten geben den ursprünglichen Versuch wieder. Keine Produktaufwertung oder Tokenersparnis wird daraus abgeleitet.

Erfasst: 2026-09-30T23:50:39.480Z bis 2026-10-01T00:04:22.424Z. Status: **incomplete**.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-paired-20261001`. 390 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `83e5d994c071269509b029820cb1f0b332758f112c11c436e7a463f723408ebf`.

| Sitzung | Korrektheit | Vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP erfolgreich |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| H1-plain | fail | true | false | none | 25167 | 2179 | 5 | 0 | 0 |
| H1-canary | pass | false | false | pass (setup) | 4335195 | 40103 | missing | missing | 0 |

- plain: 0/1 externe Korrektheitsprüfungen bestanden; 1 vollständig erfasst; 0 bestandene Checkpoints; native Tokens 27346.
- canary: 1/1 externe Korrektheitsprüfungen bestanden; 0 vollständig erfasst; 0 bestandene Checkpoints; native Tokens 4375298.

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `AssertionError [ERR_ASSERTION]: H1-canary: incomplete native capture; retained and stopped
    at pilot (file:///C:/Users/Johannes/Desktop/canary/_canary-data/worktrees/canary-product-progress/tooling/probes/v15-claude-local-preflight.mjs:193:12)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async file:///C:/Users/Johannes/Desktop/canary/_canary-data/worktrees/canary-product-progress/tooling/probes/v15-claude-local-preflight.mjs:254:22`.
