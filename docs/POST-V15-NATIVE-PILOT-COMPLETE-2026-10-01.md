# Canary: Ergebnis der zwölf nativen Sitzungen

1173 Rohdateien gegen SHA-256 geprüft. Native API-Zähler stimmen in **12/12** Sitzungen mit Claudes vollständigem Modellzähler überein. Anbieterrechnung: **0 USD**, lokales qwen3.5:9b.

| Sitzung | Ursprünglich korrekt | Mit H1-Nachprüfung korrekt | Normal beendet | Stop PASS | Input | Output |
|---|---|---|---|---|---:|---:|
| H1-plain | true | true | true | false | 419095 | 14015 |
| H1-canary | true | false | true | false | 959633 | 20437 |
| H2-canary | true | true | true | true | 754257 | 14664 |
| H2-plain | true | true | true | false | 52052 | 4510 |
| H3-plain | true | true | true | false | 325475 | 8456 |
| H3-canary | true | true | true | true | 1166053 | 12409 |
| H5-canary | true | true | true | true | 201529 | 3569 |
| H5-plain | true | true | true | false | 29399 | 1936 |
| R1-plain | true | true | true | false | 180980 | 6093 |
| R1-canary | false | false | false | false | 1412037 | 20416 |
| S1-canary | true | true | true | true | 326745 | 8036 |
| S1-plain | true | true | true | false | 192402 | 6302 |

- plain: **6/6 korrekt**, 6/6 normal beendet, 0/6 mit bestandenem Stop-Hook; 1240715 native Input- und Outputtokens.
- canary: **4/6 korrekt**, 5/6 normal beendet, 4/6 mit bestandenem Stop-Hook; 4899785 native Input- und Outputtokens.

Canary/plain: 3.95 × Tokens in diesem Pilot, einschließlich der fehlgeschlagenen Sitzung. Das ist keine allgemeine Kostenprognose.

Die H1-Altersfälle wurden nachträglich ergänzt; die ursprüngliche Prüfung bestand in beiden Armen. Canary meldete H1 unproven. R1 mit Canary scheiterte an einer veränderten öffentlichen API und am Schrittlimit; ein früherer doctor-PASS war kein Abschlussbeleg. Der frühere abgebrochene und vom Operator gestoppte Versuch ist separat dokumentiert und zählt nicht zu diesen zwölf Sitzungen.

CLI SHA-256: `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`. Modell-Digest: `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`. Produkt und Aufgaben blieben gleich; die vollständige Modellabrechnung wurde zwischen den zehn Hauptsitzungen und S1 korrigiert. Instrumenthashes: `f06133fff57993b989ae7026c0f2245a7d34537d293dd14f3ebb4d28607deb16`, `40b62be730fd6188f7ed487be741abd6b975b940186ed077de8dd8711aa9bec7`. Ein kontinuierlicher Lauf mit nur einer Instrumentenversion wird nicht behauptet.

Rohbelege: `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-local-paired-20261001-bounded`, `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-local-paired-20261001-S1`, `C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-local-paired-20261001-postchecks-final`. LOCAL bleibt dieselbe Benutzeridentität; experimentelle Werkzeugregeln sind keine Betriebssystem-Isolation.

Der Pilot rechtfertigt keine höhere Produktbewertung. Der nächste Produktansatz ist, wiederholte Prüfungen und Versuche zum Neuversiegeln durch eindeutige Agentenhinweise zu reduzieren. Eine Verbesserung muss an neuen, separat ausgewiesenen Sitzungen beobachtet werden.
