# Canary: Abnahme des Produktfortschrittsplans

## Stand

Der zuletzt freigegebene Produktfortschrittsplan ist umgesetzt und anhand installierter Pakete geprüft. Die Einrichtung erholt sich vom reproduzierten späten Abbruch; beide geplanten Zeitziele sind erreicht; der Sechs-Aufgaben-Vergleich und die Gegenproben sind abgeschlossen.

Gegenstand ist der zuletzt freigegebene Plan vom 29. September: zuverlässige Einrichtung, kürzere Reparaturprüfung und ein nachvollziehbarer Vergleich installierter Pakete. Ein bezahlter Modellpilot ist darin ausdrücklich keine Voraussetzung. Die früheren Pilotberichte bleiben erhalten.

## Belegte Verbesserungen

| Bedienablauf | Vor dem Plan | Verbesserungsstand |
|---|---|---|
| Später Setup-Abbruch beim Speichern der Autorität | Integrationsdateien verändert zurückgelassen | Claude-, Codex- und MCP-Einstellungen bytegenau wiederhergestellt |
| Hermes: bekannten Testfehler erneut prüfen | Median 1,875 s, zwei Checks | Median 1,043 s, ein Check; 44,4 % weniger Zeit |
| Refactron: bekannten Typfehler erneut prüfen | Median 124,124 s, drei Checks | Median 2,337 s, ein Check; 98,1 % weniger Zeit |
| Teilcheck grün, anderer Check rot | Vollprüfung erforderlich | PARTIAL; unveränderter vollständiger Checkpoint; Vollprüfung blockiert weiter |
| Erneutes Setup | Fremde Einstellungen erhalten | Weiterhin erhalten; genau ein Canary-Eintrag nach zwei Wiederholungen |

Die Zeitersparnis gilt für Reparaturprüfungen, nicht die gesamte Aufgabe. Ein vollständiger Abschlusscheck bleibt erforderlich. Hermes verwendet in diesem kontrollierten Vergleich zusätzlich seinen bereits vorhandenen Server-Smoke-Test als zweiten versiegelten Check. Sein Standardplan hat nur einen Check. Es gab fünf Messungen je Variante und Projekt; je ein Aufwärmlauf wurde ausgeschlossen. Refactrons ursprünglicher Kontrollfehler lag außerhalb seines Typecheck-Umfangs; dieser abgebrochene Versuch bleibt sichtbar und wurde nur für Refactron korrigiert wiederholt. [Messbericht und Rohbelegpfade](POST-V15-REPAIR-PROGRESS-2026-10-01.md).

Die bereits implementierten Änderungen liefern außerdem präzise Reparaturbefehle, den tatsächlich ausgeführten Testeinstieg im Agenten-Startkontext und verwertbare Ausgaben bei fehlenden Vergleichsdateien. Neue uncommittete und importierte Tests mit unterstützten Namensformen werden berücksichtigt. Unaufgerufene oder nicht unterscheidende Checks bleiben unproven; die Herkunft neuer oder umgeschriebener Agententests bleibt sichtbar. [Gezielte Regression und Gegenfälle](POST-V15-IMPORTED-CHECK-REPAIR-2026-10-01.md).

## Schutz und Kompatibilität

- CLI: doctor --check <id>; MCP: canary_doctor mit optionalem check. Es wird ausschließlich ein bereits versiegelter Check gewählt. Auch Drift in einem anderen Check wird abgewiesen.
- PARTIAL ist nur die erfolgreiche gezielte Diagnose. Sie ersetzt weder vollständige Prüfung, Anforderungen noch Abschluss-Checkpoint. Standardaufrufe behalten ihre Statuswerte und JSON-Verträge; die Auswahloption und PARTIAL sind ausdrücklich angeforderte Zusatzpfade.
- Fehlende Werkzeugfreigaben nennen einen ausführbaren Setup-Befehl. Die Gegenproben mit beiden installierten Paketen bestätigen, dass dieser Befehl die Prüfung repariert und eingeschleuste Suchpfade sowie Werkzeugverzeichnisse im Arbeitsrepo weiterhin abgewiesen werden. Diese Toolchain-Funktion bestand schon vor dem Plan und wird nicht als neue Verbesserung gezählt.
- Ungültige Einstellungen werden unangetastet gelassen. Ein fehlgeschlagener Projektcheck lässt die Installation bestehen, speichert jedoch einen roten Prüfstatus.
- LOCAL behält seine dokumentierte Grenze gleicher Benutzerrechte. Es gibt keinen neuen HARDENED-Dienst und keine neue Agentenintegration.

Zusätzlich am installierten Verbesserungsstand ausgeführt: fünf gezielte Onboarding-Tests, alle bestanden, einschließlich versiegeltem Plan-Drift und unverändertem vollständigen Checkpoint. Der vorhandene Toolchain-Probe meldete in jeder Paketvariante 15 bestandene Gruppen; Python3 war auf diesem Host nicht vorhanden und wurde ausdrücklich nicht behauptet. Die 448 archivierten Dateien liegen unter C:/Users/Johannes/Desktop/canary/_canary-data/evidence/repair-plan-installed-controls-20261001; export-manifest.json enthält die SHA-256-Werte. Die eigenen temporären Kontrollprojekte wurden nach dem bytegenauen Archivvergleich entfernt.

## Alle sechs Aufgaben, gleicher Ausgangspunkt

