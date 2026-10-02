# Native Claude: gepaarter lokaler Pilot

Erfasst: 2026-10-02T05:31:24.526Z bis 2026-10-02T05:59:47.069Z. Status: **complete**.

Rohbelege: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-startup-native-20261002-R1`. 278 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `5df7963c61c4d71cbd5e87726756773bdb845d71471c087b4cad022a0aa5211c`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `ebc01f01844db5240ce3a9d9eb57df5a67a2ee5c18369b3dbc31b1ca81d4e9bf`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| R1-plain | pass | true | true | false | none | 638506 | 18241 | 32 | 0 | 0 |
| R1-canary | fail | false | true | true | fail (checkpoint) | 1649506 | 57685 | 51 | 1 | 0 |

- plain: 1/1 externe Korrektheitsprüfungen bestanden; 1 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 656747.
- canary: 0/1 externe Korrektheitsprüfungen bestanden; 0 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 1707191.

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Dieses einzelne Vergleichspaar beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.

## Separater Vorher-/Nachher-Vergleich

| Sitzung | Native Tokens | Turns | Abweisungen | Versuche setup/bind/accept oder Canary-Konfiguration zu ändern | Stop PASS |
|---|---:|---:|---:|---:|---|
| R1-plain vorher | 187656 | 17 | 0 | 0 | false |
| R1-plain danach | 656747 | 32 | 0 | 0 | false |
| R1-canary vorher | 1384157 | 51 | 0 | 0 | false |
| R1-canary danach | 1707191 | 51 | 1 | 0 | false |

Vorher: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-final-native-20261001-R1`, CLI SHA-256 `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`. Danach: CLI SHA-256 `5df7963c61c4d71cbd5e87726756773bdb845d71471c087b4cad022a0aa5211c`. Gleiches Modell und gleiche Grenzwerte, frische Ausgangskopien. Je eine Beobachtung pro Zelle; keine allgemeine Tokenersparnis oder kausale Effektgröße. Gezählte Befehlsversuche sind lesbare Werkzeugaufrufe, keine Messung einer Sicherheitsgrenze.
