# Canary 1.5: lokaler Paarversuch und gezielte Produktkorrektur (2026-09-28)

## Ergebnis und Reichweite

Zwölf frische Sitzungen mit einem lokalen Modell wurden beendet: sechs Aufgaben jeweils ohne und mit Canary. Der unabhängige Aufgabencheck bestand in beiden Varianten bei H1, H2 und S1; H3, H5 und R1 scheiterten in beiden Varianten. Damit zeigt dieser Versuch **keinen gemessenen Korrektheitsvorteil** durch Canary. Der produktive Nutzen rechtfertigt weiterhin **6/10**; die technische Bewertung bleibt **8/10**. Eine 8–9/10 ist mit diesen Daten nicht begründet.

Dies ist ein Ersatzversuch mit `qwen3.5:9b` und einem kleinen lokalen Datei-Agenten. Er hatte Lese- und Schreibwerkzeuge, aber keine Shell und kein MCP. Canary wurde nach den Modellantworten durch den Versuchsaufbau per `checkpoint` angestoßen; in keiner Canary-Sitzung feuerte ein nativer Claude-Code-Stop-Hook. Die gemessenen Token stammen direkt aus Ollama, sind aber weder mit Claude-Token noch mit US-Dollar-Kosten gleichzusetzen. Der geplante bezahlte Claude-Code-Vergleich bleibt wegen der nicht verlässlich begrenzbaren Drittanbieterabrechnung ausstehend.

## Versuchsstand

