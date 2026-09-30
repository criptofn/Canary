# Native Claude: Reparaturkontrolle

Erfasst: 2026-09-30T23:48:17.887Z bis 2026-09-30T23:49:29.196Z. Status: **complete**.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-tools-20261001-authorized`. 118 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `83e5d994c071269509b029820cb1f0b332758f112c11c436e7a463f723408ebf`.

| Sitzung | Korrektheit | Vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP erfolgreich |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| connection | control | true | false | none | 227 | 619 | 1 | 0 | 0 |
| hook-positive | control | true | true | pass | 1543 | 53 | 1 | 0 | 0 |
| hook-negative | control | true | true | fail | 3437 | 133 | 2 | 0 | 0 |
| tools-repair | control | true | true | pass | 39762 | 994 | 8 | 0 | 2 |

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `none`.
