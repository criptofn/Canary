# Canary 1.5: praktische Validierung, 27.09.2026

## Ergebnis in einem Satz

Ein echter Vergleich auf einer Aufgabe belegt keinen Korrektheitsvorteil durch Canary: beide Varianten lieferten die richtige Änderung. Er hat aber einen konkreten Produktfehler offengelegt: `doctor` zeigte `READY`, ohne den im Nachweis gespeicherten Hinweis sichtbar zu machen, dass der Agent den entscheidenden Test selbst umgeschrieben hatte. Diese Anzeige ist korrigiert.

## Vergleich

Beide Sitzungen bearbeiteten unabhängig voneinander `refactor-preserve` vom selben Fixture-Commit (`4e274ae4418b63c96a087afad19c1615ff3e738d`). Eingabe, Modell (`gpt-5.6-sol`), Reasoning-Stufe (`low`) und Schreibrechte waren gleich. Der Agent arbeitete einmal ohne Canary und einmal mit Canarys Codex-Stop-Hook.

| Messwert | Ohne Canary | Canary-Stop-Hook |
|---|---:|---:|
| Laufzeit | 101 s | 90 s |
| sichtbare Projekttests | 6/6 | 5/5 |
| unabhängiges Orakel | 16/16 | 16/16 |
| Eingabetokens | 211.833 | 160.768 |
| davon Cache-Eingabe (Teilmenge) | 191.744 | 145.280 |
| Ausgabetokens | 2.990 | 2.794 |
| Reasoning-Ausgabe | 931 | 811 |
| Fertigmeldung | ja | ja |

Die Testzahlen unterscheiden sich, weil die Agenten ihre neuen Fälle unterschiedlich aufteilten. Beide änderten Tests; keiner entfernte die vorhandenen Testfälle. Das unabhängige Orakel ist in beiden Läufen identisch bestanden. Damit gibt es in diesem Paar keinen nachgewiesenen Korrektheitsgewinn. Die niedrigeren Tokenzahlen der Canary-Sitzung sind eine Einzelmessung und kein belastbarer Sparnachweis.

In der Canary-Sitzung lief der Hook. Der gespeicherte Befund war `status=pass`, `hookResponse=message-and-continue`, `sessionEnd=unknown`. Der Hinweis zur Herkunft des umgeschriebenen Tests war im `doctor`-Ergebnis vor dem Fix nicht sichtbar. Das erzeugte ein unnötig starkes `READY`-Signal.

## Produktkorrektur

`doctor` gibt nun alle vorhandenen Nachweis-Hinweise sichtbar aus. Im JSON-Modus bleibt JSON auf stdout; der menschenlesbare Hinweis erscheint auf stderr. README erklärt, dass ein vom Worker formulierter oder umgeschriebener Test zwar auf die Änderung reagieren kann, aber keine unabhängige Autorität ist.

Der neue Regressionstest wurde zuerst gegen den unveränderten Code ausgeführt und scheiterte, weil der Hinweis fehlte. Nach dem Fix prüft er sowohl die menschenlesbare Ausgabe als auch den JSON-Vertrag und besteht.

## Weitere Prüfungen

- `npm test`: 1.288 bestanden, 0 fehlgeschlagen, 4 übersprungen.
- `npm run verify:productization`: Exit 0, **104 PASS, 6 explizite SKIP, 0 FAIL**. Die vollständige Regressionsevidence-Suite dieses Branches bestand 7/7.
- Weitere gezielte Kontrollen bestanden: Windows-8.3-`TEMP`-Suite 5/5; Windows-Prozessbereinigung 12/12; Herkunftsnachweise 7/7; Master-Pass-Mutationen 13/13; Trust-Mutationen 14/14; Architekturmatrix 39/39 und Architekturmutationen 13/13; Produktionsautorität 54/54 mit 57/57 blockierten Angriffen und 45 Positivkontrollen.
- Die Skips bleiben sichtbar: zwei Live-Claude-Messungen wurden wegen der nicht begrenzbaren Providerkosten nicht gestartet. Vier hostgebundene Prüfungen blieben aus: zwei benötigen ein echtes OS-PTY, zwei benötigen die fehlenden Go-/Rust-Toolchains. Die beiden PTY-Probes führten ihre verfügbaren Produktprüfungen über den In-Process-Treiber aus, belegen aber keine OS-PTY-Zuteilung.

