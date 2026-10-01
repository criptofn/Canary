# Native Claude: Reparaturkontrolle

Erfasst: 2026-10-01T02:12:44.216Z bis 2026-10-01T02:15:53.258Z. Status: **complete**.

Rohbelege: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-entry-context-20261001-native-controls`. 202 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `05cb4d9d83742258ac9a78d3c3b2453632ced2f157427e14dfdac9b64da9e930`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `ebc01f01844db5240ce3a9d9eb57df5a67a2ee5c18369b3dbc31b1ca81d4e9bf`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| connection | control | true | true | false | none | 227 | 1335 | 1 | 0 | 0 |
| hook-positive | control | true | true | true | pass (checkpoint) | 1543 | 63 | 1 | 0 | 0 |
| hook-negative | control | true | true | true | fail (checkpoint) | 3428 | 1508 | 2 | 0 | 0 |
| tools-repair | control | true | true | true | pass (checkpoint) | 49738 | 1061 | 8 | 0 | 2 |
| turn-limit-control | control | false | true | false | pass (historical) | 5407 | 144 | 2 | 0 | 0 |
| setup-denial-control | control | true | true | true | pass (checkpoint) | 23522 | 886 | 4 | 2 | 0 |

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.
