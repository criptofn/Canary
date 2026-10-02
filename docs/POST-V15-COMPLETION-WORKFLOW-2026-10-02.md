# Canary: Abschlussweg für Claude-Sitzungen

## Umsetzung

Ausgangspunkt ist die Produktbewertung 7/10: Einrichtung und gezielte Reparaturprüfung hatten sich verbessert, aber die beobachteten nativen Agentensitzungen verursachten hohen Aufwand; Refactron endete trotz korrekter Lösung ohne aktuelle Abschlussprüfung. Dieser Durchgang adressiert den Abschlussweg.

`canary setup` ergänzt in der bestehenden Claude-Integration einen `SessionStart`-Hook. Dieser gibt dem Agenten den tatsächlichen Arbeitsordner, den vertrauenswürdig versiegelten Testeinstieg, den installierten CLI-Pfad und eine kurze Arbeitsanweisung: Änderung und Regression fertigstellen, normal antworten, den automatischen Stop-Hook die vollständige Prüfung ausführen lassen. Meldet dieser einen Fehler, kann der Agent dessen Check gezielt erneut prüfen. `PARTIAL` bleibt eine Diagnose, kein Abschlussnachweis.

Die Starthilfe führt keine Checks aus, schreibt weder Evidenz noch Abschluss-Checkpoint und trifft keine Blockentscheidung. Ungültiger oder gedrifteter Prüfplan liefert keinen behaupteten vertrauenswürdigen Startkontext. Fremde Startup-Hooks bleiben erhalten; erneutes Setup installiert genau einen eigenen Eintrag. Uninstall entfernt nur registrierte eigene Einträge. Bestehende Installationen aktivieren die Ergänzung durch erneutes Setup. Codex bleibt bei seiner bestehenden Integration. Die Grenze gleicher Benutzerrechte im LOCAL-Modus gilt weiter.