## Grenzen dieser Aussage

- Es ist ein Aufgabenpaar (`n=1`), keine Aussage über breite Alltagstauglichkeit.
- Der Live-Vergleich verwendete Codex CLI 0.154.0 mit `gpt-5.6-sol`, als Ersatz für den geplanten Claude-Code-Pilot. Benutzer-MCPs und Plugins waren für die gewerteten Läufe ausgeschaltet. Ponytail war über die globale Benutzerkonfiguration verfügbar und wurde während dieser Arbeit aufgerufen; ein Einfluss auf das Live-Ergebnis lässt sich nicht ausschließen.
- Der Dollarverbrauch und eine harte USD-Grenze waren über die Codex-Kontoabrechnung nicht beobachtbar. Das gewertete Aufgabenpaar nutzte zusammen 372.601 Eingabe-, 337.024 Cache-Eingabe-, 5.784 Ausgabe- und 1.742 Reasoning-Tokens. Ein vorheriger, wegen globaler MCP-/Plugin-Kontexte ausgeschlossener Lauf verbrauchte weitere 159.483 Eingabe- und 2.856 Ausgabetokens. Über alle abgeschlossenen Läufe weist das CLI 532.084 Eingabe-, 471.936 Cache-Eingabe-, 8.640 Ausgabe- und 2.604 Reasoning-Tokens aus. Cache-Eingabe ist jeweils in Eingabe enthalten. Die Nutzungsdaten stehen in der [Manifest-Datei](../tooling/benchmark/results/session-evidence/codex-pilot-20260927/manifest.json).
- Das Live-Aufgabenpaar meldete Canary 1.5.0 und wurde aus dem lokalen Quellstand `223595e0bb08ad2db17c8103ac26d5d6dce5a0d2` gestartet. Es belegt keine Byte-Identität mit dem veröffentlichten Paket. Die konkrete `doctor`-Regression wurde danach zusätzlich mit dem installierten GitHub-Release-Paket geprüft: Paket-SHA-256 `cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386`, installierte CLI-SHA-256 `3cfdfece2581b1036e1b01905be39d97161d03f683110cf40910570a5235d5e2`. Eine frische Fixture wurde mit genau diesem Build eingerichtet und die Änderung aus dem Live-Lauf erneut angewendet. Der Release-`doctor` zeigte wieder `READY` ohne den Herkunftshinweis; die Ausgabe steht in [`doctor-on-published-1.5.0.txt`](../tooling/benchmark/results/session-evidence/codex-pilot-20260927/doctor-on-published-1.5.0.txt).
- Ein separater 120-Zellen-Versuch mit dem bestehenden Claude-Benchmark startete keinen Agentenlauf: alle Zellen endeten vor dem Modellaufruf, als der Harness `git init` mit `ENOENT` nicht starten konnte. Das ist ein Instrumentierungs-/Umgebungsfehler und zählt nicht als Canary-Ergebnis. Rohdaten stehen in [`bench-2026-09-27T19-54-55-935Z.md`](../tooling/benchmark/results/bench-2026-09-27T19-54-55-935Z.md).

## Bewertung

Die Produktbewertung bleibt bei **6/10**. Ein bestätigter Vertrauenshinweis ist jetzt sichtbar, aber das eine korrekte Aufgabenpaar zeigt keinen Nutzen bei der Korrektheit oder beim Aufwand. Für eine belastbare Anhebung fehlen wiederholte Live-Paare auf dem verbesserten Build und ein abrechenbarer bzw. begrenzbarer Kostenkanal.

Die technische Bewertung bleibt bei **8/10**. Dieser Fix verbessert die Ehrlichkeit der Ausgabe, ändert aber die zugrunde liegende Prüf- und Sicherheitsarchitektur nicht.
