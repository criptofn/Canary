# Native Claude: Reparaturkontrolle

Erfasst: 2026-09-30T23:43:06.211Z bis 2026-09-30T23:45:59.126Z. Status: **complete**.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-tools-20261001-freeze-final`. 166 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `1a42710c176e93b1b0afe23bb2981374c0262360bd70fd4f9acf7f885a199086`.

| Sitzung | Korrektheit | Vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP erfolgreich |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| connection | control | true | false | none | 226 | 2064 | 1 | 0 | 0 |
| hook-positive | control | true | true | pass | 1542 | 38 | 1 | 0 | 0 |
| hook-negative | control | true | true | fail | 3426 | 324 | 2 | 0 | 0 |
| tools-repair | control | true | true | pass | 289640 | 6329 | 34 | 11 | 2 |

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.
