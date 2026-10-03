# Canary: eingefrorener Pilot nach den Produktkorrekturen

## Messstand

Zwölf native Claude-Code-Sitzungen, sechs unabhängige Aufgaben auf drei Projekten. Canary-Paket SHA-256 `1b080c1347a05e9046a8c6f38527944f7f7f4aacb8bf7d5c8a151873befca29c`; CLI `3d7dc38dbd2157caf09afb68f643d43864f54dc45fc08cefcd0faae54b7a19d8`. Unveröffentlichter Arbeitsstand, Versionsanzeige 1.5.0.

Claude Code 2.1.278, Ollama 0.33.2, lokales `qwen3.5:9b`, Digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`. Kontext 65536, Ausgabegrenze 4096, effort low, maximal 50 Turns und 30 Minuten je Sitzung. Alle Anbietergebühren: 0 USD. Keine Cloud-Modellaufrufe. Innerhalb jedes Paars identische Aufgabe, Baseline, Modell und Rechte; Reihenfolge wechselt zwischen Aufgaben. Alle zwölf Ausgangsprüfungen bestanden vor dem ersten Modellaufruf. H1s Bruchteile von Tagen waren vorab Bestandteil des Oracles.

Produkt, Aufgaben und Pilotinstrument blieben unverändert. Instrumenthash `54e98f7b89da0487fd5ce6747dc68d0fbd8c53db8119489a5431d228681ecdee`. Die unabhängigen Prüfprogramme wurden vor jeder Auswertung bytegeprüft. Es wurden keine historischen Lösungen gezeigt. LOCAL bedeutet gleiche Benutzerrechte, keine OS-Isolation.

## Ergebnisse des eingefrorenen Oracles

| Sitzung | Oracle korrekt | Normal beendet | Aktueller Stop PASS | Sekunden | Native Tokens |
|---|---|---|---|---:|---:|
| H1 plain | nein | ja | — | 30,387 | 23.155 |
| H1 Canary | ja | nein, Turn-Limit | nein | 350,981 | 1.363.971 |
| H2 Canary | ja | ja | ja | 75,307 | 125.149 |
| H2 plain | ja | ja | — | 21,646 | 38.749 |
| H3 plain | nein | ja | — | 239,029 | 619.318 |
| H3 Canary | ja | ja | ja | 64,296 | 140.905 |
| H5 Canary | ja | ja | ja | 72,814 | 231.768 |
| H5 plain | ja | ja | — | 17,456 | 24.039 |
| R1 plain | ja | ja | — | 284,281 | 510.545 |
| R1 Canary | ja | ja | ja, Herkunftswarnung | 603,140 | 1.235.082 |
| S1 Canary | ja | ja | ja | 81,414 | 118.069 |
| S1 plain | ja | ja | — | 77,108 | 181.331 |

Die Sekunden stammen aus den tatsächlichen Sitzungszeitstempeln. Kein manueller Eingriff in die zwölf Sitzungen. Vier MCP-Aufrufe insgesamt, in H2 und H3; ihre Modellabrechnung gehört zu den vollständigen nativen API-Zählern. Sämtliche API-Input-/Outputwerte stimmen mit Claudes vollständigem Modellzähler überein, einschließlich zusätzlicher Modellaufrufe. Es wurden keine Tokens geschätzt.

Canary: 3.214.944 Tokens, 1247,952 Sekunden. Plain: 1.397.137 Tokens, 669,907 Sekunden. Das entspricht in diesem einen Pilot rund 2,30-mal Tokens und 1,86-mal Laufzeit. Keine allgemeine Kosten- oder Tokenersparnis.

H1s gespeichertes `pass` stammt aus der Einrichtung (`source: doctor`), nicht aus der Aufgabe. Es gibt keinen neuen Stop-Checkpoint. `canary result` kennzeichnet diesen Datensatz ausdrücklich als historisch und meldet CONNECTED, keine aktuelle Verifikation. Der Auditreport lässt `currentStatus` deshalb leer. Die ursprünglichen Rohfelder bleiben unverändert.

In den fünf erfassten Stop-Abschlüssen gab es keine Blockentscheidung. Damit zeigt dieser Pilot keine natürlich entstandene Fehlerrückweisung durch den Stop-Hook. Die stärkeren Lösungen können mit Starthilfe, zusätzlicher Prüfung und Modellvariation zusammenhängen; ein einzelnes Paar beweist deren isolierte Ursache nicht. Die künstlichen Fehlerkontrollen bleiben ein eigener Nachweis.

## Zusätzliche Sichtprüfung: R1 ist nicht vollständig erfüllt

Beide R1-Lösungen wählen den letzten ausgewogenen ` - `-Trenner und übernehmen dadurch einen Teil der Fehlermeldung in die Test-ID. Beim selben parametrisierten Test liefern `ValueError: a - b` und `ValueError: x - c` unterschiedliche IDs. Das widerspricht der ausdrücklich verlangten Stabilität zwischen Läufen.

Der separate Gegenfall `v15-r1-stability-postcheck.mjs` bestätigt den Fehler in beiden Varianten mit einer tatsächlich gescheiterten Assertion. Er entstand **nach** dem Pilot und gehört nicht zum eingefrorenen Oracle. Dessen ursprüngliche Ergebnisse werden weder ersetzt noch nachträglich als umfassende Aufgabenkorrektheit ausgegeben. Der erste Gegenfall zeigte bereits die unerlaubte Fehlermeldung im ID-Text; der zweite variiert zusätzlich ihren Präfix und zeigt die Instabilität direkt. Beide Belege bleiben erhalten.

Mit dieser erweiterten Prüfung: Canary 5/6 korrekte Dateistände und 4/6 korrekte normale Abschlüsse; Plain 3/6 korrekte normale Abschlüsse. R1s bestandener Stop belegt die ausgeführten Checks und die unterscheidende Agententest-Evidenz, nicht sämtliche ungebundenen Aufgabenanforderungen. Die Warnung nennt diese Evidenz ausdrücklich als vom selben Worker verfasst und nicht unabhängig.

## Rohbelege und Grenzen

Evidenzwurzel: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/claude-build-order-native-20261003-six-job`.

- `capture`: unveränderte API-Anfragen/-Antworten, native Ereignisse, Aufgaben, Settings, Oracles, Diffs, Checkpoints und Zusammenfassung. 883 Dateien erneut bytegeprüft.
- `audited-report.json`: ausgeführter Report mit vollständiger Abrechnung und Trennung von historischem Status und aktuellem Stop.
- `worker-archive`: 242 archivierte Dateien, zwölf Arbeitsstände einschließlich Git-Historie und aller geänderten Dateien.
- `R1-stability-postcheck` und `R1-stability-postcheck-variation`: separate nachträgliche Gegenfälle und Rohausgaben.

Die zwölf eigenen temporären Projektkopien und Trust-Verzeichnisse wurden erst nach dem erneuten Bytevergleich aller 1125 Capture-/Archivdateien entfernt. Beide Archivwurzeln liegen außerhalb der entfernten Kopien und bleiben erhalten.

Das zeigt einen begrenzten praktischen Nutzen gegenüber Arbeit ohne Canary, aber keine allgemeine 8/10. Offen bleiben der unnötig aufwendige H1-Testaufbau und eine einfache, unabhängig gebundene Prüfung aller wichtigen Aufgabenanforderungen. Die sechsmal zwei künstlichen Kontrollen sowie die vollständigen Produkt-Gates sind im [Build-Bericht](POST-V15-BUILD-ORDER-2026-10-03.md) separat dokumentiert. Merge und Veröffentlichung bleiben getrennte Schritte.
