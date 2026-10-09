# H1: Ursache des nicht abgeschlossenen nativen Versuchs

Auswertung der unveränderten `capture/H1-canary/record.json` unter
`C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-build-order-native-20261003-six-job`.
SHA-256: `aa0edf184d4bcca2af1442f09fba64e7d08a06fdcdce6ab63102a1d493d6243c`.

Der Verlauf enthält 51 Toolaufrufe: 23 Edit, 16 Bash, 11 Read und einen Glob.
Die Implementierung wurde bereits beim zweiten Toolaufruf geändert. Der weitere Aufwand
entstand überwiegend beim Aufbau und wiederholten Reparieren eigener Regressionstests:
fehlender fs-Import, falscher Methodenname fs.utime, ungültige Zeitwerte, Annahmen über
das Alter gerade angelegter Dateien und Vergleiche der Dateizahlen verschiedener Verzeichnisse.
Erst der vorletzte Bash-Aufruf meldet einen bestandenen Smoke-Test.

Der letzte Aufruf verwendet `canary doctor --check "previewOrganization-maxAgeDays-fix"`:
eine erfundene Check-ID und einen globalen CLI-Namen. Die aufgerufene Installation
verweigert die Konfiguration der eingefrorenen Installation. Der Versuchsagent verdeckt
den Fehler mit `|| echo`. Es gibt danach keinen normalen Abschluss und keinen Stop-Nachweis.
Dieser Aufruf ist kein Nachweis über `doctor` des eingefrorenen Pakets. Die separate
Hook-/MCP-Konfiguration und die übrigen Pilotwerte werden dadurch nicht umgeschrieben.

Der eingefrorene Stand enthielt bereits die SessionStart-Anweisung, die konkrete installierte
CLI anstelle eines globalen Canary-Befehls zu verwenden, die berichtete Check-ID zu übernehmen
und ohne erneutes Setup normal abzuschließen (Commit b4c3530d). Derselbe Mechanismus steht
im aktuellen Produkt. Eine Wiederholung dieser Anleitung wäre keine neue Produktkorrektur.

Die beobachtete Schleife liegt vor einer Blockentscheidung des Stop-Hooks. Sie beweist weder
eine unnötige Canary-Blockade noch, dass Canary den Verlauf verhindert hat. Testaufbaufehler
des lokalen Modells und der falsche CLI-Aufruf bleiben sichtbar. Keine Hermes-Datei wurde
für diese Analyse verändert; keine historische Lösung oder Oracle wurde nachträglich angepasst.

## Aktueller Pflichtcheck

Der Unit-Lauf auf Produktcommit 3af1a0e endete mit 1340 PASS, 4 SKIP und 0 FAIL.
Der anschließende Produktcheck hinterließ lediglich ein Teilprotokoll bis zum v1.4-Codex-Stop-Hook.
Sein Handle ist verschwunden; die unabhängige Prozessinventur fand keinen Gate-Produzenten.
Kein Abschlussreport und kein Exit-Nachweis: **unvollständig**, kein bestandener Gate-Lauf.
Das Teilprotokoll bleibt erhalten:
`proof-freshness-20261003-final-productization.log`, SHA-256
`622bf01dab0cbfdcba3073f7e974ddc1c0705c39d697802a6edac09b47761aa3`.

Der neue Messwrapper `v15-product-gate-job.mjs` ruft exakt das bestehende Gate-Skript auf
(Inhalt des npm-Alias), speichert stdout/stderr und den tatsächlichen Exit/Signal/Error separat.
Er verändert keine Produktprüfung oder Prüfgrenze. Ein gestarteter Hintergrundprozess ist
weiterhin kein Abschlussnachweis.
