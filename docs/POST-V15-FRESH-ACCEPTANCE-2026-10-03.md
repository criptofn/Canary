# Frischer Änderungsnachweis und menschliche Akzeptanz

## Vollständiger Gate-Versuch auf e48b8e8

Der dauerhafte Produzent lief vom 3. Oktober 19:53:50 bis 20:26:32 UTC und endete
mit Exit 1, ohne Signal oder Startfehler. Der tatsächliche Reporter meldete
**69 PASS, 4 SKIP, 2 FAIL**; 35 verbleibende Schritte wurden nach dem nicht grünen
Dist-Mutationsschritt ausdrücklich nicht ausgeführt. Kein vollständiger PASS.

Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/proof-freshness-gate-retry-20261003-job/capture/`.
`stdout.log` SHA-256: `6a737602e8a35d0d91b192444659fd9ec862225a3cf4daf0a5d32985426bfbbe`.
`result.json` hält Befehl, Zeitstempel, Exit, Signal und Fehler fest.

Beide roten Schritte hängen an demselben Fall D in `pre10-acceptance.mjs`:
Der Akzeptanztest scheitert direkt, und die Mutationsbatterie verweigert daraufhin
das Mutieren wegen ihres roten Akzeptanz-Baselines. Sie hat keine grüne Baseline
erfunden. Ihr Reporter bestätigt anschließend die Wiederherstellung vertrauenswürdiger Dist-Bytes.

Die vorherigen Fehler in M10/S5 und M10.1/F4 traten in diesem Lauf nicht auf;
beide Schritte meldeten PASS. Dies allein klärt weder die Ursache der früheren
nativen Prozessabbrüche noch den früheren installierten Provider-Fehler. Der
installierte Provider-Audit wurde unter den 35 nicht ausgeführten Schritten nicht gemessen.

## Reproduzierte Ursache und Korrektur der Testumgebung

Fall D änderte Charts zweimal. Der gemeinsame Prüfhelfer prüfte weiterhin lediglich
`src/app.js = 2`, also den Nachweis der ersten Änderung. Die zweite Änderung war
nach der neuen Frischeprüfung objektiv unbewiesen, auch nachdem ein Mensch die
UI-Duty frisch akzeptierte. Der Kandidat verweigerte deshalb korrekt die Freigabe.

Der gezielte rote Lauf bewahrt das vollständige NOT-PROVEN-Urteil samt benanntem
Vergleichscommit und `regression-evidence`-Duty. Die Korrektur verändert keine
Produktregel: Der Fixture-Prüfhelfer prüft eine optionale erwartete Chart-Datei,
und der positive Fall D liefert für jede seiner zwei Darstellungen den passenden
Erwartungswert. Der ursprüngliche Stale-Akzeptanz-Block und die echte Wiederherstellung
zu PASS nach frischer Akzeptanz bleiben geprüft.

Der neue Gegenfall D2 bestätigt zusätzlich: Erste Änderung akzeptiert und PASS;
zweite Änderung ohne frischen Test, danach frische menschliche UI-Akzeptanz,
weiterhin NOT PROVEN. Der Beleg enthält `ui-proof: met` und
`regression-evidence: unproven`. Eine Assertion über die tatsächliche zweite
Chart-Datei plus Akzeptanz der finalen Bytes stellt PASS wieder her. Ein späterer
reiner Testcommit verdeckt die zu prüfende Produktänderung nicht.

Ausgeführte Belege in derselben Evidenzwurzel:

- `fresh-acceptance-20261003-red.log`, Exit 1, SHA-256
  `0c88044aa3865b751bbad7d3f28f5250d1aefdfd35ee448bf7eb4dc45a96040e`.
- `fresh-acceptance-20261003-green.log`, Exit 3, SHA-256
  `69f93ce8b5b8dd08938a43418c282684b0cf0ccceb0afb80c628c247e4367991`.
  Der Reporter bestätigt alle ausgeführten Produktassertionen und einen expliziten
  Host-SKIP: kein drivable echter PTY. Der in-process Terminaltreiber belegt die
  Produktprüfungen; OS-PTY-Zuteilung bleibt unbewiesen.

Der Codex-Live-Arm des Gate-Laufs endete außerdem mit 3221225477 und ohne neuen
Checkpoint. Der Probe-Text wird korrigiert, damit dieser Exit nicht als Nachweis
fehlender Authentifizierung ausgegeben wird. Ursache und echter Session-Abschluss
bleiben unbewiesen; der SKIP wird nicht als PASS gezählt. Kein zusätzlicher
Codex- oder Prozessüberwachungsversuch wurde hierfür gestartet.

Die drei vorbereiteten Pilotkorrekturen wurden danach in den Hauptarbeitsbranch
übernommen: strengere unabhängige R1-Prüfung, explizite aktuelle Gate-/Unit-Belege
und gleiche Auflösung der installierten CLI in beiden Pilotvarianten. Neue native
Pilotwerte sowie die vollständigen Pflichtprüfungen dieses zusammengeführten
Stands stehen noch aus. Eine Bewertung von 8/10 folgt daraus noch nicht.
