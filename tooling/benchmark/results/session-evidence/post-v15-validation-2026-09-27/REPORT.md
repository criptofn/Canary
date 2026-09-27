# Canary 1.5.0: post-release product validation

- **Date:** 2026-09-27
- **Branch:** `codex/post-v15-product-validation`
- **Release tag:** `v1.5.0` (`6471ef6a74dd89ff11a7083fb9c54dca6c2b1334`)
- **Published package SHA-256:** `cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386`
- **Installed CLI:** `canary 1.5.0`, `main.js` SHA-256 `3cfdfece2581b1036e1b01905be39d97161d03f683110cf40910570a5235d5e2`

## Ergebnis

Die veröffentlichte Binärdatei ließ sich in allen sechs vorbereiteten Projektfällen einrichten und prüfen. Canary akzeptierte anschließend alle sechs gezielten Korrekturen, jeweils mit dem ausgewiesenen Hinweis, dass der unterscheidende Test vom ausführenden Agenten stammt. Sechs unabhängige Orakel scheiterten am unveränderten Ausgangsstand und bestanden am jeweiligen korrigierten Stand (12/12 Kontrollen).

Es wurde kein Canary-Produktcode geändert: Die sechs Aufgabenfälle wurden korrigiert, die Canary-Produktprüfungen selbst zeigten dabei keinen bestätigten Fehler. Die Verbesserungen in diesem Branch betreffen Messinstrumente, Kontrollen und Dokumentation.

Der geplante A/B-Pilot mit zwölf echten Agentensitzungen wurde **nicht gestartet**. Das CLI überschritt in zwei separaten Messläufen das konfigurierte Kostenlimit von 0,10 USD; der zweite Lauf meldete außerdem `unrecognized_model`. Damit ist die Kostenbegrenzung und die Modellidentität für einen Pilot mit maximal 30 USD nicht hinreichend verlässlich. Die zwölf kostenfreien Versuchsarme sind vorbereitet und jeweils `READY`; ihre Ergebnisse sind keine Agentensitzungen.

## Sechs unabhängige Projektfälle

Alle sechs Aufgaben begannen aus festgehaltenen Ausgangscommits. Die sechs Canary-Arme erreichten vor der Aufgabe `READY`. Die projektseitigen Ausgangsprüfungen bestanden nach Freigabe der jeweils benötigten Toolchains.

| ID | Projekt | Geprüfte Korrektur | Canary-Ergebnis | Unabhängiges Orakel |
|---|---|---|---|---|
| H1 | Hermes_Agent | `maxAgeDays: 0` bleibt als gültiger Wert erhalten | bestanden, Agententest-Hinweis ausgewiesen | Ausgang fail, Kandidat pass |
| H2 | Hermes_Agent | Rechnungs-Klassifikation | bestanden, Agententest-Hinweis ausgewiesen | Ausgang fail, Kandidat pass |
| H3 | Hermes_Agent | Quantize-Bit-Validierung | bestanden, Agententest-Hinweis ausgewiesen | Ausgang fail, Kandidat pass |
| H5 | Hermes_Agent | Simulationsfälle | bestanden, Agententest-Hinweis ausgewiesen | Ausgang fail, Kandidat pass |
| R1 | Refactron | Kollision parametrisierter pytest-IDs | bestanden, Agententest-Hinweis ausgewiesen | Ausgang fail, Kandidat pass |
| S1 | schniedelsmp | Mehrdeutige ID-Präfixe | bestanden, Agententest-Hinweis ausgewiesen | Ausgang fail, Kandidat pass |

Canary meldete für jede Kandidatenprüfung `passed_with_worker_authored_evidence_caveat`. Das ist keine unabhängige Bestätigung der neuen Tests. Die unabhängigen Orakel lieferten diese Trennung; sie sind nicht Bestandteil des Agentennachweises und wurden nicht offengelegt.

Ein separat eingebauter False-Done-Kontrollfall wurde blockiert, als die korrekte Änderung zurückgenommen wurde, obwohl der Agententest bestehen blieb; nach Wiederherstellung der Korrektur wurde nicht mehr blockiert. Dieser Fall ist ein künstlicher Kontrollversuch und zählt nicht als natürlich beobachteter Agentennutzen.

## Produkt- und Sicherheitstests

- `npm test`: **1.267 bestanden, 0 fehlgeschlagen, 4 übersprungen**. Der Lauf im Productization-Gate bestand die Suite ebenfalls.
- `npm run verify:productization`: **103 PASS, 4 hostbedingte SKIP, 2 FAIL**. Die beiden Fehler sind die unten aufgeführten Modell- und Budgetmessungen; kein bestätigter Canary-Produktcodefehler.
- Regressionsevidence-Gate, M2–M10, Broker-/Provider-Routing, Beispiele, Paket-Clean-Room und pytest-Observer bestanden.
- Architekturabschluss: **39/39** Kontrollen bestanden; die Architektur-Mutationsmatrix bestand. Die Master-Pass-Mutationsbatterie fing **alle 13** Mutationen ab.
- Go und Rust konnten mangels Toolchains nicht end-to-end ausgeführt werden. Zwei Akzeptanzprüfungen führten ihre verfügbaren Assertions aus, mussten aber die echte interaktive PTY-Kontrolle auf diesem Windows-Host überspringen.
- `LOCAL` bleibt eine Grenze derselben Benutzeridentität: Ein Agent mit denselben Rechten kann lokal neu versiegeln. Das wurde als Grenze dokumentiert, nicht durch einen neuen privilegierten Dienst erweitert.