Das verwendete Claude-Protokoll ist `hookSpecificOutput.additionalContext` für `SessionStart`; dies ist Kontext, kein Prüfergebnis. [Offizielle Hook-Dokumentation](https://code.claude.com/docs/en/hooks).

## Paket und gezielte Regression

Eingefrorener Startup-Zwischenstand für das erste Vergleichspaar, weiterhin Versionsanzeige 1.5.0:

| Kennung | Wert |
|---|---|
| Produktcommit | b4c3530d9ef12a0d333216034d3ff7e7dec2a359 |
| Paket SHA-256 | f9885f71b21146180451498b5f68cc0295252416693abbb3f2b3beb456d5f52b |
| Installierte CLI SHA-256 | 5df7963c61c4d71cbd5e87726756773bdb845d71471c087b4cad022a0aa5211c |
| Paketwurzel | C:/Users/Johannes/Desktop/canary/_canary-data/evidence/completion-workflow-20261002 |

Das vorherige Paket aus Produktcommit dd017c4 hat SHA-256 806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975; seine installierte CLI hat SHA-256 9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659. Beide Prüfungen verwenden ausdrücklich die jeweilige installierte Datei.

Die drei neuen Regressionen scheitern am vorherigen Paket: keine Startup-Ausgabe; malformed SessionStart-Konfiguration wird akzeptiert; keine Starthilfe beim roten Projektcheck. Dieselben drei Regressionen bestehen am neuen Paket. Drei zusätzliche Gegenproben bestehen dort ebenfalls: Setup-Rollback, idempotentes Setup mit fremden Einträgen, gezielter grüner Teilcheck bei bytegleich erhaltenem vollständigem Checkpoint. Rohlogs: `installed-before.log` (3 FAIL, Exit 1), `installed-after.log` (6 PASS, Exit 0), jeweils mit gespeicherter Exitdatei neben dem Paket.

Die Startup-Regression prüft außerdem, dass kein Check ausgeführt und kein Checkpoint geschrieben wird, der Kontext nach Plan-Drift fehlt und Uninstall fremde Hook-Einträge erhält. Der rote Gate-Gegenfall beweist, dass die Starthilfe einen fehlgeschlagenen Abschlusscheck nicht freigibt.

## Vollständige Prüfungen

Auf dem abschließenden Codestand ausgeführt: `npm test`, 1336 Tests, 1332 bestanden, 4 explizit übersprungen, 0 fehlgeschlagen oder abgebrochen. Vorläufiger Rohpfad: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/completion-workflow-20261002-unit-closure.log`; gespeicherter Exitcode 0. Der zuerst eingefrorene Startup-Zwischenstand hatte 1332 Tests, 1328 bestanden und dieselben vier Skips; sein `unit.log` liegt beim Zwischenpaket.

Nach dem nativen Versuch wurde zusätzlich die Darstellung farbiger Vitest-Fehler einschließlich Suite-Startfehlern korrigiert. Auf dem abschließenden Produktcommit dc8b70c liefen gezielte Regressionen, vollständige Suite und `verify:productization` nacheinander. Letzteres meldet 104 PASS, 6 SKIP, keine Fehler, Exit 0. Die sechs Skips: Go und Rust nicht vorhanden; zwei fehlende echte OS-PTY-Prüfungen, deren übrige Produktassertionen ausgeführt wurden; zwei kostenpflichtige Claude-Prüfungen wegen nicht zuverlässig begrenzbarer Anbieterabrechnung nicht gestartet. Ein Skip zählt nicht als bestanden.

Die vier Unit-Skips sind POSIX-Harness-Grenzen auf Windows. Die separat als übersprungen dargestellte Go-Suite hat null Tests und erhöht die Test-Skip-Zahl nicht. Abschließende Gate-Logs: `completion-workflow-20261002-unit-closure.log` mit SHA-256 7f2b587ce843bd33a7ec24b48466cf776c5651c4f100a9a9d7f1e035e7f8001e und `completion-workflow-20261002-productization-closure.log` mit SHA-256 0b02788cb5eceb9f94423fd1f60ad80f8a05d9de601ca93cace92fcc2648adda. Beide liegen im oben genannten übergeordneten Evidenzverzeichnis; beide gespeicherten Exitcodes sind 0.

Das endgültige Paket ist nach den Gates isoliert gepackt und installiert; alle acht ausgewählten installierten Abnahme- und Gegenproben bestehen: beide Vitest-Fehlerformen, drei Startup-Regressionsfälle, Setup-Rollback, idempotentes Setup und unveränderter vollständiger Checkpoint nach PARTIAL.

| Kennung des endgültigen Pakets | Wert |
|---|---|
| Einfriercommit | aae19a2247c1ff8ae357e4add713b8ee4983dfe8 |
| Funktionale Produktcommits | b4c3530 (Startup), cc252a3 und dc8b70c (Vitest-Darstellung) |
| Paket SHA-256 | bfa7174534960589ba227574f6dd0c2bbd3afe3309569e62b5a40cfa8b37d7b1 |
| Installierte CLI SHA-256 | 168a322bef8f859528c7d2cad5cac0cdf87b79f53873286748a93fad5f76b897 |
| Paketwurzel | C:/Users/Johannes/Desktop/canary/_canary-data/evidence/completion-workflow-final-20261002 |

Dort liegen `final.tgz`, Installations- und Versionsbelege, die bytegleich kopierten vollständigen Gate-Logs sowie `installed-after.log` und der gespeicherte Exitcode 0. `source-status` beim Einfrieren war leer. Die Anzeige bleibt 1.5.0; dies ist ein unveröffentlichter Arbeitsstand.

**Nativer Folgeversuch unvollständig:** Der Produzent verschwand ohne `summary.json`; die Ursache ist nicht nachgewiesen. Die Plain-Sitzung endete normal, bestand aber die unabhängige Aufgabenprüfung nicht. Für Canary fehlen ein erfasstes Sitzungsende und die vollständige native Abrechnung. Daher zählt das Paar nicht als abgeschlossener Autonomie- oder Effizienznachweis.

Der gesicherte Canary-Zwischenstand bestand anschließend die unabhängige R1-Aufgabenprüfung (Oracle Exit 0). Sein gespeicherter Stop-Checkpoint vom 2026-10-02T09:54:00.733Z enthält drei bestandene Checks und `message-and-continue`, jedoch `sessionEnd: unknown`. Die Herkunftswarnung für einen umgeschriebenen Agententest bleibt erhalten. Ein korrekter Dateizustand ersetzt keinen erfassten Sitzungsabschluss.

Originalbelege bleiben unter `claude-completion-final-native-20261002-R1` erhalten. Die gesonderte Wiederherstellung unter `claude-completion-final-native-20261002-R1-recovery` archiviert 58 Worker-Dateien und beide Arbeitsstände; ihre kopierte Zusammenfassung ist ausdrücklich `incomplete`. Der externe Snapshot-Oracle liegt unter `claude-completion-final-native-20261002-R1-recovery-oracle`. Beide Wurzeln liegen im oben genannten Evidenzverzeichnis. Es wurden keine fehlenden Tokenzahlen geschätzt.

## Native Prüfung

Ein frisches Refactron-Vergleichspaar verwendet unabhängige, lösungsblinde Ausgangskopien, gleiche Aufgabe, Modellkennung und Grenzwerte. Die Canary-Variante verwendet ausschließlich das oben eingefrorene Paket. Während des Piloten bleiben Produkt und Messinstrument unverändert.

Zusätzlich zum normalen Ergebnisreport prüft `v15-startup-delivery-audit.mjs` die erhaltenen tatsächlichen Modellanfragen: Der erste Modelleingang muss die Starthilfe in der Canary-Variante enthalten und in der Plain-Variante nicht enthalten. Geschützte Einstellungen und Ausgangsstand müssen erhalten bleiben. Diese Prüfung der Zustellung wird getrennt von Korrektheit, normalem Sitzungsende und einer tatsächlich aktuellen Stop-Prüfung berichtet.

Der ausgeführte Zustellreport bestätigt dies für beide vollständig abgerechneten Sitzungen und 278 erneut gehashte Rohbelegdateien. Ergebnis: Plain korrekt und normal beendet (32 Turns, 656747 native Tokens); Canary falsch und am Turn-Limit beendet (51 Turns, 1707191 native Tokens). Der Stop-Hook wurde erreicht und blockierte sieben fehlgeschlagene Regressionstests sowie einen fehlgeschlagenen Suite-Start. Vorher hatte der Agent `npm run clean` ausgeführt und den für den Suite-Start erforderlichen Build entfernt. Danach entstand kein bestandener Abschlussnachweis. Diese Beobachtung belegt keine Autonomieverbesserung. [Vollständiger nativer Zwischenbericht](POST-V15-STARTUP-REFACTRON-NATIVE-2026-10-02.md).

Die persönlichen Claude-Anweisungen wurden in beiden Varianten geladen. Die Projekt-Hook-Dateien enthielten dieselben fremden Hooks; der bisherige Messaufbau aktivierte Projekt-/Local-Einstellungen jedoch nur in der Canary-Variante. Das ist ein Versuchsaufbau-Unterschied, keine belegte Canary-Ursache. In der Canary-Sitzung meldete außerdem ein fremder Projekt-Hook einen Git-Bash-Forkfehler. Beides bleibt sichtbar. Die einzelnen Sitzungen erlauben weder eine kausale Zuschreibung aller Unterschiede noch eine belastbare Effizienzbewertung.

Für den abschließenden Folgeversuch ist das Messprogramm korrigiert: beide Varianten laden `project,local`, und vor dem ersten Modellaufruf werden die fremden Projekt- und Local-Einstellungen strukturell auf Gleichheit geprüft. Aus dem Vergleich werden ausschließlich die explizit registrierten eigenen Canary-Handler entfernt; die Dateien selbst werden dabei nicht verändert. Eine Plain-Kopie mit bereits installiertem Canary wird abgewiesen. Das endgültige Produktpaket bleibt unverändert. Wegen dieser Instrumentenkorrektur ist ein Vergleich mit älteren Sitzungen ein Vergleich verschiedener Gesamtaufbauten, keine isolierte kausale Produktmessung.

Vor Bereinigung wurden 57 Dateien einschließlich vollständiger Worker-Diffs und Einrichtungsläufe archiviert. Die Bereinigung prüfte 335 archivierte Dateien und entfernte erst dann beide eigenen temporären Projekte und Trust-Verzeichnisse. Rohbelege und Archiv bleiben unter `claude-startup-native-20261002-R1` beziehungsweise `claude-startup-native-20261002-R1-archive` im Evidenzverzeichnis erhalten.

## Aus dem Versuch bestätigte Darstellungsfehler

Die erhaltene echte Vitest-Ausgabe enthält farbige FAIL-Blöcke und AssertionError-Zeilen; die an Claude ausgelieferte Kurzmeldung enthielt nur Check, Reparaturbefehl und Logpfad. Die Regressionen für Test- und Suite-Identitäten scheitern vor der jeweiligen Korrektur; beide Integrationsfälle scheitern am installierten Startup-Paket. Danach bestehen alle 14 Payload-Tests sowie fünf ausgewählte Onboarding-Tests.

Die Korrektur verwendet `node:util` zum Entfernen von Terminal-Steuerzeichen ausschließlich für die Darstellung und erkennt Vitest-FAIL-Identitäten einschließlich Dateipfad sowie Fehlerpositionen. Auch Suite-Startfehler mit der Vitest-Form `FAIL file [ file ]` werden erkannt. Die gesicherte Runner-Ausgabe behält ihre ursprünglichen Bytes; die Kurzmeldung bleibt auf 1200 Zeichen begrenzt. Bestandene Testzeilen werden nicht als Fehlernamen übernommen. Ein zusätzlicher synthetischer Gegenfall stellt erwartete Fehlerausgaben vor den tatsächlichen FAIL-Block; die Details müssen dann aus dem FAIL-Block stammen. Die Integrationstest-Gegenprobe prüft weiterhin `decision: block`, roten Checkpoint und unveränderte farbige Rohbelege. Statusentscheidung und Prüfumfang bleiben erhalten.

`util.stripVTControlCharacters` ist bereits in der unterstützten Node-22-Linie vorhanden, laut Dokumentation seit 16.11.0. Die Korrektur erhöht weder die Mindestversion noch benötigt sie eine neue Laufzeitabhängigkeit. [Node-22-Dokumentation](https://nodejs.org/download/release/v22.13.1/docs/api/util.html#utilstripvtcontrolcharactersstr).

Die abschließende Wiederholung des tatsächlichen nativen Logs bestätigt die Darstellung unter der ursprünglichen langen Windows-Pfadlänge: vorher 311 Zeichen ohne Identitäten; danach 911 Zeichen mit Suite- und Testidentitäten, dem tatsächlich ersten Fehler `dist CLI not found` und dessen Position `tests/unit/cli/help-drift.test.ts:37:9`. Vollständiger Logpfad und Reparaturbefehl bleiben erhalten. Dies ist ein Darstellungsvergleich, keine neue Agentensitzung und kein geänderter Status. Eingabelog SHA-256: a0222fc5b81b6d55beca6327d7b8de415210afb3d2ed498c16006c9ccdf1c92a. Der ausgeführte Reporter und sein Ergebnis liegen unter `v15-native-failure-replay.mjs` beziehungsweise `claude-startup-native-20261002-R1-payload-final-replay.json`.

## Erhaltene Zwischenversuche

Die anfängliche CommonJS-Fixture unter einem ES-Modul-Paket, die Darstellung des Windows-CLI-Pfads und ein falsch referenzierter Test-Payload wurden vor dem endgültigen Testlauf korrigiert. Eine erste Log-Wiederholung erkannte zunächst nur Testfälle und ließ den früheren Suite-Startfehler aus; das ist mit einer gesonderten roten Regression und dem endgültigen 911-Zeichen-Replay korrigiert. Frühere grüne Vollsuiten gehören zu Zwischenständen und ersetzen nicht die abschließenden Gates. Ihre Logs bleiben unter dem Präfix `completion-workflow-20261002-` im übergeordneten Evidenzverzeichnis erhalten. Sie zählen nicht als erfolgreiche Produktreproduktionen. Die gültigen Rot-/Grün-Prüfungen wurden mit denselben endgültigen Testfällen ausgeführt.

Merge und Veröffentlichung sind separate Schritte. Eine höhere Bewertung oder allgemeine Tokenersparnis folgt nicht allein aus dieser Änderung.
