# Canary: Abschlussstand am 5. Oktober 2026

## Bewertung

**Produkt: 7/10. Technik: 8/10. Das Ziel einer belegten Produktbewertung von
8/10 ist nicht erreicht.** Das sind begründete Bewertungen, keine aus Testzahlen
berechneten Messwerte. Die Fehlerkorrekturen verbessern das Produkt konkret;
der allgemeine Nutzen und Aufwand in Agentensitzungen bleiben unzureichend belegt.

Auf Wunsch des Nutzers endet dieser Durchgang mit Paket und Bericht. Das aktive
8/10-Ziel wird anschließend pausiert. Merge und Veröffentlichung sind separat.

## Was im Produkt gebaut wurde

* Einrichtung mit ausdrücklich freigegebenen Java-/Python-Werkzeugen und
  verständlichen Fehlerursachen; manipulierte Suchpfade bleiben ausgeschlossen.
* Kompakter CLI-Einstieg, erkennbare Nachweisgrenzen und optionale Laufzeit- und
  Dateidiagnose mit `--version --verbose`.
* Historischer Prüfstatus, aktuelle Diagnose, Hook-Entscheidung und Sitzungsende
  werden auseinandergehalten. Fehlende Prozessabschlüsse erzeugen keinen Pass.
* Tatsächlich ausgeführte importierte Tests mit ungewöhnlichen Dateinamen können
  eine Änderung nachweisen; neue und umgeschriebene Agententests bleiben markiert.
* Veraltete Builddateien können bei alten Test-vor-Build-Plänen kein falsches
  READY mehr erzeugen. Frühere Fehler werden nicht durch spätere Erfolge gelöscht.
* Ein nur vor dem Build fehlschlagender Baseline-Test zählt nicht als Beweis
  dafür, dass eine Codeänderung wirksam war.
* Der im neuen H1-Lauf beobachtete Windows-Fehlblock ist korrigiert: Git-Status
  allein kann keine neue Produktionsänderung vortäuschen, wenn der Inhaltsvergleich
  leer ist. Echte neue Änderungen und ungeprüfte neue Quelldateien bleiben blockiert.

Die letzten beiden Korrekturen ändern die Vergleichsentscheidung im gemeinsamen
Prüfpfad. Statuswerte und JSON-Verträge bleiben erhalten. Alte Prüfpläne können
zusätzliche beobachtete Testausführungen enthalten; der versiegelte Plan bleibt
unverändert. Ein dauerhafter HARDENED-Dienst wurde nicht eingerichtet.

## Gelieferter Stand

Arbeitsbranch: `codex/product-progress` in
`C:/Users/Johannes/Desktop/canary/_canary-data/worktrees/canary-product-progress`.
Der gemessene Produktcode ist Commit
`a77acf9d1a286d605a27c8ff6286785e61b8b5a8`. Danach kam mit `dd74819` nur die
ausdrückliche CLI-Auswahl für den bestehenden Regressionstest hinzu; dieser
Messaufbau wurde am installierten Paket geprüft. Der Bericht ändert keinen CLI-Code.

Artefakte und Rohbelege:
`C:/Users/Johannes/Desktop/canary/_canary-data/evidence/normalized-product-delta-20261005-frozen`.

* Paket: `package/final.tgz`, SHA-256
  `be58e82ef213612edb9899066149caa22572113041022536fa21011c543baf0d`.
* Installierte CLI: `package/installed/node_modules/@canary-rn/cli/dist/main.js`,
  SHA-256 `1cb802b88186ad04fd15cde857d5e6cbcdf1ead28353001af2727af88c0b730f`.
* Versionsausgabe: `canary 1.5.0`. Dies ist ein **unveröffentlichter
  Verbesserungsstand**, nicht das veröffentlichte Archiv mit SHA-256 `cf8f777a...`.

## Prüfungen dieses Stands

| Prüfung | Ergebnis und Grenze |
| --- | --- |
| Gezielter Fehlerfall und Gegenfälle | Doctor und Stop akzeptieren die normalisierte Inhaltsgleichheit; spätere echte Änderungen und neue ungeprüfte Quellen blockieren weiterhin |
| Vollständige Suite | 1358 Tests: 1354 bestanden, 0 Fehler, 4 ausdrücklich übersprungen; Prozessstatus 0 ohne Signal oder Ausführungsfehler |
| `verify:productization` danach | 104 PASS, 6 ausdrückliche SKIP; beendet am 2026-10-05T13:22:12.779Z, Status 0 ohne Signal oder Ausführungsfehler |
| Architektur | 39 bestanden, 0 Fehler, 0 SKIP; beide Fehlerkontrollserien erkennen jeweils alle 13 Mutationen |
| Installierter Windows-Fehlerfall | Gleiches Programm scheitert am alten eingefrorenen Paket mit 2 statt 0 und besteht am neuen Paket; echte Änderungen, neue Dateien und Testherkunft sind mitgeprüft |
| CLI-Auswahl im Messaufbau | Ungültiger relativer Pfad wird verweigert, ohne Rückgriff auf den Entwicklungsbuild |
| Installierter Status / Testherkunft | Statuskontrollen ALL PASS; Herkunftskontrollen 7 bestanden, 0 Fehler |
| Build-Vergleich zur veröffentlichten CLI | 11 Beobachtungen bestanden, versiegelter Plan unverändert, 184 Rohdateien gehasht |

