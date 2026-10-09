# Post-v1.5 native local pilot

**Run:** 2026-10-08 23:53–2026-10-09 00:37 UTC. **Result:** complete, 12 sessions.

This was a paired, local-model pilot on frozen copies of Hermes_Agent, Refactron, and schniedelsmp. It did not modify those source projects. Raw session records and 1,163 SHA-256-verified evidence files remain in `C:\Users\Johannes\AppData\Local\Temp\canary-product-progress-pilot-results-20261009-01` on the measurement host; the evidence bundle was 34.67 MiB.

## Frozen tools

| Item | Version or SHA-256 |
|---|---|
| Canary CLI | 1.5.0; `f91d75ba3bd420f402bf750cda4986d1417bb451af8fbcd8f8c2e5628b48aab9` |
| Claude Code | 2.1.278 |
| Model | local Ollama `qwen3.5:9b`; digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7` |
| Instrument | `a1363306584a6140814874fe2774caeb75e35b08f625392874ab26b0c0dcdea5` |
| Provider charges | $0; no cloud model was used |

## Session results

“External” is the independent task oracle. A historical checkpoint is not a completion-hook result. Token counts are native API input + output, including transmitted tool context.

| Pair | Arm | External | Normal end | Stop hook | Canary result | Input + output tokens |
|---|---|---:|---:|---:|---|---:|
| H1 | Plain | pass | yes | — | — | 45,212 + 1,260 |
| H1 | Canary | pass | no | — | unproven | 1,084,066 + 10,218 |
| H2 | Plain | fail | yes | — | — | 15,721 + 518 |
| H2 | Canary | fail | no | — | historical pass only | 945,271 + 10,797 |
| H3 | Plain | pass | yes | — | — | 278,619 + 6,243 |
| H3 | Canary | pass | yes | pass | pass checkpoint | 243,817 + 4,980 |
| H5 | Plain | pass | yes | — | — | 23,048 + 746 |
| H5 | Canary | pass | yes | pass | pass checkpoint | 134,493 + 1,761 |
| R1 | Plain | pass | yes | — | — | 802,688 + 8,409 |
| R1 | Canary | pass | yes | ran | unproven | 1,354,179 + 16,303 |
| S1 | Plain | pass | yes | — | — | 225,611 + 5,693 |
| S1 | Canary | pass | no | — | historical pass only | 1,027,842 + 19,073 |

Plain completed normally in 6/6 sessions; Canary in 3/6. Independent correctness was 5/6 in each arm. Only 2/6 Canary sessions reached an actual passing Stop hook. Canary used 4,852,800 native tokens versus 1,413,768 for Plain (3.43×). One positive pair does not establish a general saving. On R1, preparation took 117 seconds for Plain and 113 seconds for Canary setup plus 112 seconds for its initial doctor run.

## Measurement defect and interpretation

The preflight command's Claude `--allowedTools` list omitted `mcp__canary__canary_task`. Attempts to register explicit task criteria were therefore denied in H1, H3, H5, and S1. R1 also attempted the unavailable unprefixed tool name `canary_task`. The cohort does **not** measure successful task intake or its effect on outcomes. The omission is corrected in `tooling/probes/v15-claude-local-preflight.mjs`; the product now also gives the agent a safe installed-CLI fallback when that MCP tool is unavailable.

The omission does not change the independent correctness results or erase the recorded Stop-hook behavior, but it limits what can be inferred about the complete MCP workflow. The local Qwen model is also not a substitute for a representative hosted Claude Code cohort. H1/H2/S1 hit the configured 51-turn ceiling; their historical checkpoints must not be described as final passes. R1's hook ran and remained unproven after the check summary changed from 0 to 10 skipped/pending tests. Those are conservative blocks, not successful Canary completions.

This pilot shows no correctness advantage and substantial overhead in this small cohort. It does not justify raising the product rating or claiming general token savings. A short, corrected MCP intake control should precede any larger repeat; rerunning all 12 sessions is not justified by these data alone.
