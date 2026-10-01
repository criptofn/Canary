# Canary: Testeinstieg vor dem ersten Agententest

## Beobachtetes Problem

Im getrennten H3-Versuch schrieb Claude einen funktional passenden Test in `scripts/matrixNormCore-regression-test.js`. Der versiegelte Einstieg `node scripts/smoke-test.js` rief ihn nicht auf. Die Implementierung bestand die externe Prüfung, Canary blieb zu Recht `unproven`, und die Sitzung erreichte das Schrittlimit. Die bloße Ergänzung allgemeiner Hinweise löste diesen Abschluss nicht. Der vollständige [Vorher-/Nachher-Bericht](POST-V15-AGENT-GUIDANCE-NATIVE-2026-10-01.md) enthält auch beide Budgetabbrüche.

## Produktänderung

Canary nennt beim MCP-Start nun den konkreten bereits versiegelten Testeinstieg. Der Agent bekommt diese Information vor dem Schreiben eines neuen Tests, ohne einen zusätzlichen Werkzeugaufruf. Die bestehende Anzeige aus der Rückmeldung für fehlende Regressionsevidenz wird dafür wiederverwendet. Sie nennt einen passenden Testeinstieg; sie ist keine vollständige Aufzählung aller Projekttests.

Die Anzeige setzt einen gültigen lokalen Datensatz, die passende CLI-Installation, einen passenden externen Plan-Datensatz und unveränderte Kommandodigests voraus. Bei fehlenden oder abweichenden Daten bleiben die allgemeinen Hinweise erhalten. Die Initialisierung führt keine Projektchecks aus, schreibt keinen Checkpoint und erzeugt keinen Nachweisstatus.

Zusätzlich erklären die Agentenhinweise und der Herkunftstext: Eine erfüllte Pflicht mit Agententest-Herkunft ist keine fehlgeschlagene Pflicht. Diese Herkunft bleibt im Bericht sichtbar. Neuversiegeln entfernt keine fachliche Unsicherheit. Regressionstests sollen die tatsächliche Implementierung aus dem bestehenden Testeinstieg prüfen.

## Nachweise und Kompatibilität

- Der neue MCP-Regressionstest scheiterte vor der Änderung am fehlenden konkreten Einstieg. Nach der Änderung bestanden 15/15 MCP-Tests.
- Derselbe Test prüft unveränderte Checkpoints und unveränderte Ausführungszähler. Gegenfälle sind ein geändertes Testkommando, ein abweichender versiegelter Datensatz und eine fremde CLI-Installation.
- Die bisherige Rückmeldung für fehlende Regressionsevidenz verwendet dieselbe Funktion. Statuswerte, Exitcodes und JSON-Felder bleiben gleich. MCP-Instruktionen und der bestehende Herkunftstext werden erweitert; Leser, die komplette Texte bytegenau vergleichen, müssen diese Textänderung berücksichtigen.
- Keine neue Abhängigkeit, kein neuer Agentenadapter und kein neuer Dienst. `LOCAL` bleibt dieselbe Benutzeridentität. Ein Agent mit denselben Rechten kann weiterhin neu versiegeln; die Hinweise schaffen keine Betriebssystem-Grenze.

Rohbelege des roten/grünen Tests: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-guidance-20261001/entry-context-before.log` und `entry-context-after.log`.

Eingefrorenes neues Paket: SHA-256 `8a4cacf4e7b77ffe98da7cf8b14e617db672cf80fcbfd21f621d44961c9e5654`. Installierte CLI: SHA-256 `05cb4d9d83742258ac9a78d3c3b2453632ced2f157427e14dfdac9b64da9e930`. Beide liegen unter `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-entry-context-20261001`.

Die vollständigen Gates und nativen Kontrollläufe dieses Pakets sind zum Zeitpunkt dieses Eintrags noch in Arbeit. Die erste Produktprüfung des vorherigen Hinweisstands wurde bewusst abgebrochen und bleibt als `INCOMPLETE` dokumentiert. Sie zählt nicht als bestandener Gate.

## Einordnung

Die Änderung liefert überprüfbare Information früher im Arbeitsablauf. Eine niedrigere Fehlerrate, kürzere Sitzungen oder Tokenersparnis durch diesen neuen Startkontext sind noch nicht gemessen. Der frühere H3-Hinweisvergleich hatte weniger Einrichtungsversuche (zehn auf einen), aber mehr Tokens und keinen bestandenen Abschluss. Die zwölf ursprünglichen Pilotsitzungen bleiben unverändert; sie rechtfertigen keine höhere Produktbewertung.
