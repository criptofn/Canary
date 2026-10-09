# Ergebnisbericht zur Canary-Produktarbeit

Dieser Verbesserungsstand ist geprüft und im Draft-PR aktualisiert. Das aktive Ziel einer Produktbewertung von 8/10 bleibt offen; die vorliegenden Messungen belegen diesen Wert noch nicht.

## Produktänderungen

Bei grünen Checks auf beiden Seiten verlinkt Canary die tatsächliche Baseline-Ausgabe. Abgeschlossene Vergleichsbündel nennen den verglichenen Commit, überlagerte Checks und ausgeführte Befehle samt Rohstreams. Sie entscheiden keinen Prüfstatus und gelten nicht als Sitzungsabschluss. Kandidaten schreiben diese Diagnose erst nach den Autoritätskontrollen außerhalb des Kandidaten. Agententest-Herkunft, Statuswerte und JSON-Verträge bleiben erhalten.

Wenn `canary setup` an einem Check scheitert, zeigt die `NEEDS ATTENTION`-Meldung nun auch auf die vollständige gespeicherte Check-Ausgabe. Exitcode 2, fehlgeschlagener Checkpoint und fehlender Sitzungsabschluss bleiben unverändert. Falls die Ausgabe nicht gespeichert werden kann, wird kein ungültiger Pfad angehängt.

Der Produktisierungsgate kann optional die vollständigen Ausgaben und Metadaten jedes Prüfschritts in ein neues absolutes Verzeichnis schreiben. Das verändert keine Prüfergebnisse und macht einen Fehler im Gesamtlauf direkt bis zu Befehl, Laufzeit und Rohfehler nachvollziehbar.

Code: `041cf24`, `612c194f7611284ef3a0ec6e93d45240d3f6fd58` und `5453054e9e154a31148091ceeb917df0a10c26de`. `ba39bd9a6d64fc2e1c0260c994b6139688f05a84` ergänzt ausschließlich die Gate-Diagnose.

## Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Setup-Fehler vor der Änderung | Explizit ausgewähltes vorheriges Paket gab keinen Link zur vollständigen Check-Ausgabe aus |
| Setup-Fehler nach der Änderung | Neue Regression besteht; Ausgabe-Bundle und fehlgeschlagener Checkpoint werden beide geprüft |
| Installierte Paket-CLI: Setup, Abschluss und Promotion | 81 Tests bestanden, 0 Fehler, 0 Skips; `CANARY_TEST_CLI` zeigte auf die gehashte installierte Datei |
| Vollständiges `npm test` | 1.360 Tests, 1.356 bestanden, 0 Fehler, 4 ausdrückliche Windows/POSIX-SKips |
| `verify:productization` | Prozessstatus 0, 104 PASS und 6 ausdrückliche SKIPs; 108 Prüfschritte haben eigene Rohprotokolle |

Die sechs finalen Gate-SKIPs betreffen fehlende Go- und Rust-Toolchains, zwei Messungen ohne echte Betriebssystem-PTY und zwei Live-Diagnosen ohne verlässlich durchsetzbares Anbieterbudget. Die zwei PTY-Proben haben ihre Produktfälle über den In-Process-Treiber ausgeführt; eine echte OS-PTY ist damit nicht belegt. Kein SKIP zählt als PASS.

Ein vorheriger Gate-Anlauf endete mit Status 1 wegen eines node:test-Worker-Startfehlers. Dieser Lauf ist erhalten. Der vollständige abschließende Anlauf in der wiederhergestellten Python-Umgebung endete mit Status 0.

## Paket und Belege

Der Paketstand ist unveröffentlicht und meldet weiterhin `canary 1.5.0`. Das Archiv wurde aus Quellcommit `ba39bd9a6d64fc2e1c0260c994b6139688f05a84` erstellt; der Produktfix stammt aus `5453054e9e154a31148091ceeb917df0a10c26de`.

- Archiv-SHA-256: `208691ce433ec0b7d67a49558eb967c43112eee631af43d162986cc7932ff30d`.
- Installierte CLI-SHA-256: `2592a189f860f3961f243ff8aae9d2c1e3cdcb1d4d47857c45f83d92b01acefa`.
- Paket und installierte CLI: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/setup-failure-output-20261008-frozen/package`.
- Installierter gezielter Testlauf: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/setup-failure-output-20261008-frozen/focused-tests`.
- Vollständiger Gate-Lauf samt 108 Rohprotokollen: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/setup-failure-output-20261007-gates-job/capture`.
- Vorheriger Paketstand ohne den Setup-Link: Archiv `67d088831082f176994d89de3dc88dbe6f4b5743fd017eb03c8a79bbc9bad42f`, CLI `e0dbc707315c00c20af086958059402da0f83e5f7f2af4dc832ba31df794ef50`.

## Offene Praxisbefunde

Der vollständige Sechs-Aufgaben-Pilot ist noch nicht abgeschlossen. Eine belastbare Begrenzung der Anbieterabrechnung fehlt, daher wurden keine bezahlten Live-Sitzungen gestartet. Ein H1-Vergleich mit dem eingefrorenen Paket hatte einen korrekten Canary-Lauf; der Lauf ohne Canary endete in einem Bun-Segmentation-Fault ohne vollständige Abrechnung. Dieses unvollständige Paar belegt keine Zeit- oder Tokenersparnis.

Der bisherige Refactron-Hinweis fasste getrennte Läufe irreführend zusammen. Im R1-Lauf vom 24.09. schlugen beim Setup 27 Python-/Shell-abhängige Checks in Canarys Ausführungsumgebung fehl; der spätere Doctor auf dem Agenten-Endstand blieb `NEEDS ATTENTION` mit 12 Testfehlern ([Rohbericht](REAL-WORLD-EVIDENCE-1.5.md)). Ein separater R1-Retry vom 03.10. protokolliert beim Setup einen Vitest-Abbruch mit `ERR_IPC_CHANNEL_CLOSED`; der spätere Doctor meldete `READY` auf einem anderen Commit (Setup: `1fe40d8…`, Doctor: `0e46cf7…`). Die Ursache des Abbruchs ist ungeklärt. Diese Ausführungen belegen weder einen Widerspruch auf demselben Stand noch eine Canary-Ursache ([Nachgang](POST-V15-BUILD-ORDER-2026-10-03.md)).

Die Ursache des älteren Windows-Prozessüberwachungsbefunds ist trotz der vereinbarten Diagnosegrenze offen. `LOCAL` bleibt auf gleichem Benutzerkonto eine Vertrauensgrenze. Diese Befunde sind nicht durch die neuen Regressionen geschlossen.

Merge und Veröffentlichung sind separat. Die 8/10-Bewertung bleibt offen, bis der reale Pilot und die offenen Praxiskriterien belegt sind.
