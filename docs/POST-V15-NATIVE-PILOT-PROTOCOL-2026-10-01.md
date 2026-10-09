# Native Claude: lokaler Pilot nach den Produktkorrekturen

## Eingefrorener Vergleich

Sechs Aufgaben (H1, H2, H3, H5, R1, S1), jeweils einmal ohne Canary und einmal mit dem installierten Verbesserungsstand. Die Reihenfolge wechselt pro Paar. Zwölf unabhängige, flache Git-Kopien enthalten nur den Ausgangscommit und gegebenenfalls den Canary-Setup-Commit. Historische Lösungen werden nicht übernommen.

Produktpaket: SHA-256 `ef2d79f37352626eb5547e22daaa1c20020bb2bb160fa9aa34b8a841735b5e34`. Installierte CLI: SHA-256 `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Kein Neubau oder Produktwechsel während der Sitzungen.

Claude Code 2.1.278 arbeitet über Ollama 0.33.2 mit `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`. Der lokale Server verwendet 65.536 Kontexttokens und `OLLAMA_NO_CLOUD=1`. Claude erhält ausdrücklich dieselbe Kontextgröße und maximal 4.096 Outputtokens. Werkzeugsitzungen verwenden `--effort low` und maximal 50 Agentenschritte. Diese zusätzliche Schrittgrenze ist eine dokumentierte Abweichung vom ursprünglichen reinen 30-Minuten-Limit, in beiden Varianten gleich. Tatsächliche API-Felder und native Endabrechnung bleiben sichtbar.

Das ist eine lokale Alternative zur noch nicht verlässlich begrenzbaren Drittanbieterabrechnung. Die Anbieterrechnung beträgt 0 USD; Rechnerkosten sind nicht gemessen. Der andere Modellstand begrenzt die Übertragbarkeit auf den ursprünglich geplanten kommerziellen Modellanbieter.

## Rechte und Prüfung

Read, Write, Edit, Bash, Glob und Grep stehen in beiden Varianten zur Verfügung. Setup/Bind/Accept-Befehle sowie direkte Änderungen an Prüf-/Hook-Konfigurationen werden durch die Claude-Werkzeugregeln abgewiesen. Diese Versuchsrechte verhindern versehentliche Änderungen; ein Prozess desselben Benutzers kann die Regeln umgehen. Die anschließende Hashprüfung bleibt deshalb erforderlich, und dies wird nicht als Canary-Härtung dargestellt. Erforderliche Java-/Python-/Git-Verzeichnisse sind pro Paar gleich. Im Canary-Arm sind ausschließlich die vorhandenen Everyday-MCP-Werkzeuge und der installierte Stop-Hook angeschlossen. Keine Subagenten. Jeder Lauf erhält ein frisches Claude-Profil, bereinigte Zugangsdaten und einen festen lokalen Modell-Gateway.

Vor dem ersten Modellaufruf werden alle Startzustände geprüft. Die externen Aufgabenprüfungen müssen den ursprünglichen Fehler beobachten. Ihre Programme und Ergebnisse liegen außerhalb der Arbeitskopien; sie werden dem Agenten nicht als Aufgabenlösung oder Testbeleg gezeigt. Unter gleichen Benutzerrechten ist das keine Betriebssystem-Isolation.

Nach jeder Sitzung laufen dieselben externen Prüfungen erneut. Die Agentensitzung darf neue Regressionstests schreiben. Paket-/Buildkonfiguration, Canary-Konfiguration und Hooks werden auf unveränderte Bytes geprüft; der ursprüngliche Git-Stand muss als Vorfahr erhalten bleiben. Änderungen und neue Dateien werden separat archiviert.

## Erfasste Ergebnisse

- Externe Korrektheit, Abschlussereignis, tatsächlicher Stop-Hook und Canary-Checkpoint getrennt.
- Native API-Input-/Output-Zähler einschließlich tatsächlich übertragenem Werkzeug- und MCP-Kontext, mit Gegenprüfung gegen Claude-Endabrechnung. Fehlende Zähler werden nicht geschätzt.
- Werkzeugaufrufe und Antworten, Berechtigungsabweisungen, Laufzeit, Schritte, geschützte Dateien und Eingriffe.
- Höchstens 30 Minuten und 50 Schritte pro Sitzung. Ein nativ abgerechneter Abbruch an der Schrittgrenze zählt als fehlgeschlagene Aufgabe, erlaubt aber die nächste kostenfreie Sitzung. Fehlende Abschluss-/Abrechnungsbelege oder veränderte geschützte Zustände führen zum dokumentierten Abbruch; unvollständige Sitzungen bleiben sichtbar.

Künstliche Reparaturkontrollen sind getrennte Vorabtests. Nur Fehler, die beim Bearbeiten der regulären Aufgaben entstehen, können als natürlich beobachteter Nutzen zählen. Eine grüne Sitzung allein beweist keinen Vorteil gegenüber der Sitzung ohne Canary.

## Ausführung und Grenzen

`tooling/probes/v15-pilot-prepare.mjs` rekonstruiert die Projektkopien und führt die kostenfreien Einrichtungsprüfungen aus. `tooling/probes/v15-claude-local-preflight.mjs --prepared-root <Vorbereitung>` führt den Pilot mit expliziten CLI-/Claude-/Ollama-Pfaden aus. Der Pfad wird nie stillschweigend durch einen Entwicklungsbuild ersetzt. `v15-claude-local-report.mjs` prüft die archivierten Hashes und erzeugt die Ergebnistabelle.

Die zuvor ausgeführten vollständigen Produkttests und `verify:productization` gelten für den unveränderten installierten Produktstand. Für die anschließenden Messprogramme wurden Parsertests und native End-to-End-Kontrollen ausgeführt. Eine neue vollständige Produkttestsuite wird wegen ausschließlich geänderter Messprogramme nicht als erneut ausgeführt behauptet.

Der erste Pilotstand wurde abgebrochen und separat erhalten; siehe `POST-V15-NATIVE-PILOT-ABORTED-2026-10-01.md`. Die Korrektur der Claude-Kontextgröße folgt der [offiziellen Dokumentation für unbekannte Modellkennungen](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id). Die neue Grenze und die native Schritt-Abrechnung werden vor dem erneuten Pilot mit echten Claude-Aufrufen geprüft. Die Einrichtungs- und Arbeitsarchive enthalten auch Agentencommits, jeweils im Vergleich zum ursprünglichen Setup-Commit.

Windows-Prozessüberwachung und die LOCAL-Vertrauensgrenze bleiben offene beziehungsweise bekannte Grenzen. Zwölf Sitzungen erlauben eine begrenzte Bewertung dieses Modells auf drei Projekten; sie begründen keine allgemeine Tokenersparnis und keine breite 9/10-Produktbewertung.
