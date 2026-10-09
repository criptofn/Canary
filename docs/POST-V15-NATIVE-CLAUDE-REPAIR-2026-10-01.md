# Native Claude: Reparaturkontrolle

Erfasst: 2026-09-30T23:37:21.740Z bis 2026-09-30T23:38:54.952Z. Status: **complete**.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-tools-20261001`. 120 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `48f12210012eb0756da73ad4524b05334ca645e1cd4f061f97b1eb3eee9058fa`.

| Sitzung | Korrektheit | Vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP erfolgreich |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| connection | control | true | false | none | 228 | 2042 | 1 | 0 | 0 |
| hook-positive | control | true | true | pass | 1544 | 50 | 1 | 0 | 0 |
| hook-negative | control | true | true | fail | 3434 | 247 | 2 | 0 | 0 |
| tools-repair | control | true | true | pass | 61304 | 1296 | 10 | 3 | 1 |

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.