- Sechs unabhängige Aufgabenstarts aus drei Projekten: H1, H2, H3, H5 in Hermes_Agent, R1 in Refactron und S1 in schniedelsmp. Die Reihenfolge der Varianten wechselte zwischen Aufgaben. Ausgangscommits, Toolchain-Pfade, Befehle, Ausgaben und getrennte Orakel stehen in den Rohbelegen.
- Vor jedem Paar wurden Projektchecks und Canary-Einrichtung ohne Modellaufrufe geprüft. Hermes benötigte keine zusätzlichen Toolchain-Verzeichnisse; Refactron vier Verzeichnisse für Python 3.11 und Git, schniedelsmp zwei für Java 21 und Gradle 8.13. Alle zwölf Vorbereitungen wurden abgeschlossen. Die Vorbereitung selbst benutzte kein Modell; ihr damaliges Feld `model: qwen3.8-flash` war ein Beschriftungsfehler und wurde im Skript für künftige Läufe auf `null` geändert. Das Sitzungsmanifest und die Laufzeitbelege nennen das tatsächlich verwendete Modell.
- Verglichen wurde das isoliert installierte Canary-1.5.0-Paket mit SHA-256 `8243f3fc0c1f15fd5ec9977ba4ba240af5aeea1a4ff4d2c3027dd89fac8caf25` und CLI-Datei-SHA-256 `ba741bbeaa5d513b50e96385b999c7b0cf82392f9ae85e5f046f45f360e4ed7a`. Das Paket ist ein Verbesserungsstand nach dem veröffentlichten 1.5.0-Paket, dessen SHA-256 `cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386` war. Dieser Paarversuch ist **kein direkter Release-gegen-Verbesserungsstand-Vergleich**.
- Agent: `ollama-native-agent 1.0.0`; Modell `qwen3.5:9b`, beobachteter Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`. Das Manifest enthält die SHA-256-Werte für Runner, Aufgaben-Orakel und Agent sowie die expliziten CLI-Pfade. Für jede Sitzung liegen native Tokenzahlen, Laufzeit, Git-Diff, Checkpoint-Ereignisse und Orakelbericht vor.

| Aufgabe | Ohne Canary: Orakel / s / Eingabe+Ausgabe-Token | Mit Canary: Orakel / s / Eingabe+Ausgabe-Token | Canary-Nachweis |
| --- | --- | --- | --- |
| H1 | pass / 47,3 / 5.579+1.796 | pass / 127,8 / 35.282+6.582 | nach Block und Reparaturversuch unbewiesen |
| H2 | pass / 41,0 / 8.033+1.453 | pass / 62,9 / 18.294+2.547 | nach Block und Reparaturversuch unbewiesen |
| H3 | fail / 76,4 / 5.388+3.619 | fail / 76,6 / 5.518+3.576 | versiegelter Plan grün, Aufgabe ungelöst |
| H5 | fail / 75,1 / 5.417+3.594 | fail / 75,9 / 5.593+3.551 | versiegelter Plan grün, Aufgabe ungelöst |
| R1 | fail / 60,9 / 14.677+2.632 | fail / 244,1 / 2.603+6.627 | versiegelter Plan grün, Aufgabe ungelöst |
| S1 | pass / 65,9 / 40.422+2.977 | pass / 71,8 / 20.452+3.124 | bestanden, mit Hinweis auf vom Agenten umgeschriebenen Test |

Die Summen betragen ohne Canary 366,6 Sekunden Agentenlaufzeit und 79.516 Eingabe- plus 16.071 Ausgabe-Token, mit Canary 659,1 Sekunden und 87.742 Eingabe- plus 26.007 Ausgabe-Token. Diese kleine Stichprobe erlaubt keine allgemeine Aussage zu Tempo oder Tokenersparnis. Bei H1/H2 war die Blockade sachlich begründet: Die versiegelten Tests unterschieden Ausgangsstand und Änderung nicht. Bei H3/H5/R1 gab es keine wirksame Quelländerung; ein grüner Prüfplan bescheinigt keine Erfüllung der Aufgabenbeschreibung. Bei S1 wurde die Herkunft des vom Agenten umgeschriebenen Tests korrekt als Einschränkung angezeigt.

Ein erster Lauf mit derselben Aufgabenreihe brach nach 9/12 Sitzungen bei R1 mit einem Ollama-HTTP-500-Fehler ab und war ungültig. Er deckte außerdem einen Auswertefehler auf: Canary kann eine erlaubte Beendigung mit Exit 0 und leerem stdout melden; dies zählt nur zusammen mit einem frischen `last-checkpoint.json` mit `status: pass` als bestanden. Der Runner wurde korrigiert, gezielt getestet und der zwölfteilige Versuch von frischen Aufgabenstarts vollständig wiederholt. Der abgebrochene Lauf ist getrennt archiviert und nicht in der Tabelle enthalten.

## Gezielte Verbesserung nach dem Paarversuch

Die H1/H2-Agenten legten zusätzliche Testdateien an, die das gebundene `npm test` gar nicht ausführte. Canary blockierte korrekt, gab aber keine konkrete Anweisung, wo die nötige Regression einzubauen war. Die Rückmeldung nennt den pro Schritt digestbestätigten `package.json`-Testeintrag und erklärt, dass neue Testdateien nur zählen, wenn dieser Eintrag sie ausführt. Für argv-basierte Projekte nennt sie jetzt den exakten, gebundenen Befehl; ein Python-`unittest`-Fall prüft diese Rückmeldung. Ein nachträglich geänderter Plan zeigt den fremden Befehl nicht an. Ein gezielter Regressionstest deckt beide Pfade und die Autoritätsdrift ab.

Zwei frische H1/H2-Wiederholungen nutzten ein neu gepacktes und installiertes CLI-Paket (SHA-256 `f8c5eda314812618e5dc69f33b55143f6fd3bff373e2a3d31dc7e7d7196c1d5e`). Beide Agenten änderten nun tatsächlich `scripts/smoke-test.js`, den ausgeführten Testeinstieg. Die Quellkorrekturen bestanden die unabhängigen Orakel. Die selbst geschriebenen Testergänzungen waren jedoch fehlerhaft; Canary meldete jeweils einen Testfehler und ließ den Abschluss nach einem Reparaturversuch nicht als bestanden erscheinen. **Die Rückmeldung änderte das beobachtete Verhalten, verbesserte in diesen zwei Wiederholungen aber weder die Abschlussquote noch die Blockzahl.** Der spätere argv-Pfad erweitert die Anweisung auf Projekte mit expliziten Befehlen; ein neuer Modellpilot dafür ist noch ausstehend.

## Nachprüfbarkeit und nächste Produktfrage

Die 750 exportierten Rohbelegdateien liegen außerhalb von Git unter `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\post-v15-ollama-native-20260928`; `export-manifest.json` enthält SHA-256 für jede Datei. `paired-pilot/pilot-summary.json` ist der Einstieg in den vollständigen Zwölfervergleich. `invalid-pilot/` dokumentiert den abgebrochenen Versuch, `guidance-runs/` und `guidance-oracles/` die zwei gezielten Wiederholungen. Projektkopien und vollständige Agententranskripte werden nicht in das öffentliche Repository übernommen.

Der nächste Produkthebel ist ein verlässlicherer Abschluss nach einem begründeten Block: Der Agent muss erkennen, welcher bereits gebundene Test wirklich läuft, eine gültige Regression schreiben und sie reparieren können. Der Pilot zeigt außerdem die Grenze grüner Checks bei unbearbeiteten Aufgaben. Beides sollte in einem echten Claude-Code-Vergleich mit nativem Hook, Shell- und MCP-Zugriff erneut gemessen werden, sobald ein zulässiger Anbieterzugang mit belastbarer Ausgabenobergrenze vorhanden ist. Bis dahin ist der lokale Vergleich ein eng begrenztes Nutzungssignal, kein Nachweis allgemeiner Alltagstauglichkeit.

## Abschlussprüfungen und finales Paket

- `npm test`: 1.303 Tests, **1.299 bestanden, 0 fehlgeschlagen, 4 übersprungen** (458,2 Sekunden). Übersprungene Tests zählen nicht als bestanden.
- `npm run verify:productization`: **103 PASS, 6 SKIP, 1 FAIL**. Der einzige Fehler war die Alltagstext-Schranke: die erweiterte Node-Anleitung verwendete 14 statt höchstens 13 interner Begriffe. Die Formulierung wurde anschließend auf „that suite or command“ gekürzt. Der isolierte Probe `node tooling/probes/v13-everyday-vocabulary.mjs` bestand danach mit 12/13; der vollständige Productization-Lauf wurde nach dieser reinen Textkorrektur nicht erneut gestartet. Die sechs SKIPs betrafen fehlende Go- und Rust-Toolchains, die fehlende OS-PTY für zwei Akzeptanzprobes und zwei Live-Claude-Probes ohne verlässlich durchsetzbares Ausgabenlimit. Der Codex-Stop-Hook, Windows-Prozessprüfung, Quell- und gepackte Architekturmatrizen, Mutationsbatterien, Installations- und Vertrauensgrenzenprüfungen liefen durch. Alle 13 Master-Pass-Mutationen und 13 Architekturmutationen wurden erkannt; die Vertrauensgrenzenbatterie erkannte 14/14 Mutationen.
- Nach der Textkorrektur: `npm run build`, der gezielte Completion-Regressionstest (**9/9**) und die Alltagstext-Schranke (**12 Begriffe bei Budget 13**) bestanden.
- `git diff --check`: bestanden.
- Abschließender lokaler Pack-Befehl: `node tooling/pack.mjs` bestanden. Das erzeugte `@canary-rn/cli@1.5.0`-Paket wurde separat offline installiert; dessen expliziter CLI-Pfad gab `canary 1.5.0` aus. Paket-SHA-256: `530707e3cb6d293ec0e407a62235ac8aa2b028b10fc780c28b6e82f866d19b89`. Installierte `dist/main.js` SHA-256: `5a11bee704c569d3fb37937c3a3d947ba7531fe57c2f5b71a2a4c1a4c4c66728`.

Die Gates belegen Paketierung, lokale Installation, technische Vertrauens- und Abschlussregeln. Sie ändern den praktischen Pilotbefund nicht: Für die sechs Aufgabenpaare wurde kein zusätzlicher korrekter Abschluss mit Canary gemessen. Die Produktnote bleibt deshalb **6/10**, die Techniknote **8/10**. Der Branch ist ein überprüfbarer Verbesserungsstand, keine Veröffentlichung.