### Windows-Prozessüberwachung

Die vorhandene Windows-Sweep-Prüfung wurde unter Leerlauf und Last 18-mal ausgeführt. 17 Läufe bestanden; Lauf 9 unter Last endete mit Exit 1. In der Momentaufnahme danach waren Eltern- und Kindprozess verschwunden, aber der Lauf belegte nicht, wer den Elternprozess beendet hatte. Zwölf zusätzliche direkte `sweepDescendants`-Versuche meldeten jeweils Eltern- und Kindprozess als beendet; danach gab es keine Überlebenden. **Der ursprüngliche Befund bleibt offen**: Die Zusatzversuche erklären den fehlgeschlagenen Lauf unter Last nicht.

### Aufwand im Alltag

Der frische v1.5-MCP-Lauf maß 5.726 Byte beworbenen Kontext pro Turn. Davon entfallen 1.923 Byte auf die immer sichtbaren Expertenwerkzeuge. Die bestehende Prüfung führt als offene Befunde auf, dass diese Werkzeuge in der untersuchten getriebenen Form 177,8 % der Plain-Variante kosteten und dass der Nutzen der zusätzlichen `canary_doctor`-Empfehlung noch nicht gemessen ist. Die historische 92,7%-Zahl schloss die MCP-Konfiguration aus und ist kein aktueller Gesamtvergleich.

## Budget- und Modellprüfung

Zwei instrumentierte Diagnoseaufrufe erhielten jeweils `--max-budget-usd 0.10`:

| Probe | Konfiguriertes Limit | Provider-native Kosten | Ergebnis |
|---|---:|---:|---|
| v1.3 PostTool-Feedback | $0.10 | $0.102746 | `error_max_budget_usd`; Marker wurde nicht zugestellt |
| Agent-Token-Ledger | $0.10 | $0.112349 | `error_max_budget_usd` und `unrecognized_model`; Messung unbrauchbar |

Zusammen meldeten diese beiden begrenzten Diagnosen $0.215095. Zwei vorangegangene Diagnoseläufe fanden noch ohne Limit- und Providerkosten-Protokoll statt: 28.065 beziehungsweise 35.335 Tokens, native Kosten unbekannt. Der Gesamtaufwand dieser Produktisierungsdiagnostik lässt sich deshalb nicht exakt rekonstruieren. Diese Läufe waren keine der zwölf vorgesehenen Pilot-Sitzungen.

Die Rohlogs liegen bei [`unit-tests.log`](unit-tests.log), [`verify-productization.log`](verify-productization.log) und [`verify-productization-initial.log`](verify-productization-initial.log). Die Vorbereitungsdaten stehen in [`pilot-preparation-summary.json`](pilot-preparation-summary.json), die unabhängigen Orakel in [`oracle-controls-final5/controls-summary.json`](oracle-controls-final5/controls-summary.json) und die Prozessdiagnostik in [`windows-sweep/summary.json`](windows-sweep/summary.json) sowie [`windows-sweep-trace/summary.json`](windows-sweep-trace/summary.json). Die Prüfsummen sind in [`cost-control-observations.json`](cost-control-observations.json) festgehalten. Die ursprünglichen Projektkopien und Orakel-Quellarchive liegen außerhalb des Repositories unter den im Log ausgewiesenen Temp-Pfaden; die Orakelzusammenfassung enthält ihre Archiv-Hashes.

## Bewertung

- **Technik: 8/10, unverändert.** Die Release-Binärdatei ist nachvollziehbar gebunden; Kandidaten, Provenienz und Abschlussverhalten bestehen breite Vertrags-, Angriffs- und Mutationstests. Offen bleiben der nicht erklärte Windows-Lauf unter Last und die bekannte LOCAL-Grenze.
- **Produkt: 6/10, unverändert.** Die gezielten Korrekturen funktionieren, aber der reale Zusatznutzen für Agenten wurde mangels sicherer Kostenobergrenze nicht gemessen. Gemessener MCP-Kontext und die nicht zugestellte PostTool-Feedback-Nachricht sprechen gegen eine Aufwertung ohne Pilotdaten.

## Nächste Schritte

1. Eine verlässliche Kostenobergrenze auf Provider- oder Abrechnungsebene einrichten und testen; außerdem eine aufgelöste, gültige Modellkennung für Claude Code festhalten.
2. Den vorbereiteten Pilot mit denselben zwölf Sitzungen und dem nativen Kostenledger erneut starten, sobald beide Bedingungen belastbar erfüllt sind.
3. Den Windows-Lauf unter Last gezielt reproduzieren und anhand Prozessende, Zeitgrenzen und Belastung aufklären.
4. Auf Basis der A/B-Ergebnisse entscheiden, ob die standardmäßig sichtbaren Expertenwerkzeuge oder die Doctor-Empfehlung geändert werden.

Die Arbeit in diesem Branch ist als überprüfbarer Stand gedacht. Merge und Veröffentlichung bleiben separat.
