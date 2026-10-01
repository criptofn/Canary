# Native Claude: gepaarter lokaler Pilot

## Beobachteter Fortschritt und verbleibender Aufwand

Der neue H3-Agentenlauf endet regulär, seine Lösung besteht das externe Oracle,
und der tatsächliche Stop-Hook liefert `pass`. Im vorherigen H3-Lauf mit der
generischen Anleitung waren Lösung und Messung ebenfalls korrekt, die Sitzung
erreichte jedoch das Turnlimit und Canary blieb `unproven`. Das aktuelle Paket
enthält sowohl den versiegelten Testeinstieg im MCP-Startkontext als auch die
Korrektur importierter Checks. Dieser einzelne Vergleich trennt ihre Wirkung
nicht und erlaubt keine kausale Zuschreibung.

Der Agent ergänzte diesmal `scripts/smoke-test.js`, den bestehenden Testeinstieg,
und exportierte die tatsächlich geprüfte `quantizeSymmetric`-Funktion. Es gab
keinen manuellen Eingriff, keinen Setup-/Bind-/Accept-Versuch und keine
Werkzeugabweisung. Der Hook behielt ausdrücklich die Kennzeichnung
`EXISTING check rewritten by this session`: bestanden mit Herkunftsvorbehalt,
keine unabhängige Autorität. Konfiguration, Hooks und Baseline blieben erhalten.

Die Tests des Agenten sind nur teilweise aussagekräftig: Seine Variable
`errorType` wird zwischen drei Fehlerfällen nicht zurückgesetzt. Spätere Fälle
könnten deshalb trotz ausbleibendem Fehler bestehen. Das unabhängige Oracle
prüft alle vereinbarten ungültigen Bitbreiten jeweils mit `assert.throws` und
bestätigt die Implementierung. Canary bestätigt unterscheidende Evidenz für die
Änderung; daraus folgt keine Vollständigkeit aller Agentenassertions.

Der Lauf mit Canary benötigte **28 Turns / 686.305 native Tokens**, der Lauf ohne
Canary **vier Turns / 30.262 Tokens** (22,68-fach in diesem Paar). Die Laufzeiten
der Agentensitzungen betragen rund 175 bzw. 46 Sekunden. Der Canary-Agent
verwendete zunächst einen erfundenen Projektpfad, erzeugte beim Exportieren
vorübergehend doppelte Funktionen und reparierte die entstandenen Syntaxfehler.
Ein `canary status`-Shellaufruf fand kein globales CLI; die installierten Hooks
funktionierten anschließend. Diese Werkzeugfehler sind in den Rohereignissen
erhalten und sind keine Canary-Blockaden. Kein erfolgreicher MCP-Werkzeugaufruf
wurde beobachtet. Eine allgemeine Ersparnis oder eine Produktbewertung von
8–9/10 ist damit weiterhin nicht nachgewiesen.

Das zusätzliche Quellarchiv
`C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-final-native-20261001-H3-archive`
enthält 38 Dateien einschließlich Einrichtungslogs, Konfiguration, vollständiger
Änderung seit dem Ausgangscommit und Git-Historie. Die Zahlen unten stammen aus
dem erneut ausgeführten Reporter, nicht aus Schätzungen.

Nach erneuter Prüfung aller **183** Dateien beider Archive wurden ausschließlich
die frischen H3-Projektkopien und ihre zwei eigenen Vertrauensverzeichnisse
entfernt. Das lokale Modell wurde entladen und der eigene Server beendet.
`tooling/probes/v15-native-pilot-cleanup.mjs` verlangt vollständige native
Erfassung, übereinstimmende Ausgangsmanifeste, geprüfte Archivhashes und kanonische
Zielpfade vor der ersten Löschung. Ein Kontrollaufruf mit dem Arbeitsrepository
als Quelle wurde vor Änderungen abgewiesen. Die Protokolle
`claude-final-native-20261001-H3-cleanup.log` und
`claude-final-native-20261001-H3-cleanup-rejected.log` liegen neben den Archiven.

Erfasst: 2026-10-01T05:30:57.331Z bis 2026-10-01T05:34:57.999Z. Status: **complete**.

