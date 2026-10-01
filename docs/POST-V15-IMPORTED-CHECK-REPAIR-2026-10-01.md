# Canary: importierte Regressionstests werden vergleichbar

## Konkreter Produktfortschritt

Der archivierte H3-Agentenlauf lieferte eine korrekte Implementierung und einen schwachen Test in `scripts/matrixNormCore-regression-test.js`. Nach dem Einbinden dieses Tests und dem Ergänzen ausreichender Assertions blieb Canary auch bei korrekter Arbeit `unproven`: Der Vergleich kopierte die neue `*-test.js`-Datei nicht in den Ausgangsstand. Die dort fehlende Datei machte den Vergleich unbrauchbar. Das war eine unnötige Produktblockade.

Zusätzlich meldete Git bei neuen, noch nicht eingecheckten Dateien nur `scripts/`. Auch ein ansonsten unterstützter Test darin konnte deshalb fehlen. Dieser zweite Fehler wurde bei der gezielten Regression sichtbar und ebenfalls korrigiert.

Die Änderungen:

- Nur beim Zusammenstellen der Vergleichschecks werden zusätzlich `*-test`, `*_test`, `*-spec` und `*_spec` mit JavaScript-/TypeScript-Endungen berücksichtigt. Die globale Ausnahme für Änderungen ausschließlich an Tests wird dadurch nicht erweitert.
- Beide Diff-Sammler lassen Git neue Dateien einzeln auflisten. Eine neue Datei braucht keinen Commit, um als Vergleichscheck erkannt zu werden; ignorierte Dateien bleiben ignoriert.
- Scheitert der Vergleich an einer fehlenden Datei oder einem Modul, werden dessen Ausgaben im vorhandenen Evidenzformat gespeichert. Die Rückmeldung nennt den Pfad, bevor der temporäre Vergleichsstand entfernt wird. Der Status bleibt `unproven`.

Keine neue Abhängigkeit und kein Importgraph. Beliebig benannte transitive Hilfsdateien werden weiterhin nicht automatisch übernommen. Dafür nennt die gespeicherte Ausgabe nun die konkret fehlende Datei. Neue und umgeschriebene Agententests behalten ihre Herkunftskennzeichnung. Die Grenzen gleicher Benutzerrechte in `LOCAL` bleiben bestehen.

## Vorher und nachher am installierten Produkt

Dasselbe eingefrorene Versuchsprogramm verwendet die archivierte tatsächliche H3-Implementierung und den schwachen Agententest. Ein Operator bindet den Test ein und ergänzt Assertions über die tatsächliche Implementierung: Ungültige Bitbreiten müssen scheitern, gültige Breiten von 2 bis 16 endliche Ergebnisse liefern. Die Produktkonfiguration, der Prüfplan und die Hooks bleiben bytegleich. Jeder Vergleich beginnt aus einer frischen Ausgangskopie.

| Zustand | Vorher | Korrigiertes Produkt |
|---|---|---|
| Neuer Test nicht vom versiegelten Einstieg aufgerufen | `unproven`, blockiert | `unproven`, blockiert |
| Schwacher Test eingebunden, prüft die ungültigen Breiten nicht | `unproven`, blockiert | `unproven`, blockiert |
| Ausreichende Assertions eingebunden, korrekte Implementierung | `unproven`, unnötig blockiert | `pass`, Abschluss erlaubt; Agententest-Herkunft sichtbar |
| Dieselben Tests, alte fehlerhafte Implementierung | Nach der vorherigen fehlgeschlagenen Erwartung nicht ausgeführt | `fail`, blockiert |

Das sind kontrollierte CLI-Checkpoints mit Stop-Eingaben. Es sind **keine neuen autonomen Agentensitzungen** und keine Beobachtung eines natürlichen Fehlers. Eine Reparatur durch einen Operator beweist keine Tokenersparnis.

