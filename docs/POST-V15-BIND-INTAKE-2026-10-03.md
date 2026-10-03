# Canary: unvollständige Anforderungsbindungen vor dem Schreiben ablehnen

## Nachgewiesener Fehler

`canary bind` sammelte ausschließlich erkannte `--requirement`-Werte und
übersprang den Rest. Nach einer gültigen Anforderung führten ein Tippfehler,
eine fehlende zweite Angabe, leerer Text und zusätzliche unmarkierte Texte zu
Exit 0 und einer teilweise geschriebenen Erklärung. Ein abschließendes
`--requirement --reseal` wurde sogar als Anforderungstext und Reseal-Auftrag
interpretiert. Im kontrollierten Versuch scheiterte dieser Reseal mit Exit 2,
nachdem die Datei bereits verändert war; der Ausgangscommit blieb erhalten.

Die Gegenfälle laufen ausschließlich in einem kleinen temporären Git-Projekt
mit einem bestehenden Fixture-Check. Sie prüfen die Eingabe und ihre
Schreibwirkungen, keine vollständige semantische Aufgabenabdeckung.

## Korrektur

Commit `0245268c98ef0fa20bf1c3642b74fcf4dbef2cf0` auf `codex/bind-intake`,
aufbauend auf dem Canary-Produktstand `bfa7feb`.

Die gesamte Eingabe wird vor jedem Schreibzugriff geprüft. Unbekannte Optionen,
zusätzliche Positionsargumente, fehlende oder leere Anforderungen und genaue
Optionstoken anstelle von Text werden mit Exit 3 abgelehnt. Die Deklaration, der
Ausgangscommit und die Versiegelung bleiben dabei erhalten. JSON-Fehler liefern
genau ein vorhandenes `NEEDS ATTENTION`-Envelope mit dem tatsächlichen Exitcode.
Gültige Texte mit Dash-Präfix sowie der bestehende Reseal-Ablauf bleiben nutzbar.

## Ausgeführter Vergleich

Evidenzwurzel: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence`.

| Stand | Instrument | Ergebnis |
|---|---|---|
| Eingefrorenes Pilotpaket, CLI `3d7dc38dbd2157caf09afb68f643d43864f54dc45fc08cefcd0faae54b7a19d8` | `v15-bind-intake-regression.mjs` | 1/7 PASS; alle sechs Fehlereingaben verletzten den Vertrag |
| Korrigierter Entwicklungsstand, tatsächliches `onboarding.js` `09c9027125a6faeb24e20c40d2c14557b5e7f5b1eb7a09ea9f81e4fff1a14036` | dasselbe Instrument | 7/7 PASS |

Instrumenthash in beiden abschließenden Läufen:
`10b99c1228ab71112669dabb799e622200916583014b58c931ac7d0b23dac90c`.
Die CLI-Version, tatsächliche Datei, Modulhash, Befehle, Ausgaben und
Dateivergleiche stehen in `bind-intake-20261003-frozen-red-hashed` und
`bind-intake-20261003-dev-green-hashed`. Ältere Zwischenversuche bleiben erhalten.
Das eingefrorene Paket und der neue Entwicklungsstand sind unveröffentlicht;
ihre Versionsanzeige ist jeweils 1.5.0.

`bind-intake-20261003-targeted-final.log`: der neue Regressionstest besteht,
1 Test, keine Fehler oder übersprungenen Tests. Auch die bestehenden Programme
`v12-requirement-intake`, `v12-requirement-unbound` und
`universal-requirement-binding` bestehen mit Exit 0. Sie prüfen unter anderem
identische Anforderungsdigests, echte Versiegelung, Ablehnung fremder Änderungen,
genau ein JSON-Ergebnis beim Reseal und Nicht-Node-Projekte.

Die vollständigen Prüfungen des kombinierten Produktstands stehen noch aus.
Die laufende Productization-Prüfung im anderen Canary-Checkout prüft ausdrücklich
`bfa7feb`, nicht diese Korrektur. Diese Änderung allein belegt keine allgemeine 8/10.
