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
- Der Vergleich beider installierter Pakete ist noch offen; Entwicklungsläufe ersetzen ihn nicht.

Der erste vollständige Lauf meldete 1333 bestanden, einen Fehler und vier Skips: Eine vorhandene Assertion erwartete die alte Reihenfolge im Text `available ids: test, build`. Sie erwartet jetzt die tatsächlich neu entdeckte Reihenfolge `build, test`; alle Aussagen über PARTIAL, unveränderten Checkpoint und roten vollständigen Gate bleiben erhalten. Der anschließende vollständige Lauf besteht. Beide Logs bleiben erhalten.

Die beiden zusätzlich im Produkt-Gate gefundenen Versuchsannahmen wurden an die neue Reihenfolge angepasst. M9 lässt jetzt den Build den noch ausstehenden Test manipulieren; alle bisherigen Aussagen über tatsächliche Ausführung, Blockentscheidung, Nachprüfung und Quarantäne bleiben erhalten. Beide gezielten Prüfungen bestehen vollständig (`build-order-20261003-m9-fixed.log` und `build-order-20261003-m10-fixed.log`, jeweils Exit 0). M10 erwartet im neuen Plan `build,test`; alle Aussagen über eingefrorene Autorität und Pflichten bleiben erhalten. Der anschließende vollständige Gate wird unter `build-order-20261003-productization-final.log` separat erfasst. Der fehlgeschlagene Gate bleibt sichtbar und wird nicht nachträglich als bestanden umgeschrieben.

## Zwischenmessungen bleiben sichtbar

Der Entwicklungsvergleich bestätigt: altes Paket blockiert das korrekte frische Projekt und meldet beim alten grünen Build trotz fehlerhafter aktueller Quelle `pass`; der neue Entwicklungsstand akzeptiert den ersten Fall und blockiert den zweiten. Der gesamte Vergleich bleibt unvollständig, weil seine Upgrade-Fixture zuerst eine andere Installationsadresse verwendete und anschließend eine ungebündelte Entwicklungsdatei ohne ihre Workspace-Pakete kopierte. Das sind Fehler im Versuchsaufbau. Der gültige Upgrade-Vergleich verwendet die gepackten Binärdateien nacheinander an derselben separaten Installationsadresse und prüft Konfigurationsbytes und ausgeführte Reihenfolge.

Die Zwischenbelege liegen unter `build-order-20261002-development-comparison` und `build-order-20261002-development-comparison-fixed` im genannten Evidenzverzeichnis. Sie werden nicht als abgeschlossene installierte Abnahme gezählt.

## Erfassung nativer Sitzungen

Der vorherige native R1-Folgeversuch bleibt unvollständig; seine gesicherte Lösung besteht die unabhängige Aufgabenprüfung, aber Sitzungsende und vollständige native Abrechnung fehlen. [Bericht](POST-V15-COMPLETION-WORKFLOW-2026-10-02.md).

Commit `74ec64d` ergänzt deshalb einen Windows-Launcher mit dauerhaft gespeicherten äußeren Logs und Prozesskennung. Er verändert weder Canary noch Modell, Rechte oder Prüfkriterien. Im kostenfreien Kontrolllauf existierte der gestartete Prozess nach beendetem Launcher weiter; `job.json` wurde um 08:40:44 UTC geschrieben, das abschließende Kontrollergebnis um 08:40:59 UTC. Der erste Launcher-Versuch wartete wegen geerbter Pipe-Handles bis zum Ende des Kontrollprozesses; der korrigierte Launcher verwendet Dateien statt Pipes. Belege: `native-producer-control-20261003` und `native-producer-control-20261003-files`.

Das belegt den kontrollierten unabhängigen Start und gespeicherten Abschluss, keine nachgewiesene Ursache des früheren Producer-Abbruchs und noch keinen erfolgreichen neuen Modellpilot. Ein gestarteter Prozess zählt weiterhin nicht als abgeschlossene Sitzung.

## Bewertung

Dies behebt eine reproduzierte unnötige Blockade und ein falsches grünes Prüfergebnis bei veralteten Build-Dateien. Eine 8/10 für das Gesamtprodukt bleibt vorerst unbewiesen: Der normale Abschluss und der Nutzen im Verhältnis zum Aufwand müssen am eingefrorenen installierten Stand beobachtet werden. Ein künstlicher Kontrollfehler zählt dabei nicht als natürlich beobachteter Agentennutzen. Merge und Veröffentlichung erfolgen separat.
