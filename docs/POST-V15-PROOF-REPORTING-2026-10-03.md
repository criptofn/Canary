# Canary: Nachweise im maschinenlesbaren Ergebnis

## Produktproblem

Der abgeschlossene native Pilot zeigte eine Grenze: Ein unterscheidender Test,
den der arbeitende Agent selbst schreibt, kann eine ausdrücklich verlangte
Eigenschaft übersehen. Canary kennzeichnet solche Tests bereits im Text als
`NOT independent authority`. Die JSON-Ausgabe von `doctor` enthielt diese
Kennzeichnung jedoch nicht. Ein Verbraucher, der ausschließlich JSON auswertet,
konnte `READY` lesen, ohne die Herkunftseinschränkung zu sehen.

Zusätzlich lieferte der MCP-Aufruf der vollständigen Prüfung nur Text, während
die fokussierte Prüfung bereits JSON weiterreichte. Die MCP-Eingabehilfe ließ
leere Checknamen zu, obwohl der Transport sie verweigert. Ein solcher Aufruf
trat im Pilot tatsächlich auf.

## Änderung direkt am Produkt

Codestand: Commit `bfa7feb55be5c7c3861b7bee94aa84c5e54f38f4`,
Branch `codex/product-progress`, unveröffentlicht.

- Die vollständige Doctor-Ausgabe enthält nach der Bewertung der Pflichten
  eine optionale `proof`-Übersicht: registrierte Anforderungen, beobachtete
  Pflichtzustände und Herkunftseinschränkungen.
- Der Abschluss-Checkpoint speichert dieselbe Übersicht. `result --json` gibt
  sie ausschließlich als historischen Datensatz weiter. Sie wird nicht zur
  Ermittlung eines neuen Prüfstatus verwendet.
- Keine registrierten Anforderungen bedeuten nicht, dass alle formulierten
  Aufgabenanforderungen geprüft wurden. Fehlende Übersichten sind kein Nachweis.
- Das MCP-Schema verlangt einen nichtleeren Checknamen für Teilprüfungen und
  erklärt, dass die Eigenschaft für die vollständige Prüfung entfällt.
- Vollständige und schnelle MCP-Doctor-Aufrufe reichen nun den tatsächlichen
  JSON-Status samt Nachweisübersicht weiter. Die fokussierte Prüfung bleibt
  PARTIAL und verändert den Abschluss-Checkpoint nicht. Der bisherige
  Text-Fallback entfällt für diese Aufrufe; die Transporthülle bleibt erhalten.

Bestehende Schemanamen, Statuswerte, Exitcodes, Blockentscheidungen und die
LOCAL-Vertrauensgrenze bleiben erhalten. Die JSON-Felder sind additive Angaben.
Die Änderung entstand nach dem eingefrorenen Pilot und war nicht Bestandteil
seines Pakets oder seiner Ergebnisse.

## Ausgeführte Nachweise

