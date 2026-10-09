# Ungültiger Ollama-Smoke-Test — 2026-09-28

**Status: INVALID — nicht als Modell- oder Canary-Ergebnis gewertet.**

## Versuchsaufbau

- Claude Code im nicht interaktiven Modus (-p) mit --model qwen3.5:9b.
- ANTHROPIC_BASE_URL zeigte auf http://127.0.0.1:11434, den lokalen Ollama-Endpunkt.
- Ollama 0.33.2; das lokal vorhandene Modell war qwen3.5:9b.
- Isoliertes temporäres Benutzerprofil, synthetischer Auth-Token, keine Proxys, leere MCP-Konfiguration und deaktivierter nicht notwendiger Telemetrieverkehr.
- Erwartet wurde die exakte Antwort LOCAL_OK. Der vollständige Prompt und eine rohe Antwortdatei wurden nicht gespeichert.

## Beobachtete Ausgabe

- Claude Code schrieb nach stderr: [claude-code:unrecognized_model] {"model":"qwen3.5:9b","query_source":"sdk"}.
- Der finale CLI-Text war eine allgemeine Begrüßung statt LOCAL_OK.
- Das finale JSON meldete provider=firstParty, führte qwen3.5:9b in modelUsage und meldete costUSD=0.01325.
- ollama ps zeigte nach dem Versuch qwen3.5:9b mit ungefähr 5,5 GB Speicher und 100 % GPU-Auslastung.

Diese Angaben widersprechen einander: Der konfigurierte lokale Ollama-Endpunkt und das geladene lokale Modell belegen nicht, dass die ausgegebene Antwort ausschließlich daraus kam. provider=firstParty und costUSD belegen umgekehrt keine tatsächliche Abbuchung; sie sind die vom CLI gelieferten Felder. Die tatsächliche Abrechnung und Antwortquelle bleiben daher unbekannt.

## Einstufung und Bereinigung

Der Modell-Smoke-Test hat seine Vorbedingung nicht erfüllt. Er zählt weder als lokale Modellsitzung noch als Pilotlauf und liefert keinen Produktnachweis. Die gemeldeten 0,01325 USD sind als CLI-Metadatum festgehalten, nicht als bestätigte Zahlung. Die genaue Abrechnung ist unbekannt.

Danach wurde das Modell mit ollama stop qwen3.5:9b gestoppt und der zuvor verifizierte Ollama-Server-Prozess beendet. Die anschließende Prozessprüfung fand keinen laufenden Ollama- oder llama-server-Prozess. Es wurden keine weiteren Modellaufrufe unternommen.

Die Rohantwort wurde nicht persistiert. Dieser Eintrag hält die während des Versuchs erfassten Terminalbeobachtungen und deren Unsicherheit fest.