# Direkter Vergleich: veröffentlichtes Canary 1.5.0 und Verbesserungsstand

Sechs unabhängige Aufgaben auf Hermes, Refactron und Schniedelsmp, jeweils korrekte historische Lösung und bewusst wiederhergestellte fehlerhafte Implementierung. Beide Pakete bestehen **12/12 Kontrollen** und alle zwölf Einrichtungsprüfungen (sechs regulär, sechs mit Canary).

| Aufgabe | Ausgangscommit | Release: korrekt / alter Fehler | Verbesserung: korrekt / alter Fehler |
|---|---|---|---|
| H1 | `7d0eb49c46d83184638fa093b44a15222feb8c51` | pass / fail, Fehler blockiert | pass / fail, Fehler blockiert |
| H2 | `7d0eb49c46d83184638fa093b44a15222feb8c51` | pass / fail, Fehler blockiert | pass / fail, Fehler blockiert |
| H3 | `7d0eb49c46d83184638fa093b44a15222feb8c51` | pass / fail, Fehler blockiert | pass / fail, Fehler blockiert |
| H5 | `7d0eb49c46d83184638fa093b44a15222feb8c51` | pass / fail, Fehler blockiert | pass / fail, Fehler blockiert |
| R1 | `1fe40d8505bbb0cac703c976401c17213abf1e9d` | pass / fail, Fehler blockiert | pass / fail, Fehler blockiert |
| S1 | `4255fa14049b479b479be1148df20bf0d097926c` | pass / fail, Fehler blockiert | pass / fail, Fehler blockiert |

- Release: Paket SHA-256 `cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386`; CLI `3cfdfece2581b1036e1b01905be39d97161d03f683110cf40910570a5235d5e2`; 692 archivierte Dateien erneut bytegenau geprüft. Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/release-six-task-20261001-final`.
- Verbesserung: Paket SHA-256 `806ccdf0b5785e072d667dfa85f38f8d1a80f679b5834d4633a5b8b20cec1975`; CLI `9ee1d32408d7e33e8e50fb38cb14a75af196e464738f65b7dfa0d01981038659`; 692 archivierte Dateien erneut bytegenau geprüft. Rohbelege: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/improved-six-task-20261001-final`.

Instrumente, historische Lösungspatches, Ausgangscommits, Toolchain-Verzeichnisse und Zeitgrenzen stimmen zwischen den Varianten überein. H1 berücksichtigt zusätzlich eine Stunde alte Dateien und Bruchteile von Tagen; diese Ergänzung gehört zum nachträglichen Kontrollversuch, nicht zum ursprünglichen nativen Pilot. Alle Checkpoints stammen aus tatsächlichen CLI-Aufrufen. Es sind keine nativen Agentensitzungen; Sitzungsende oder Tokenersparnis wird hier nicht gemessen.

Dieser Vergleich zeigt, dass die bestehenden sechs Abläufe funktionieren. Der zusätzliche [H3-Nachweis](POST-V15-IMPORTED-CHECK-REPAIR-2026-10-01.md) zeigt die behobene falsche Blockade am Release. Die zwölf ursprünglichen Pilotsitzungen bleiben unverändert; eine höhere Produktbewertung braucht einen neuen Nachweis weniger Eingriffe oder kürzerer autonomer Arbeit.
