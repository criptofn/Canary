# Native Claude: gepaarter lokaler Pilot

Erfasst: 2026-10-01T00:22:22.530Z bis 2026-10-01T00:55:37.305Z. Status: **incomplete**.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-paired-20261001-bounded`. 935 Dateien anhand SHA-256 erneut geprüft.

CLI: `canary 1.5.0`, SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Claude: `2.1.278 (Claude Code)`. Ollama: `0.33.2`.

Modell: `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`; tatsächlicher Kontext pro Sitzung im record.json. Instrument: `f06133fff57993b989ae7026c0f2245a7d34537d293dd14f3ebb4d28607deb16`.

| Sitzung | Korrektheit | Normal beendet | Abrechnung vollständig | Hook | Checkpoint | Input | Output | Turns | Abweisungen | MCP Antworten ohne Werkzeugfehler |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| H1-plain | pass | true | true | false | none | 419095 | 14015 | 27 | 0 | 0 |
| H1-canary | pass | true | true | true | unproven (checkpoint) | 959633 | 20437 | 44 | 0 | 0 |
| H2-canary | pass | true | true | true | pass (checkpoint) | 754257 | 14664 | 37 | 0 | 2 |
| H2-plain | pass | true | true | false | none | 52052 | 4510 | 8 | 0 | 0 |
| H3-plain | pass | true | true | false | none | 325475 | 8456 | 22 | 0 | 0 |
| H3-canary | pass | true | true | true | pass (checkpoint) | 1166053 | 12409 | 51 | 11 | 1 |
| H5-canary | pass | true | true | true | pass (checkpoint) | 201529 | 3569 | 17 | 0 | 0 |
| H5-plain | pass | true | true | false | none | 29399 | 1936 | 4 | 0 | 0 |
| R1-plain | pass | true | true | false | none | 180980 | 6093 | 16 | 0 | 0 |
| R1-canary | fail | false | false | false | pass (historical) | 1412037 | 20416 | 51 | 0 | 0 |

- plain: 5/5 externe Korrektheitsprüfungen bestanden; 5 normal beendet; 5 vollständig abgerechnet; 0 tatsächliche bestandene Stop-Checkpoints; native Tokens 1042011.
- canary: 4/5 externe Korrektheitsprüfungen bestanden; 4 normal beendet; 4 vollständig abgerechnet; 3 tatsächliche bestandene Stop-Checkpoints; native Tokens 4565004.

Anbieterrechnung: **0 USD**, ausschließlich lokales Modell. Claude-interne USD-Schätzung mit unbekannter Preisbasis ist keine Rechnung. Native Input/Output umfassen den tatsächlich übertragenen Werkzeug- und MCP-Kontext; geschätzte thinking_tokens werden nicht addiert.

Grenzen: gleicher Benutzer im LOCAL-Modus; keine Betriebssystem-Isolation. Kontrollreparaturen sind künstlich eingebracht. Ein kleiner Pilot auf drei Projekten beweist keine allgemeine Tokenersparnis oder breite 9/10-Alltagstauglichkeit. Korrektheit, Canary-Nachweis und Sitzungsende sind getrennt.

Bereinigung: `{"unloaded":true,"ps":{"models":[]},"serverStopped":true}`. Fehler: `AssertionError [ERR_ASSERTION]: R1-canary: incomplete native capture; retained and stopped
    at pilot (file:///C:/Users/Johannes/Desktop/canary/_canary-data/worktrees/canary-product-progress/tooling/probes/v15-claude-local-preflight.mjs:199:12)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async file:///C:/Users/Johannes/Desktop/canary/_canary-data/worktrees/canary-product-progress/tooling/probes/v15-claude-local-preflight.mjs:261:22`.
