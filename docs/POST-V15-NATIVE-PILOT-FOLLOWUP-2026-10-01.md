# Native Pilot: Abrechnungskorrektur und zusätzliche H1-Prüfung

## R1: native Abrechnung vollständig, Aufgabe fehlgeschlagen

Die API-Summe ist 1.412.037 Input- und 20.416 Outputtokens. Genau diese Werte enthält Claudes `modelUsage.qwen3.5:9b`. Der kleinere `usage`-Block enthält 1.365.530 und 18.411. Der ursprüngliche Sammler verglich den kleineren Block mit allen API-Aufrufen und stoppte daher nach Sitzung 10.

Die Differenz von 46.507 Input- und 2.005 Outputtokens entspricht exakt dem zusätzlichen API-Aufruf 264. Die CLI meldet automatische Kompaktierung; deren gemessene Dauer passt zum API-Aufruf. Die nachträgliche Prüfung rekonstruiert das aus den unveränderten API-Antworten und dem nativen CLI-Ereignis, ohne Tokens zu schätzen.

Rohbelege und Audit: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-local-paired-20261001-postchecks-final/accounting-audit.json`. Alle zehn bisher erfassten API-Summen stimmen mit den vollständigen nativen Modellzählern überein. Der korrigierte Bericht ist `POST-V15-NATIVE-PILOT-RECONCILED-2026-10-01.md`. Die ursprünglichen Dateien behalten ihr damaliges `incomplete` und die damalige Abrechnungsmarkierung.

Der gezielte Regressionstest scheiterte mit dem alten Vergleich. Nach der Korrektur bestehen 5/5 Parsertests einschließlich Gegenfällen für fehlende, abweichende, negative und nicht ganzzahlige Modellzähler sowie unerwartete zusätzliche Modelle. Protokolle: `claude-local-accounting-20261001/reconcile-before.log` und `reconcile-after.log`.

R1 wird dadurch **kein Erfolg**: Claude erreichte das Schrittlimit, lieferte `error_max_turns`, und die unabhängige öffentliche API-Prüfung scheitert. Der Agent ersetzte `extractFailureIds` durch eine Debugfunktion mit anderer Signatur. Es fehlt der abschließende Stop-Hook; der frühere `doctor`-Status pass belegt nicht diesen späteren Zustand.

## H1: Lücke der ursprünglichen externen Prüfung geschlossen

Der unveränderte Pilot prüfte zukünftige und fünf Tage alte Dateien. Er übersah, dass die Canary-Sitzung `Math.floor` in die Altersberechnung eingebaut hatte: Eine eine Stunde alte Datei wurde damit bei `maxAgeDays: 0` fälschlich behalten. Die Aufgabe verlangt das bestehende genaue Dateialter und ausdrücklich die unveränderte übrige Funktion.

Nach Ende dieses Pilotabschnitts prüft `--strict-age` zusätzlich eine eine Stunde alte Datei und den positiven gebrochenen Grenzwert `0.01`. Das ist eine **nachträgliche Prüfung**, keine nachträglich als vorab definiert dargestellte Pilotprüfung.

| Stand | Ursprüngliche Prüfung | Zusätzliche Altersprüfung |
|---|---|---|
| Historischer Ausgangscode | bekannte ursprüngliche Regression | scheitert |
| Synthetische korrekte Typprüfung ohne Rundung | Kontrolllösung | besteht |
| H1 ohne Canary | besteht | besteht |
| H1 mit Canary | besteht | scheitert |

Die beiden Agentenquellen wurden vor der Nachprüfung gegen ihre ursprünglich erfassten Quellhashes geprüft. Sie wurden nicht repariert. Canary hatte H1 tatsächlich als `unproven` beendet; dieser Lauf zählt weiterhin nicht als bestandener Canary-Abschluss. Der zusätzliche Fehler entstand in der regulären Aufgabe, nicht in einem künstlich eingebrachten Kontrollfehler. Das beweist keinen vermiedenen Fehler gegenüber der erfolgreichen Sitzung ohne Canary.

Alle sechs ausgeführten Kontrollprüfungen, Ausgangs-/Quellhashes und Ausgaben liegen in `claude-local-paired-20261001-postchecks-final`. Der erste Zusatzprüfaufbau scheiterte vor den Fachprüfungen an einer falschen Annahme über den Text des Kompaktierungsaufrufs; sein Verzeichnis `claude-local-paired-20261001-postchecks` bleibt als unvollständiger Aufbau erhalten.

## Fehlendes S1-Paar

S1 beginnt auf den noch unbenutzten, sauber vorbereiteten Kopien des ursprünglichen Versuchs. CLI-Paket, Modell, Kontext, Outputgrenze, Schrittlimit und Rechte bleiben gleich. Die Sammlerkorrektur wird als eigene Instrumentenversion gespeichert. Die zehn vorherigen Sitzungen werden nicht wiederholt oder durch bessere Ergebnisse ersetzt. Ein kontinuierlicher Lauf aller zwölf Sitzungen mit einer einzigen Instrumentenversion wird nicht behauptet.

Produktcode und das installierte Paket wurden in diesem Abschnitt nicht verändert. Die vollständigen Produkttests werden deshalb nicht als erneut ausgeführt angegeben. Eine höhere Produktbewertung wird aus den bisherigen Ergebnissen nicht abgeleitet.
