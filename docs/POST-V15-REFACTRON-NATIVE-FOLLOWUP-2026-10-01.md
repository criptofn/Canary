# Native Claude: gepaarter lokaler Pilot

## Ergebnis des Refactron-Nachgangs

Beide neuen Lösungen bestehen das externe Oracle für die öffentliche
`extractFailureIds`-Signatur, unterschiedliche parametrische Pytest-IDs und
Stabilität bei wechselnder Fehlerdarstellung. Die frühere Canary-Lösung dieses
Vergleichs hatte die öffentliche API verändert und bestand diese Prüfung nicht.
Je eine neue Beobachtung beweist keine kausale Wirkung der Produktkorrekturen.

Der neue Canary-Agent erreicht weiterhin `error_max_turns` nach 51 gemeldeten
Turns. Er löst **keinen Stop-Hook** aus und verändert den Checkpoint nicht.
Der sichtbare `pass` stammt ausdrücklich aus dem Doctor-Lauf vor der
Agentensitzung: Checkpoint 18:40:13 UTC, Agentenstart 18:47:33 UTC. Er ist kein
Nachweis der neuen Lösung. Der Durchgang ist vollständig erfasst und
abgerechnet, jedoch kein erfolgreicher Agentenabschluss.

Ohne Canary: 17 Turns / 187.656 native Tokens. Mit Canary: 51 Turns / 1.384.157
Tokens. Es gab keine Werkzeugabweisungen, keine erfolgreichen MCP-Aufrufe und
keinen manuellen Eingriff innerhalb der beiden Sitzungen. Konfiguration,
Hooks und Baseline blieben erhalten. Die Abschluss- und Effizienzprobleme sind
damit nicht gelöst; der frühere Gesamtpilot wird nicht rückwirkend aufgewertet.

Das Quellarchiv `claude-final-native-20261001-R1-archive` unter demselben
Evidenzverzeichnis enthält 56 Dateien. Nach erneuter Prüfung aller **280**
Dateien beider Archive wurden die eigenen Refactron-Projektkopien und ihre zwei
Vertrauensverzeichnisse entfernt. Modell und eigener Server sind beendet;
`claude-final-native-20261001-R1-cleanup.log` hält die Bereinigung fest.

Erfasst: 2026-10-01T18:40:40.476Z bis 2026-10-01T18:59:59.701Z. Status: **complete**.

Rohbelege: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-final-native-20261001-R1`. 224 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `ebc01f01844db5240ce3a9d9eb57df5a67a2ee5c18369b3dbc31b1ca81d4e9bf`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| R1-plain | pass | true | true | false | none | 180454 | 7202 | 17 | 0 | 0 |
| R1-canary | pass | false | true | false | pass (historical) | 1354622 | 29535 | 51 | 0 | 0 |

- plain: 1/1 externe Korrektheitsprüfungen bestanden; 1 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 187656.
- canary: 1/1 externe Korrektheitsprüfungen bestanden; 0 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 1384157.

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.

## Separater Vorher-/Nachher-Vergleich

| Sitzung | Native Tokens | Turns | Abweisungen | Versuche setup/bind/accept oder Canary-Konfiguration zu ändern | Stop PASS |
|---|---:|---:|---:|---:|---|
| R1-plain vorher | 187073 | 16 | 0 | 0 | false |
| R1-plain danach | 187656 | 17 | 0 | 0 | false |
| R1-canary vorher | 1432453 | 51 | 0 | 0 | false |
| R1-canary danach | 1384157 | 51 | 0 | 0 | false |

Vorher: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-local-paired-20261001-bounded`, CLI SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Danach: CLI SHA-256 `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`. Gleiches Modell und gleiche Grenzwerte, frische Ausgangskopien. Je eine Beobachtung pro Zelle; keine allgemeine Tokenersparnis oder kausale Effektgröße. Gezählte Befehlsversuche sind lesbare Werkzeugaufrufe, keine Messung einer Sicherheitsgrenze.

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
