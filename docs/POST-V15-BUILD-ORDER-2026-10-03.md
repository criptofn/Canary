# Canary: aktuelle Build-Ausgabe vor Regressionstests prüfen

## Bestätigter Produktfehler und Korrektur

Der native Refactron-Versuch hatte nach `npm run clean` einen Suite-Startfehler wegen fehlender kompilierter CLI. Die Nachprüfung bestätigt einen Fehler im automatisch erkannten Node-Prüfplan: Canary führte Tests vor dem Build aus. Das kann korrekte frische Projekte blockieren und Tests gegen einen veralteten Build bestehen lassen.

Commit `b36d195` ändert ausschließlich die Reihenfolge neu erkannter Node-Schritte auf Typecheck, Build, Tests, Bench, E2E. Fehlende Skripte werden weiterhin nicht erfunden. Bestehende versiegelte Pläne werden weiterhin wörtlich ausgeführt; ihre Reihenfolge und ihr Digest ändern sich durch ein Binärupdate nicht. Andere Adapter behalten ihre bisherige Reihenfolge. Ein erneutes, vom Betreiber geprüftes Setup übernimmt den neuen Standard und versiegelt einen neuen Ausgangsstand. Das gehört zwischen Aufgaben. [Kompatibilität](COMPATIBILITY.md#compiled-node-checks).

Die Kontroll-Fixture baut die Implementierung aus `implementation.json` nach `dist`; ihr Test prüft tatsächlich diese kompilierte Datei. Die rote Regression scheitert am vorherigen installierten Paket bereits beim ersten Setup (Exit 2 statt 0). Nach der Korrektur prüft derselbe Test zusätzlich Abschluss nach entferntem `dist`, einen alten grünen Build bei fehlerhafter aktueller Quelle, Reparatur bei altem roten Build und fehlgeschlagenen Build trotz noch grüner Testdatei. Alle Gegenfälle erhalten die Blockentscheidung.

## Ausgeführte Prüfungen

- Gezielte Regression und Gegenfälle: vier Tests bestanden. Die zusätzliche reine Autoritätsprüfung bestätigt einen gültigen alten Tests-vor-Build-Digest und weist seine nachträgliche Umordnung als Drift ab.
- Vollständige Suite auf dem endgültigen Produktcode: **1338 Tests, 1334 bestanden, 4 übersprungen, 0 Fehler**, Exit 0. Die vier Skips betreffen POSIX-Harness-Grenzen auf Windows.
- Rohlog: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/build-order-20261002-unit-final.log`, SHA-256 `9e3f2ab13820297a2e042fa3c23b82449acaf1bac389a173560da3d0f237c172`; Exitdatei daneben.
- Der erste vollständige `verify:productization`-Lauf endete mit Exit 1: **102 PASS, 6 explizite SKIP, 2 FAIL**. M10 erwartete im eingefrorenen Plan noch `test,build`; die M9-Fixture versuchte einen Build zu manipulieren, der mit dem neuen Standard bereits ausgeführt war. Der Pilot wurde dadurch vor Paketierung und Modellaufrufen gestoppt. Rohlog und Exitdatei: `build-order-20261003-productization.log` im Evidenzverzeichnis.
- Der anschließende vollständige `verify:productization`-Lauf endete mit Exit 0: **104 PASS, 6 explizite SKIP, keine Fehler**. Die vier Plattformgrenzen betreffen fehlendes Go/Rust und zwei echte OS-PTY-Prüfungen; zwei kostenpflichtige Claude-Diagnosen wurden wegen nicht zuverlässig begrenzbarer Anbieterabrechnung nicht gestartet. Kein Skip zählt als bestanden. Rohlog: `build-order-20261003-productization-final.log`, SHA-256 `b7592128c2533100d37d6531d9d98b8c54785a6a6006062a609f96b1cf2e14b6`. Die erneut im Gate ausgeführte vollständige Suite meldet ebenfalls 1338 Tests, 1334 bestanden, 4 übersprungen, keine Fehler oder Abbrüche.
- Der direkte Vergleich beider installierter Pakete ist abgeschlossen; alle sieben Kontrollbeobachtungen sind bestätigt. Acht ausgewählte installierte Onboarding-Regressionen bestehen ebenfalls, ohne Fehler oder Skips. Entwicklungsläufe ersetzen diese Ergebnisse nicht.

Der erste vollständige Lauf meldete 1333 bestanden, einen Fehler und vier Skips: Eine vorhandene Assertion erwartete die alte Reihenfolge im Text `available ids: test, build`. Sie erwartet jetzt die tatsächlich neu entdeckte Reihenfolge `build, test`; alle Aussagen über PARTIAL, unveränderten Checkpoint und roten vollständigen Gate bleiben erhalten. Der anschließende vollständige Lauf besteht. Beide Logs bleiben erhalten.

Die beiden zusätzlich im Produkt-Gate gefundenen Versuchsannahmen wurden an die neue Reihenfolge angepasst. M9 lässt jetzt den Build den noch ausstehenden Test manipulieren; alle bisherigen Aussagen über tatsächliche Ausführung, Blockentscheidung, Nachprüfung und Quarantäne bleiben erhalten. Beide gezielten Prüfungen bestehen vollständig (`build-order-20261003-m9-fixed.log` und `build-order-20261003-m10-fixed.log`, jeweils Exit 0). M10 erwartet im neuen Plan `build,test`; alle Aussagen über eingefrorene Autorität und Pflichten bleiben erhalten. Der anschließende vollständige Gate wird unter `build-order-20261003-productization-final.log` separat erfasst. Der fehlgeschlagene Gate bleibt sichtbar und wird nicht nachträglich als bestanden umgeschrieben.

## Zwischenmessungen bleiben sichtbar

Der Entwicklungsvergleich bestätigt: altes Paket blockiert das korrekte frische Projekt und meldet beim alten grünen Build trotz fehlerhafter aktueller Quelle `pass`; der neue Entwicklungsstand akzeptiert den ersten Fall und blockiert den zweiten. Der gesamte Vergleich bleibt unvollständig, weil seine Upgrade-Fixture zuerst eine andere Installationsadresse verwendete und anschließend eine ungebündelte Entwicklungsdatei ohne ihre Workspace-Pakete kopierte. Das sind Fehler im Versuchsaufbau. Der gültige Upgrade-Vergleich verwendet die gepackten Binärdateien nacheinander an derselben separaten Installationsadresse und prüft Konfigurationsbytes und ausgeführte Reihenfolge.

Die Zwischenbelege liegen unter `build-order-20261002-development-comparison` und `build-order-20261002-development-comparison-fixed` im genannten Evidenzverzeichnis. Sie werden nicht als abgeschlossene installierte Abnahme gezählt.

## Eingefrorenes installiertes Paket

| Kennung | Wert |
|---|---|
| Einfriercommit | `1602ce1810abaebd79d1b20286a8de0d5e3898da` |
| Funktionale Korrektur | `b36d195` |
| Paket SHA-256 | `1b080c1347a05e9046a8c6f38527944f7f7f4aacb8bf7d5c8a151873befca29c` |
| Installierte CLI SHA-256 | `3d7dc38dbd2157caf09afb68f643d43864f54dc45fc08cefcd0faae54b7a19d8` |
| Versionsanzeige | `canary 1.5.0`, unveröffentlichter Arbeitsstand |

Paket, Installation, Version, saubere Ausgangsquelle und bytegleich kopierte Gate-Logs liegen unter `build-order-full-pilot-20261003-job-six-task-controls/capture/package` im Evidenzverzeichnis. Dieser Bericht wurde nach dem Einfrieren ergänzt; Produkt, Messprogramme und Aufgaben bleiben für den Versuch eingefroren.

Der installierte Vergleich verwendet als Vorher-Variante das vorherige **Arbeitspaket** aus `aae19a2`, nicht das GitHub-Release. Sein CLI-Hash ist `168a322bef8f859528c7d2cad5cac0cdf87b79f53873286748a93fad5f76b897`.

| Kontrollfall | Vorheriges Arbeitspaket | Neues Arbeitspaket |
|---|---|---|
| Korrektes frisches Projekt | Setup Exit 2, `fail` | Setup Exit 0, `pass` |
| Fehlerhafte aktuelle Quelle, alter grüner Build | Setup Exit 0, falsches `pass` | Setup Exit 2, `fail` |
| Korrekte Änderung nach entferntem Build | nicht erneut gemessen | tatsächlicher Abschluss `pass` |
| Fehlgeschlagener Build, alter grüner Test | nicht erneut gemessen | tatsächlicher Abschluss `fail` |
| Binärupdate über bestehendem Siegel | alter Plan | Konfiguration bytegleich; weiterhin Tests vor Build |

Zusätzlich besteht die Reparatur bei veraltetem roten Build. Rohbefehle, CLI-Hashes, Ausgaben, Checkpoints und archivierte Zustände liegen unter `capture/installed-comparison`; dessen `summary.json` meldet `complete`, ohne Fehler. Die acht installierten Regressionen umfassen den neuen Build-Fall, beide Vitest-Fehlerformen, drei Startup-Fälle, Setup-Rollback und PARTIAL mit unverändertem vollständigem Checkpoint; Rohlog: `capture/installed-regressions.stdout.log`.

Der anschließende Sechs-Aufgaben-Test verwendet dieselben fünf Messprogramme und historischen Lösungspatches wie der archivierte Release-Vergleich; ihre Programmhashes wurden erneut überprüft. Auch die erhaltene Release-Datei hat weiterhin SHA-256 `cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386`, ihre installierte CLI `3cfdfece2581b1036e1b01905be39d97161d03f683110cf40910570a5235d5e2`.

### Abgebrochener Sechs-Aufgaben-Versuch

Der erste Versuch endete vor den Lösungskontrollen und Modellaufrufen als `incomplete`: In der **Plain-Baseline ohne Canary** scheiterte Refactrons bestehender Test `a changed BLANK line does not make an untested change read as covered`. Der Reporter meldet 569 bestanden, einen Fehler, 10 Skips; der Test erhielt eine leere Liste statt der erwarteten ungetesteten Zeile 12. Refactrons Urteil blieb dabei `UNPROVEN`. Die unabhängige Canary-Baseline bestand ihre regulären Checks und meldete `READY`. Diese verschiedenen Ausführungen beweisen keine Canary-Ursache oder Canary-Verbesserung.

236 bytegeprüfte Dateien des abgebrochenen Versuchs liegen unter `capture/six-task-controls-incomplete-archive`; dessen Manifest nennt ausdrücklich `captureStatus: incomplete`. Das ursprüngliche Ergebnis wird nicht durch spätere grüne Läufe ersetzt.

`v15-refactron-baseline-diagnostic.mjs` protokolliert den tatsächlichen Report an der vorhandenen Assertion in der eigenen temporären Projektkopie. Es erhält alle Assertions und stellt die ursprüngliche Testdatei anschließend bytegenau und Git-sauber wieder her. Der gezielte Lauf besteht (ein Test, 579 durch die Auswahl übersprungen); der anschließende vollständige Projektlauf besteht (570 Tests, 10 Skips). Beide Reports nennen die erwartete ungetestete Zeile 12 und weiterhin `UNPROVEN`. Rohbelege: `build-order-20261003-refactron-baseline-targeted` und `build-order-20261003-refactron-baseline-full`. Die genaue Ursache des ersten Fehlers bleibt offen; es wurde keine Produktkorrektur dafür behauptet.

Eine Wiederholung mit dem unveränderten eingefrorenen Paket und neuen Ausgangskopien wird unter `canary-improved-six-task-20261003-build-order-retry` im OS-Temp-Verzeichnis sowie `build-order-20261003-six-task-retry.log` im Evidenzverzeichnis separat erfasst. Ein abgeschlossenes neues Sechs-Aufgaben-Ergebnis oder ein nativer Pilot wird noch nicht behauptet.

## Erfassung nativer Sitzungen

Der vorherige native R1-Folgeversuch bleibt unvollständig; seine gesicherte Lösung besteht die unabhängige Aufgabenprüfung, aber Sitzungsende und vollständige native Abrechnung fehlen. [Bericht](POST-V15-COMPLETION-WORKFLOW-2026-10-02.md).

Commit `74ec64d` ergänzt deshalb einen Windows-Launcher mit dauerhaft gespeicherten äußeren Logs und Prozesskennung. Er verändert weder Canary noch Modell, Rechte oder Prüfkriterien. Im kostenfreien Kontrolllauf existierte der gestartete Prozess nach beendetem Launcher weiter; `job.json` wurde um 08:40:44 UTC geschrieben, das abschließende Kontrollergebnis um 08:40:59 UTC. Der erste Launcher-Versuch wartete wegen geerbter Pipe-Handles bis zum Ende des Kontrollprozesses; der korrigierte Launcher verwendet Dateien statt Pipes. Belege: `native-producer-control-20261003` und `native-producer-control-20261003-files`.

Das belegt den kontrollierten unabhängigen Start und gespeicherten Abschluss, keine nachgewiesene Ursache des früheren Producer-Abbruchs und noch keinen erfolgreichen neuen Modellpilot. Ein gestarteter Prozess zählt weiterhin nicht als abgeschlossene Sitzung.

## Bewertung

Dies behebt eine reproduzierte unnötige Blockade und ein falsches grünes Prüfergebnis bei veralteten Build-Dateien. Eine 8/10 für das Gesamtprodukt bleibt vorerst unbewiesen: Der normale Abschluss und der Nutzen im Verhältnis zum Aufwand müssen am eingefrorenen installierten Stand beobachtet werden. Ein künstlicher Kontrollfehler zählt dabei nicht als natürlich beobachteter Agentennutzen. Merge und Veröffentlichung erfolgen separat.