Evidenzwurzel: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence`.

- `proof-scope-20261003-targeted-red.log`: zwei Regressionstests scheiterten vor
  der Änderung, weil die JSON-Nachweise fehlten.
- `proof-scope-20261003-targeted-green.log`: dieselben zwei Tests bestanden.
  Sie prüfen die reale CLI, den Stop-Hook, den historischen Ergebnisabruf sowie
  eine offene Anforderung. Auch ein manipuliertes gespeichertes `proof` kann
  diese offene Anforderung nicht auf READY setzen.
- `proof-scope-20261003-mcp-red.log`: die Eingabehilfe verletzte den Vertrag.
- `proof-scope-20261003-targeted-all.log`: beide betroffenen Testsuiten,
  30 Tests bestanden, keine Fehler, keine übersprungenen Tests.
- `proof-scope-20261003-mcp-envelope-red-final.log`: mit echtem Git-Ausgangsstand
  bestand die vollständige Prüfung, aber der MCP-Transport lieferte weder
  strukturierten Status noch Nachweisübersicht. Der Transporttest scheiterte.
  Der vorherige Versuch ohne Ausgangscommit wurde als Testaufbaufehler erkannt
  und bleibt unter `mcp-envelope-diagnostic.log` erhalten.
- `proof-scope-20261003-mcp-envelope-green.log`: alle 16 MCP-Tests bestanden,
  keine Fehler, keine übersprungenen Tests, einschließlich vollständiger und
  schneller Prüfung sowie der Gegenfälle leerer Checkname und PARTIAL.

- `proof-scope-20261003-unit-final.log`: vollständige Testsuite auf `bfa7feb`,
  1340 Tests, 1336 bestanden, 4 übersprungen, keine Fehler, Exit 0.
  SHA-256 `87124caf7bc5461e8566e783b6bcd7ea32f1a9039a23031ac2fa31d23e5567d8`.

`verify:productization` folgte in demselben Prozess erst nach dieser Testsuite:
103 PASS, 6 SKIP, 1 FAIL, Exit 1. Die sechs SKIPs betreffen Go, Rust, zwei
echte PTY-Nachweise und zwei kostenpflichtige Modellprüfungen ohne belastbare
Budgetdurchsetzung. Sie zählen nicht als bestanden.

Der Fehler liegt in der installierten HARDENED-Provider-Prüfung:
`provider measure-production` brach mit `Cannot read properties of undefined
(reading 'deployment')` ab. Der vollständige Lauf bleibt fehlgeschlagen.
Loghash `fc33960104064e1d34d6a364ec680c59d303786cd01f37d7a5870a969a65080f`.

Der gezielte Nachlauf auf dem inzwischen kombinierten Stand bestand mit
54 Prüfbeobachtungen, 0 Fehlern, 57 ausgeführten und abgewehrten Angriffen
sowie 45 Positivkontrollen. Paket SHA-256
`26a5d8a7292f648f36496f793e89ef88a03196481a1747f68327a0c7a01453b1`.
Paket und Bericht bleiben unter `proof-scope-20261003-provider-diagnostic.*`
erhalten. Dieser erfolgreiche Nachlauf erklärt oder schließt den ursprünglichen
Absturz **nicht**. Die Probe erfasst künftig den inneren Fehlerstack, den
CLI-Hash und die ursprünglichen Messungsdaten vor der Bereinigung.

## Ergänzende Korrekturen nach dem ersten vollständigen Lauf

Die [strengere Bindungseingabe](POST-V15-BIND-INTAKE-2026-10-03.md) liegt jetzt
als `f48c8e3` auf `codex/product-progress`; ihre dokumentierten älteren
Entwicklungsbelege stammen aus dem separaten Canary-Checkout.

`51adb59` korrigiert eine Grenze dieser neuen Nachweisübersicht: der historische
Leser erlaubte zunächst nur 32 Pflichtzustände, obwohl Canary 64 Anforderungen
mit zusätzlichen Zielpflichten unterstützt. Der neue Test registriert tatsächlich
64 Anforderungen und vergleicht die Doctor- mit der historischen Ausgabe.
Er scheiterte vorher; danach bestehen alle drei gezielten JSON-Tests. Ungültige
Pflichtzustände und eine nicht unterstützte Anforderungszahl werden weiterhin
verworfen. Logs: `proof-scope-20261003-maximum-red.log` und `maximum-green.log`.

Der kombinierte Stand `d4c34d5` ist ebenfalls vollständig gelaufen:

- `npm test`: 1.342 Tests, 1.338 bestanden, 4 übersprungen, kein Fehler.
- `verify:productization`: 102 Schritte bestanden, 6 übersprungen, 2 fehlgeschlagen;
  Exit 1. Dieser Lauf ist **nicht grün**.
- Die Fehler liegen in M10 S5 und M10.1 F4: Prüfprozesse endeten mit
  `3221225501` beziehungsweise `3221225477`. Die Ursache ist offen; die Ausgaben
  beweisen weder einen Task-Authority-Bypass noch eine bestandene Prüfung dieser Fälle.
- Die installierte Providerprüfung bestand in diesem Lauf. Das erklärt oder
  schließt den ursprünglichen Provider-Absturz weiterhin nicht.

Rohlog: `proof-bind-combined-20261003-productization.log`, SHA-256
`a2b987bc8ca1a60fef81e1ef4e3120ad8d6dad0dfc2ddecf3869e4efa8fb4dc2`.
Das archivierte Paket `proof-bind-combined-20261003-package.tgz` hat SHA-256
`26a5d8a7292f648f36496f793e89ef88a03196481a1747f68327a0c7a01453b1`.

Die global benannte Datei `v12-production-authority.json` wurde von einer
weiteren nativen Testfixture überschrieben. Die nachträglich kopierte Datei
`proof-bind-combined-20261003-provider-report.json` enthält keinen
Instrumentenhash und wird **nicht** als Rohbericht der Paketprüfung gewertet.
Neue Paketprüfungen schreiben deshalb einen eigenen Bericht und archivieren
Paket, Instrument, Befehle und Ausgaben in einem eigenen Versuchsverzeichnis.

Die anschließende Korrektur für aufeinanderfolgende Änderungen liegt als
`3e92829` vor. Ihre gezielten Belege sind im
[gesonderten Bericht](POST-V15-CONSECUTIVE-CHANGES-2026-10-03.md) beschrieben.
Die oben genannten Prüfungen enthalten diese spätere Korrektur nicht.

## Bedeutung für die Produktbewertung

Die Änderung verbessert die Interpretierbarkeit echter Ergebnisse und beseitigt
eine beobachtete Bedienungslücke. Sie beweist keine vollständige Abdeckung
ungebundener Aufgabenanforderungen und keine Tokenersparnis. Eine allgemeine
8/10 ist durch diesen Durchgang allein weiterhin nicht belegt.
