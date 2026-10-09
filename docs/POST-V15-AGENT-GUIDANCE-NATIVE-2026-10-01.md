# Native Claude: gepaarter lokaler Pilot

Erfasst: 2026-10-01T01:47:28.830Z bis 2026-10-01T01:59:06.259Z. Status: **complete**.

Rohbelege: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-guidance-20261001-H3`. 282 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `38a8fec6c53e15c4c693feeb37a4284f84cb8a49168417cc4d1f87888eec6a09`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `ebc01f01844db5240ce3a9d9eb57df5a67a2ee5c18369b3dbc31b1ca81d4e9bf`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| H3-plain | pass | false | true | false | none | 1306035 | 22392 | 51 | 0 | 0 |
| H3-canary | pass | false | true | true | unproven (checkpoint) | 1658335 | 14970 | 51 | 1 | 0 |

- plain: 1/1 externe Korrektheitsprüfungen bestanden; 0 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 1328427.
- canary: 1/1 externe Korrektheitsprüfungen bestanden; 0 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 1673305.

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.

## Separater Vorher-/Nachher-Vergleich

| Sitzung | Native Tokens | Turns | Abweisungen | Versuche setup/bind/accept oder Canary-Konfiguration zu ändern | Stop PASS |
|---|---:|---:|---:|---:|---|
| H3-plain vorher | 333931 | 22 | 0 | 0 | false |
| H3-plain danach | 1328427 | 51 | 0 | 0 | false |
| H3-canary vorher | 1178462 | 51 | 11 | 10 | true |
| H3-canary danach | 1673305 | 51 | 1 | 1 | false |

Vorher: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-local-paired-20261001-bounded`, CLI SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Danach: CLI SHA-256 `38a8fec6c53e15c4c693feeb37a4284f84cb8a49168417cc4d1f87888eec6a09`. Gleiches Modell und gleiche Grenzwerte, frische Ausgangskopien. Je eine Beobachtung pro Zelle; keine allgemeine Tokenersparnis oder kausale Effektgröße. Gezählte Befehlsversuche sind lesbare Werkzeugaufrufe, keine Messung einer Sicherheitsgrenze.