Hermes H1, H2, H3 und H5, Refactron R1 und Schniedelsmp S1 beginnen unabhängig aus den dokumentierten Ausgangscommits. Beide installierten Pakete bestehen je zwölf Kontrollen: korrekte Lösung akzeptiert, alte Implementierung mit denselben Regressionstests abgewiesen. Die zwölf Einrichtungsprüfungen pro Variante bestehen ebenfalls. Instrumente, Patches, Ausgangscommits, Toolchain-Verzeichnisse und Zeitgrenzen stimmen überein. Das zeigt erhaltene Funktion und Fehlererkennung in diesen Aufgaben; eine neue Verbesserung der Korrektheitsquote wird dafür nicht behauptet.

Der ausgeführte Vergleichsreporter bestätigt 24/24 Kontrollen und 1384 erneut gehashte Rohbelegdateien. [Tabelle, Paketkennungen und Archivpfade](POST-V15-PREPLAN-COMPARISON-2026-10-01.md). Die temporäre Vor-Plan-Matrix und ihre zwölf eigenen Trust-Verzeichnisse wurden erst nach erneutem Archivvergleich entfernt. Der frühere [Vergleich gegen das veröffentlichte Paket](POST-V15-RELEASE-COMPARISON-2026-10-01.md) bleibt als eigener Nachweis erhalten.

## Eingefrorener Stand und vollständige Prüfungen

Ausgangspunkt: 2171535496f4fda3af060c03449e6b1a65b6380f. Das isoliert rekonstruierte Paket hat SHA-256 530707e3cb6d293ec0e407a62235ac8aa2b028b10fc780c28b6e82f866d19b89; seine Bytes stimmen mit dem historischen Paket überein. Ein erster Rekonstruktionsversuch mit falsch verankertem npm-Installationspfad bleibt als unvollständig erhalten. Der erfolgreiche Versuch verwendet ein eigenes Manifest und einen expliziten Installationspräfix.

Verbesserung: Produktquelle dd017c4. Installiertes Paket unter C:/Users/Johannes/Desktop/canary/_canary-data/evidence/imported-check-final-20261001/final.tgz; SHA-256 806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975. Die CLI hat SHA-256 9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659. Die Anzeige bleibt 1.5.0; dies ist ein unveröffentlichter Verbesserungsstand.

Nach den Produktänderungen liefen nacheinander gezielte Regressionen, vollständige Suite und verify:productization. Das eingefrorene Paket wurde anschließend installiert geprüft. Seitdem wurden nur Messprogramme und Berichte ergänzt; das Produkt wurde während der Vergleiche nicht verändert oder neu gebaut.

| Prüfung | Tatsächlich beobachtetes Ergebnis |
|---|---|
| npm test | 1329 Tests: 1325 bestanden, 4 explizit übersprungen, 0 fehlgeschlagen |
| verify:productization | 104 PASS, 6 SKIP, keine Fehler |
| Installierte Reparaturmessungen | Beide Schwellen von mindestens 25 % erreicht; Gegenfälle bestanden |
| Installierter Setup-Vergleich | Alter Rollback-Fehler reproduziert; Korrektur und Gegenfälle bestanden |
| Installierte Drift-/Checkpoint-Regressionen | 5/5 bestanden |
| Sechs Aufgaben vor Plan / Verbesserung | 24/24 positive und negative Kontrollen; Einrichtung in beiden Varianten bestanden |

Die vier Test-Skips sind Plattformgrenzen. Die sechs Productization-Skips: Go und Rust nicht verfügbar; zwei Prüfungen ohne verfügbare echte OS-PTY, deren übrige Produktprüfungen liefen; zwei kostenpflichtige Claude-Prüfungen wegen nicht zuverlässig begrenzbarer Anbieterabrechnung nicht gestartet. Kein Skip zählt als bestanden. Der vollständig geprüfte Windows-Prozessfix schließt die noch ungeklärte Ursache des historischen verschwundenen Kindprozesses nicht durch bloße grüne Wiederholungen; die damalige Grenze von 30 kontrollierten Versuchen wurde eingehalten. [Verbleibender Windows-Befund](POST-V15-IMPORTED-CHECK-REPAIR-2026-10-01.md).

Die unveränderten vollständigen Gate-Logs liegen neben dem Paket: unit.log mit SHA-256 e33a76137fae34bb0c1aaeb4e307ffb6755268cf47a38f1dc10f98a031b875f8 und productization.log mit SHA-256 97e9d906bfc043ad8b1de348d519475b76d7da706e1d30a9658fe8793f133dc2. Beide wurden für diesen Bericht erneut gehasht.

## Grenzen des Nutzennachweises

Die Reparaturstrecke ist messbar schneller und der Setup-Abbruch zuverlässiger. Eine allgemeine Tokenersparnis oder breit belastbare Produktbewertung von 8–9/10 folgt daraus nicht. Im neuen nativen H3-Vergleich gelingt der korrekte Abschluss, aber mit 22,68-mal so vielen Tokens wie ohne Canary. Refactron liefert eine korrekte Lösung, endet jedoch am Turn-Limit ohne Stop-Hook und ohne aktuelle Canary-Abschlussprüfung. Alte Setup-Nachweise werden dort nicht als Nachweis der neuen Lösung gezählt. [H3](POST-V15-IMPORTED-CHECK-NATIVE-2026-10-01.md), [Refactron](POST-V15-REFACTRON-NATIVE-FOLLOWUP-2026-10-01.md).

Die Produktkorrekturen liegen auf codex/product-progress unter anderem in 3ddd32d (Setup-Rollback und gezielte Diagnose), 1f3315d (versiegelte Schritte und Fehlerausgaben), 8435660 (Testeinstieg und Startkontext), dd017c4 (importierte und uncommittete Vergleichschecks). Die ausgeführten Reparaturmessungen und Setup-Gegenproben sind in 8c10fc2 dokumentiert, die Archivierung und der explizite historische Paketvergleich in 6432c17. Alle Änderungen sind überprüfbare Commits. Merge und Veröffentlichung sind separate Schritte.