Vorher-Paket SHA-256: `8a4cacf4e7b77ffe98da7cf8b14e617db672cf80fcbfd21f621d44961c9e5654`; CLI `05cb4d9d83742258ac9a78d3c3b2453632ced2f157427e14dfdac9b64da9e930`. Es handelt sich um den vorherigen lokalen Verbesserungsstand, nicht das veröffentlichte GitHub-Paket.

Finales Paket SHA-256: `806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975`; installierte CLI `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`. Versionsanzeige bleibt `1.5.0`; die Bytes sind unveröffentlicht.

Der Befund wurde anschließend auch **direkt gegen das veröffentlichte GitHub-Paket** bestätigt: Paket `cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386`, CLI `3cfdfece2581b1036e1b01905be39d97161d03f683110cf40910570a5235d5e2`. Der ausreichende Testzustand bleibt dort `unproven` und blockiert; derselbe Probe mit dem finalen Paket besteht alle vier Zustände. Beide Läufe verwenden denselben aktualisierten Instrumentstand. Für das Release wird ausschließlich der neue MCP-Startkontext optional behandelt und dessen Fehlen aufgezeichnet: Das Release hatte diese Anzeige noch nicht. Keine Erwartung an Status, tatsächliche Tests oder die Blockentscheidung wird gelockert. Dieses erwartete rote Gesamtergebnis bleibt als unvollständiger Versuch mit dem beobachteten dritten Zustand erhalten; der vierte Zustand wurde dort nicht ausgeführt.

Rohbelege unter `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/`:

- `dash-check-repair-20261001-H3-before`: derselbe finale Probe scheitert erwartungsgemäß an der unnötigen Blockade; beobachteter Checkpoint und Vergleichsausgaben sind erhalten.
- `imported-check-final-20261001-H3`: vier Kontrollzustände einschließlich unveränderter Konfiguration, Archiv- und Ergebnisprüfsummen und erhaltener Produktausgaben.
- `imported-check-final-20261001-H3-release` und `imported-check-final-20261001-H3-comparison`: direkter Release-/Finalvergleich mit gleichem Instrument; zusätzlich ist die Verfügbarkeit des Startkontexts aufgezeichnet.
- `claude-entry-context-20261001/dash-check-before.log`: beide neuen Regressionstests scheiterten vor der Änderung.
- `claude-entry-context-20261001/dash-check-after.log`: erster Korrekturversuch scheiterte weiterhin bei noch nicht eingecheckten Dateien. Die Diagnoseprüfung suchte außerdem fälschlich `.stderr.txt` statt der vorhandenen `.out.log`/`.err.log`; diese Instrumentannahme wurde korrigiert.
- `dash-check-repair-20261001/dash-check-after-untracked.log`: beide gezielten Regressionstests bestanden. Gegenfälle: unbenutzter Test, kopierte statt tatsächlicher Implementierung und fehlende Vergleichsabhängigkeit bleiben ohne Nachweis.

Der erste H3-Kontrolllauf der Korrektur (`dash-check-repair-20261001-H3`) bestand den ausreichenden Testzustand, konnte aber den Gegenfall wegen eines Instrumentfehlers nicht starten: Der Git-Aufruf erhielt das Baseline-Objekt statt dessen Commitkennung. Das ist als unvollständiger Versuch erhalten. Der korrigierte Probe verwendet `baseline.head`; die vollständigen Gegenfallversuche bleiben getrennt. Die früheren Verzeichnisse `claude-entry-context-20261001-H3-repair` und `claude-entry-context-20261001-H3-repair-final` bleiben ebenfalls erhalten: zuerst verhinderte ein falscher Vertrauensverzeichnis-Pfad den Start, danach bestätigte der ausreichende Testzustand die Produktblockade. Der frühe Instrument-Snapshot serialisierte zudem einen Buffer statt des Quelltexts; spätere Snapshots lesen ausdrücklich UTF-8. Fehlgeschlagene Erwartungen werden nun vor der Assertion als Checkpoint gespeichert, und Produktausgaben werden auch bei Fehlern vor dem Entfernen der temporären Kopie archiviert. Frühere unvollständige Kontrollversuche werden nicht als bestandene Gesamtprüfung gezählt.

