# Canary: nachgewiesener Fortschritt des Reparaturplans

## Ergebnis

Die geplante Schwelle von mindestens 25 % kürzerer medianer Reparaturprüfzeit ist auf **beiden Projekten erreicht**. Gemessen wurden fünf Wiederholungen je Variante nach einem ausgeschlossenen Aufwärmlauf, mit wechselnder Reihenfolge. Es sind kontrollierte Bedienabläufe ohne Modellaufrufe.

| Projekt | Vor Plan: vollständiger Check | Jetzt: gezielter Check | Weniger Zeit | Ausgeführte Checks |
|---|---:|---:|---:|---|
| Hermes | 1.875 s | 1.043 s | 44.4 % | 2 → 1 |
| Refactron | 124.124 s | 2.337 s | 98.1 % | 3 → 1 |

Die Ersparnis gilt für die **erneute Prüfung einer bekannten Reparatur**, nicht für den gesamten Arbeitsauftrag. Ein vollständiger Check bleibt am Ende erforderlich. Hermes erhielt vor dem Versiegeln in beiden Varianten seinen vorhandenen echten Server-Smoke-Test zusätzlich als e2e; sein Standardplan besitzt sonst nur einen Check. Es wurden keine Wartezeiten oder künstlich langsamen Prüfungen hinzugefügt. Refactron verwendet seinen regulären Plan aus Typecheck, Tests und Build.

## Schutz und Einrichtung

- Beide Projekte: eingebauter Fehler abgewiesen, reparierter Check bestanden; anschließend unabhängiger Fehler im anderen Check, grüner Teilcheck PARTIAL, vollständige Prüfung weiterhin rot; nach Reparatur vollständig READY. Der Teilcheck ließ die vollständige Checkpoint-Datei bytegleich.
- Später Fehler beim Speichern der Autorität: vor dem Plan blieben geänderte Integrationsdateien zurück; jetzt werden Claude-, Codex- und MCP-Dateien bytegenau wiederhergestellt.
- Zweimaliger Setup-Neuversuch: Benutzereinstellungen und fremde Hooks/MCP-Einträge erhalten; genau ein Canary-Eintrag pro Harness.
- Ungültige Einstellungen bleiben unangetastet; ein roter Projektcheck behält die Integration und einen roten Checkpoint. Diese Gegenfälle bestanden auch im Ausgangspaket; dafür wird keine neue Verbesserung behauptet.
- Kein manueller Eingriff während der Läufe. Eingebaute Fehler und Reparaturen wurden ausdrücklich durch das Versuchsprogramm vorgenommen.

## Eingefrorene Pakete und Rohbelege

Ausgangsstand: Commit 2171535496f4fda3af060c03449e6b1a65b6380f, Paket 530707e3cb6d293ec0e407a62235ac8aa2b028b10fc780c28b6e82f866d19b89, CLI 5a11bee704c569d3fb37937c3a3d947ba7531fe57c2f5b71a2a4c1a4c4c66728. Er wurde isoliert aus dem exakten Commit rekonstruiert; Paket und CLI stimmen mit den früher archivierten Prüfsummen überein.

Verbesserung: Produktquelle dd017c4, Paket 806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975, CLI 9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659. Beide zeigen Version 1.5.0; der Verbesserungsstand ist unveröffentlicht. Kein Rückgriff auf einen Entwicklungsbuild.

- Hermes: C:\Users\Johannes\Desktop\canary\_canary-data\evidence\focused-repair-timing-20261001, Instrument 233f9b52a0a05e873578c596fc2be1bb6b306f1226b8e8a784aa92ae808ccc2f. Der übergreifende Erstversuch ist **unvollständig**: sein Refactron-Testfehler lag außerhalb der Typecheck-Eingaben. Nur die abgeschlossenen Hermes-Messungen und Gegenfälle werden verwendet.
- Refactron: C:\Users\Johannes\Desktop\canary\_canary-data\evidence\focused-repair-timing-20261001-Refactron, korrigiertes Instrument dbcb3dfaef99f4698bfab13b89c9374ef1a422e28e840ac679f27fd5b74789c2. Der typisierte Testhelfer liegt im tatsächlich geprüften src/**; der separate Vitest-Test prüft denselben Wert. Nur Refactron wurde wiederholt.
- Setup: C:\Users\Johannes\Desktop\canary\_canary-data\evidence\setup-recovery-compare-20261001, Instrument c3c2190dbad9dfb2b9780d50328a81cbd60b2a333fee91a548ce686f39e6658a.

**411 Rohbelegdateien** wurden von diesem Reporter erneut per SHA-256 geprüft; Mediane aus den Einzelmessungen neu berechnet. Alle ausgeführten Befehle, Fehlerausgaben und Canary-Verifikationsbündel sind erhalten. Der abgebrochene Versuch wird nicht als insgesamt bestanden dargestellt.

## Einordnung

Das ist belegter Produktfortschritt bei Einrichtung und Reparaturschleife. Eine allgemeine Tokenersparnis ist weiterhin nicht nachgewiesen: der [native H3-Vergleich](POST-V15-IMPORTED-CHECK-NATIVE-2026-10-01.md) beendet nun korrekt, kostet aber erheblich mehr Tokens; [Refactron](POST-V15-REFACTRON-NATIVE-FOLLOWUP-2026-10-01.md) liefert eine korrekte Lösung, erreicht jedoch keinen normalen Agentenabschluss. Der bezahlte Pilot ist laut diesem Plan keine Abnahmevoraussetzung.
