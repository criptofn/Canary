# Unabhängige R1-Prüfung für den nächsten Pilot

Die alte R1-Prüfung unterschied Parametrisierungen, variierte die Fehlermeldung aber
nur ohne zusätzliche ` - `-Trenner. Die beiden archivierten Pilotlösungen nahmen einen
Teil der Fehlermeldung in die Test-ID auf und bestanden diese Prüfung dennoch.

Die neue Prüfung ergänzt vor dem nächsten Pilot einen eigenen Gegenfall: derselbe
parametrisierte Test muss bei `ValueError: a - b` und `ValueError: x - c` dieselbe exakte
ID liefern. FAILED und ERROR werden beide geprüft. Die vorhandenen Delta- und
Stabilitätsassertionen bleiben erhalten. Der erzeugte Test und seine Ausgaben liegen
außerhalb des Arbeitsprojekts und werden nicht als Agentenbelege gebunden.

## Ausgeführter Nachweis

`v15-oracle-stability-regression.mjs` verwendet die tatsächlichen archivierten falschen
Lösungen in eigenen OS-Temp-Kopien sowie eine kleine korrekte Parser-Kontrolle. Keine
Refactron-Datei wurde geändert. Die Kontrollfunktion ist ausschließlich Testmaterial,
keine neue Projektlösung und kein Nachweis über Canary-Abschlussverhalten.

- Vor der Ergänzung: Die archivierte Canary-Lösung besteht den Vitest-Test. Der
  Regressionstreiber scheitert, weil er die erforderliche Fehlerrückweisung vermisst.
- Danach: Dieselbe Lösung liefert **1 PASS, 1 FAIL** im unabhängigen Vitest-Reporter.
  Der Fehlertest ist die neue Stabilitätsassertion; kein Start-, Import- oder Timeoutfehler.
- Die korrekte Kontrolle liefert **2 PASS, 0 FAIL**.
- Der separate Lauf mit der archivierten Plain-Lösung weist ebenfalls die instabile ID
  zurück und akzeptiert dieselbe korrekte Kontrolle. Beide Treiberläufe enden mit Exit 0.

Belege unter `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/`:

| Lauf | Verzeichnis | SHA-256 des Regressionsergebnisses |
|---|---|---|
| Rot | oracle-stability-20261003-red | 9c7d97e15dd95363e9383412ffd21801f2889202a29b488e3e1c75204dd6953f |
| Grün, Canary-Archiv | oracle-stability-20261003-green | 899078c03748ea8fb6886619ec289023b2d9c1ce78822bea36ef1738eeb8c148 |
| Grün, Plain-Archiv | oracle-stability-20261003-plain-green | Im dortigen Regressionsergebnis und den Oracle-SHA256SUMS |

Oracle SHA-256: `9897b7f4afeaf5d7582c1a880b114af2e19234114194e230dccf5393ebd67398`.
Der Treiber erfasst Instrument-, Quellen- und Abhängigkeitshashes, Befehle sowie die
tatsächlichen Oracle-Ergebnisse. Die Oracle-Berichte bewahren zusätzlich rohe Vitest-Ausgaben.

Dies verbessert den Messaufbau und verhindert dieselbe falsche Korrektheitsbewertung im
nächsten Pilot. Die eingefrorenen alten Pilotwerte bleiben unverändert; daraus folgt
keine nachträgliche Produktverbesserung oder Bewertung von 8/10. Die Änderung liegt zunächst
im separaten Canary-Checkout, während der laufende Pflichtcheck seinen Stand unverändert prüft.

## Pilot-Starter: aktuelle Belege ausdrücklich übergeben

Der Starter verwendete bislang fest die Unit-Dateien vom 2. Oktober. Er verlangt nun
`--unit-log` und `--unit-exit`; ein stiller Rückgriff auf diese alten Dateien entfällt.
Der Launcher reicht beide Optionen weiter. Für den dauerhaften Gate-Wrapper wird
alternativ zum bisherigen Exit-Text `--gate-result` unterstützt. Dessen tatsächlicher
Exit muss 0, Signal und Fehler müssen null und der aufgezeichnete Befehl muss das
bestehende Gate-Skript sein. Auch der endgültige PASS-Report des Gates ist erforderlich.
SKIPs bleiben im mitkopierten Report sichtbar. Die Prüfung des aktuellen Git-Commits
vor dem Einfrieren bleibt erhalten.

Die Versuchskopien erhalten anhand des Ausgabeverzeichnisses eigene Kennungen. Die
Archivprüfung und aufgelöste OS-Temp-Begrenzung vor einem Cleanup bleiben erhalten;
die erlaubten Namen ergänzen lediglich `canary-native-validation-<12 Hexzeichen>`.

Ausgeführt: Syntaxprüfungen der geänderten Starter sowie zwei Gegenfälle. Fehlende
explizite Unit-Belege wurden vor jeder Ausgabeanlage abgewiesen. Der tatsächlich
fehlgeschlagene ältere Produktcheck wurde ebenfalls abgewiesen; der gespeicherte
Workflow-Report enthält `commands: []`, also weder Paketbau noch Modellaufruf.
Der erste Versuch dieses Gegenfalls zeigte zusätzlich die alte feste Temp-Pfadkollision;
die neue Kennung beseitigt diese Kollision, ohne frühere Versuchsdaten zu überschreiben.
Beleg: `pilot-failed-gate-control-20261003/workflow-result.json` in der Evidenzwurzel.
Ein erfolgreicher Ablauf mit dem neuen JSON-Gate-Nachweis ist noch nicht ausgeführt.