## Vollständige Prüfung und Einordnung

Die vollständige Unit-Suite des finalen Quellstands ist abgeschlossen: **1.329 Tests, 1.325 bestanden, vier übersprungen, null Fehler oder Abbrüche**. Die vier übersprungenen Tests benötigen eine POSIX-Shell. Der Reporter nennt zusätzlich eine Go-Suite mit null ausgeführten Tests, weil ihre lokale Toolchain fehlt; diese Suite erhöht nicht die Zahl übersprungener Tests. Rohprotokoll: `imported-check-final-20261001/unit.log`, SHA-256 `e33a76137fae34bb0c1aaeb4e307ffb6755268cf47a38f1dc10f98a031b875f8`.

Danach wurde `verify:productization` vollständig ausgeführt, ohne parallele Unit-Suite: **104 PASS, sechs SKIP, null Fehler oder unvollständige Schritte**, Exitcode 0. Rohprotokoll: `imported-check-final-20261001/productization.log`, SHA-256 `97e9d906bfc043ad8b1de348d519475b76d7da706e1d30a9658fe8793f133dc2`. Paket und installierte CLI behalten am Ende ihre oben genannten Prüfsummen; auch das von der Produktprüfung erzeugte Paket hat dieselbe SHA-256 `806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975`.

Die sechs übersprungenen Schritte zählen nicht als bestanden:

- Go-Projekt und Rust-Projekt: fehlende lokale Toolchains, jeweils null ausgeführte Prüfungen.
- Human-Acceptance und Acceptance-Growth: fehlende echte OS-PTY. Neun beziehungsweise zehn Produktkontrollen wurden ausgeführt; jeweils ein Teil bleibt übersprungen.
- Live-Claude-Posttool-Feedback und Live-Tokenledger: Anbieter-Ausgaben nicht verlässlich begrenzbar, beide kostenpflichtigen Sitzungen nicht gestartet.

Die Architekturmatrix besteht 39/39 Kontrollen, die Architektur-Mutationen erkennen 13/13 Fehler, und die Master-Pass-Mutationen erkennen ebenfalls alle 13 Fehler. Der neu hinzugefügte Fall ist zusätzlich gegen das installierte veröffentlichte Paket rot und gegen das eingefrorene Verbesserungsprodukt grün. Die Veröffentlichung und der Merge erfolgen separat. Quellkorrektur: Commit `dd017c4` auf `codex/product-progress`.

Nachgewiesen ist eine behobene falsche Blockade und eine nutzbare Diagnose für verbleibende Vergleichsprobleme. Die zwölf ursprünglichen Pilotsitzungen und ihre Bewertung werden dadurch nicht rückwirkend verbessert. Weniger Eingriffe und kürzere autonome Sitzungen sind für diesen Stand noch nicht gemessen. Der [direkte Vergleich aller sechs Aufgaben](POST-V15-RELEASE-COMPARISON-2026-10-01.md) ist abgeschlossen: Release und finaler Verbesserungsstand bestehen jeweils 12/12 Kontrollen sowie alle Einrichtungsprüfungen. Sein H1-Oracle berücksichtigt nun auch eine Stunde alte Dateien und Bruchteile von Tagen, die der ursprüngliche Pilotcheck nicht abdeckte. 1.384 archivierte Rohdateien und die Gleichheit von Instrumenten, Lösungspatches, Ausgangscommits und Toolchain-Verzeichnissen wurden erneut geprüft. Die temporären Matrizen und ihre jeweils zwölf eigenen Vertrauensverzeichnisse wurden danach mit geprüften Zielpfaden entfernt; ein Kontrollaufruf mit dem Arbeitsrepository als Löschziel wurde vor jeder Änderung abgewiesen. Der offene Windows-Prozessbefund bleibt gesonderte Arbeit.