Rohbelege: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-final-native-20261001-H3`. 145 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `ebc01f01844db5240ce3a9d9eb57df5a67a2ee5c18369b3dbc31b1ca81d4e9bf`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| H3-plain | pass | true | true | false | none | 28728 | 1534 | 4 | 0 | 0 |
| H3-canary | pass | true | true | true | pass (checkpoint) | 676209 | 10096 | 28 | 0 | 0 |

- plain: 1/1 externe Korrektheitsprüfungen bestanden; 1 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 30262.
- canary: 1/1 externe Korrektheitsprüfungen bestanden; 1 normal beendet; 1 vollständig abgerechnet; 1 tatsächliche bestandene Stop-Checkpoints; native Tokens 686305.

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.

## Separater Vorher-/Nachher-Vergleich

| Sitzung | Native Tokens | Turns | Abweisungen | Versuche setup/bind/accept oder Canary-Konfiguration zu ändern | Stop PASS |
|---|---:|---:|---:|---:|---|
| H3-plain vorher | 1328427 | 51 | 0 | 0 | false |
| H3-plain danach | 30262 | 4 | 0 | 0 | false |
| H3-canary vorher | 1673305 | 51 | 1 | 1 | false |
| H3-canary danach | 686305 | 28 | 0 | 0 | true |

Vorher: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-guidance-20261001-H3`, CLI SHA-256 `38a8fec6c53e15c4c693feeb37a4284f84cb8a49168417cc4d1f87888eec6a09`. Danach: CLI SHA-256 `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`. Gleiches Modell und gleiche Grenzwerte, frische Ausgangskopien. Je eine Beobachtung pro Zelle; keine allgemeine Tokenersparnis oder kausale Effektgröße. Gezählte Befehlsversuche sind lesbare Werkzeugaufrufe, keine Messung einer Sicherheitsgrenze.

## Vollständige Prüfung des eingefrorenen Pakets

Unit: **1325 bestanden, 4 übersprungen, 0 Fehler**, 1329 insgesamt.

VERIFY-PRODUCTIZATION: PASS WITH EXPLICIT SKIPS (104 PASS, 6 SKIP — no skipped probe counts as a pass; 4 host-bound; 2 live cost-gated and NOT RUN; 2 host-bound SKIP step(s) executed zero checks)

- SKIP  v1.3 posttool feedback (DIAGNOSTIC live-integration; deterministic properties gate)  — cost-gated: live Claude sessions were not run; provider-level spend cannot be reliably capped
- SKIP  probe: real Go project end-to-end (setup -> doctor)  — host-bound: 0 check(s) EXECUTED, 1 explicit SKIP(s) — SKIP never counts as PASS; nothing here was accepted by execution
- SKIP  probe: real Rust project end-to-end (setup -> doctor)  — host-bound: 0 check(s) EXECUTED, 1 explicit SKIP(s) — SKIP never counts as PASS; nothing here was accepted by execution
- SKIP  probe: pre-1.0 human-acceptance battery (real git + pty)  — host-bound: 9 check(s) EXECUTED, 1 explicit SKIP(s) — SKIP never counts as PASS
- SKIP  probe: acceptance growth (real git + pty)  — host-bound: 10 check(s) EXECUTED, 1 explicit SKIP(s) — SKIP never counts as PASS
- SKIP  benchmark: agent-driven token ledger (stream-json parsed for phase cost + visible bytes)  — cost-gated: live Claude session was not run; provider-level spend cannot be reliably capped

Übersprungene Tests oder Suites, aus dem ausgeführten Reporter (eine Suite mit null Tests erhöht nicht die Zahl übersprungener Tests):

- ﹣ the universal contract — a real unknown tool, sealed and executed (0.062ms) # no workspace-local Go toolchain to build the fixture unknown tool
- ﹣ resolvePsBinary never returns a PATH-found binary; the sweep env has no caller PATH (0.5283ms) # POSIX liar harness
- ﹣ the SPAWN SITE itself never inherits caller env — leak canary (wiring, not just the helper) (0.073ms) # win32: no sh harness; win32 sites pinned by native env shape + trusted resolution
- ﹣ a forged binary given EXPLICITLY is parsed as inert data, never trusted as a source (0.0769ms) # POSIX sh harness
- ﹣ psTableRows(binary that exits nonzero) → null (0.0714ms) # POSIX sh harness

Übersprungene Prüfungen sind keine bestandenen Prüfungen.

- `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\imported-check-final-20261001\unit.log`: SHA-256 `e33a76137fae34bb0c1aaeb4e307ffb6755268cf47a38f1dc10f98a031b875f8`
- `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\imported-check-final-20261001\productization.log`: SHA-256 `97e9d906bfc043ad8b1de348d519475b76d7da706e1d30a9658fe8793f133dc2`
- `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\imported-check-final-20261001\final.tgz`: SHA-256 `806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975`
- `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\imported-check-final-20261001\installed\node_modules\@canary-rn\cli\dist\main.js`: SHA-256 `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`
