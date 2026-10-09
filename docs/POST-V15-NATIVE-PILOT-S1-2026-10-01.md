# Native Claude: gepaarter lokaler Pilot

Erfasst: 2026-10-01T01:22:42.225Z bis 2026-10-01T01:27:27.047Z. Status: **complete**.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-paired-20261001-S1`. 191 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `40b62be730fd6188f7ed487be741abd6b975b940186ed077de8dd8711aa9bec7`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| S1-canary | pass | true | true | true | pass (checkpoint) | 326745 | 8036 | 31 | 0 | 0 |
| S1-plain | pass | true | true | false | none | 192402 | 6302 | 21 | 0 | 0 |

- plain: 1/1 externe Korrektheitsprüfungen bestanden; 1 normal beendet; 1 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 198704.
- canary: 1/1 externe Korrektheitsprüfungen bestanden; 1 normal beendet; 1 vollständig abgerechnet; 1 tatsächliche bestandene Stop-Checkpoints; native Tokens 334781.

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.
