# Native Claude: Reparaturkontrolle

Erfasst: 2026-10-01T00:09:44.491Z bis 2026-10-01T00:12:12.450Z. Status: **complete**.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-controls-20261001-bounded`. 230 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `f06133fff57993b989ae7026c0f2245a7d34537d293dd14f3ebb4d28607deb16`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| connection | control | true | true | false | none | 226 | 965 | 1 | 0 | 0 |
| hook-positive | control | true | true | true | pass (checkpoint) | 1542 | 46 | 1 | 0 | 0 |
| hook-negative | control | true | true | true | fail (checkpoint) | 3423 | 336 | 2 | 0 | 0 |
| tools-repair | control | true | true | true | pass (checkpoint) | 41316 | 1074 | 8 | 0 | 2 |
| turn-limit-control | control | false | true | false | pass (historical) | 5235 | 91 | 2 | 0 | 0 |
| setup-denial-control | control | true | true | true | pass (checkpoint) | 164080 | 2609 | 19 | 8 | 0 |

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.