Die vier Suite-SKIPs betreffen POSIX-Shell-Prüfharnische auf Windows. Die sechs
Produktisierungs-SKIPs sind: reale Go- und Rust-Projekte mangels Toolchain
(jeweils null ausgeführte Prüfungen), zwei Prüfungen der echten PTY-Zuteilung
(Produktassertionen liefen, OS-Zuteilung nicht belegt) sowie zwei bezahlte
Live-Prüfungen ohne zuverlässig durchsetzbare Kostenbegrenzung. Kein SKIP wird
als bestanden gewertet. Die vollständigen Gründe stehen in `unit.log` und
`productization.log`; der zusätzliche Go-Fixture-Hinweis im Build-Vorlauf ist
ebenfalls erhalten.

## Praxisbelege und weshalb noch keine 8/10

Der frühere Pilot und der neue Vier-Sitzungen-Vergleich sind getrennte Kohorten.
Der neue Vergleich lief auf dem vorherigen eingefrorenen Code `7ecf465`, bevor
der dabei gefundene Windows-Fehlblock korrigiert wurde:

| Aufgabe / Variante | Unabhängige Korrektheit | Sitzungsabschluss | Native Tokens | Sekunden |
| --- | --- | --- | ---: | ---: |
| H1 ohne Canary | bestanden | normal | 31.795 | 39,761 |
| H1 mit Canary | bestanden | Turnlimit; realer Hook unproven | 1.395.606 | 398,144 |
| H2 mit Canary | bestanden | normal; realer Hook pass | 550.676 | 214,924 |
| H2 ohne Canary | bestanden | normal | 178.070 | 52,595 |

Alle vier Abrechnungen sind nativ abgeglichen, die geschützte Einrichtung blieb
unverändert, Eingriffe während der Sitzungen: null, Anbietergebühren: 0 USD.
H2 schließt nun korrekt mit tatsächlichem Hook-Pass ab. H1 bleibt als gescheiterte
Sitzung enthalten, obwohl die Funktion korrekt war und der Fehlblock anschließend
im Produkt behoben wurde. Die installierte Fehlerfallprüfung repariert nicht
nachträglich dieses native Ergebnis.

In diesem kleinen Vergleich benötigen die Canary-Arme insgesamt 1.946.282 Tokens
und 613,068 Sekunden gegenüber 209.865 Tokens und 92,356 Sekunden ohne Canary.
Das sind ungefähr 9,27-mal so viele Tokens und 6,64-mal so viel Zeit. Ein Teil
des zusätzlichen Aufwands betrifft Regressionstests, die ohne Canary nicht in
gleichem Umfang geschrieben wurden; eine allgemeine Ersparnis ist nicht belegt.
Die native Alltagserleichterung des **letzten** korrigierten Pakets wurde nicht
erneut gemessen. Auf Wunsch folgen jetzt keine weiteren Pilotrunden.

Offen bleiben insbesondere:

* Der vollständige Vergleich aller sechs Aufgaben mit zwölf Sitzungen ist nicht
  abgeschlossen. Refactrons festgelegte Ausgangstests scheitern bereits ohne
  Canary; eine funktionierende Einrichtung für diesen Ausgangsstand fehlt.
* Die Ursache des älteren Windows-Prozessüberwachungsfehlers ist weiterhin offen;
  die vereinbarte Grenze von 30 zusätzlichen Diagnoseversuchen wurde eingehalten.
  Grüne Kontrollserien werden nicht als Ursachenklärung ausgegeben.
* LOCAL bleibt eine Grenze gleicher Benutzerrechte: derselbe Benutzer kann auch
  Prüfplan und Baseline neu versiegeln. Agententests sind keine unabhängige Autorität.

**Abschluss:** Überprüfbare Produktkorrekturen, vollständige Codeprüfungen und
ein geprüftes installiertes Paket sind geliefert. Der breitere 8/10-Praxisnachweis
bleibt offen; das Ziel wird auf ausdrücklichen Wunsch nach diesem Bericht pausiert.
