# Vergleichsausgabe für die Nachweisreparatur

Nach Wiederaufnahme der Produktarbeit ist dieser abgegrenzte Verbesserungsstand
geliefert. Das aktive 8/10-Ziel bleibt offen.

## Änderung

Bei grünen Checks auf beiden Seiten verlinkt Canary die tatsächliche
Baseline-Ausgabe. Abgeschlossene Vergleichsbündel nennen den verglichenen Commit,
überlagerte Checks und die ausgeführten Befehle samt Rohstreams. Sie entscheiden
keinen Prüfstatus und sind kein Sitzungsabschluss. Kandidaten schreiben diese
Diagnose nach den Autoritätskontrollen außerhalb des Kandidaten. Agententest-
Herkunft, Statuswerte und JSON-Verträge bleiben erhalten. README und
Troubleshooting empfehlen keine menschliche Freigabe für objektive Beweislücken.

Code: `041cf24` und `612c194f7611284ef3a0ec6e93d45240d3f6fd58`.
Danach kamen nur Dokumentation und GitHub-Review-Attribute hinzu.

## Ausgeführte Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Neuer Fehlerfall am vorherigen installierten Paket | scheitert am fehlenden Ausgabelink |
| Gezielte Fälle nach Korrektur | 3 bestanden; Kandidatenabschluss und Promotion funktionieren |
| Konfinierung und Autoritätsgegenfälle | 61 bestanden, 0 Fehler, 0 SKIP |
| Vollständige Suite | 1359 Tests: 1355 bestanden, 0 Fehler, 4 POSIX-Harness-SKIPs auf Windows |
| Anschließend `verify:productization` | beendet 2026-10-05T16:27:15.022Z, Status 0: 104 PASS, 6 ausdrückliche SKIPs |
| Neue Installation aus dem Lieferarchiv | beide ausgewählten Vergleichs- und Promotionsfälle bestanden; 0 Fehler, 0 SKIP |

Die erste Umsetzung blockierte Kandidaten durch eigene `.canary`-Dateien.
Ihr fehlgeschlagener Gesamtlauf bleibt erhalten: zwei Fehler, 61 abgebrochene
Aktivierungsfälle, keine anschließende Produktprüfung. `612c194` behebt die Ursache.
Die sechs finalen SKIPs betreffen Go/Rust ohne Toolchain, zwei echte PTY-Messungen
und zwei kostenbegrenzte Live-Diagnosen ohne durchsetzbares Anbieterlimit.

## Paket und Rohbelege

Unveröffentlichter Verbesserungsstand, Versionsausgabe weiterhin `canary 1.5.0`.
Code und Paket wurden vor den reinen Dokumentationsänderungen eingefroren.

- Archiv-SHA-256: `67d088831082f176994d89de3dc88dbe6f4b5743fd017eb03c8a79bbc9bad42f`.
- Installierte CLI-SHA-256: `e0dbc707315c00c20af086958059402da0f83e5f7f2af4dc832ba31df794ef50`.
- Artefakte: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/comparison-repair-evidence-20261005-frozen`.
- Finaler Gesamtlauf: benachbartes `comparison-repair-evidence-20261005-corrected-gates-job/capture`.
- Fehlgeschlagene erste Umsetzung: benachbartes `comparison-repair-evidence-20261005-gates-job/capture`.

Der Nutzen in neuen Agentensitzungen ist noch nicht gemessen. Der vollständige
Sechs-Aufgaben-Pilot, Refactrons funktionsfähige Ausgangseinrichtung und die Ursache
des älteren Windows-Prozessüberwachungsbefunds bleiben offen. LOCAL bleibt eine
Grenze gleicher Benutzerrechte. Merge und Veröffentlichung stehen separat an.
