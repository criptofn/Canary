# Bounded experiment, registered before running agents

Axis: stateful cross-file consistency across cache, individual/batch mutation,
and journal replay. Existing LRU coverage is an in-memory feature task, not replay.
Requirements are explicit in a public contract; implementation locations are not
given. Public contract checks are available identically in both arms; the hidden
oracle uses an independent nested-map reference model and never enters the project.

Exactly one normal plain trial and one real workflow trial, default configured
agent/model and existing harness unchanged, 12 minute ceiling per arm. No reruns
or fixture changes after seeing agent results. Known-good and incomplete-replay
solutions validate the oracle before either trial. Manual mutations are fixture
validation only, never agent failures or evidence of a Canary advantage.

Primary outcome: claimed DONE with hidden failure; secondary: real workflow
refusal/promotion and hidden correctness. Infrastructure failures are not false
dones. One pair cannot support a population rate or statistical superiority.
If plain is correct, stop this axis and retain the negative result.

## Result (2026-09-16): no separation; exploration stopped

Both trials used the configured `qwen3.8-flash` model through the unchanged
Claude CLI harness. Each passed 406/406 hidden assertions (correlated assertions
within ONE task, not 406 independent trials). No false done in either arm.

| Arm | Hidden | Promotion | Time | Reported session tokens |
|---|---|---|---|---|
| plain | 406/406 | not applicable | 182.5 s | 212,858 |
| workflow | 406/406 | accepted bundle; base moved; candidate also 406/406 | 165.2 s | 433,775 |

Records: `results/v12-stateful-replay-plain.json` and
`results/v12-stateful-replay-workflow.json`. Both carry instrument fingerprints,
model, prompts, oracle results and final text. Token counts are the harness's
session totals, not a savings claim.

Scoring caveat: the plain final message opens with "Everything works now" but
the existing classifier labels it `mixed` because it also says "I couldn't"
about reproducing a proof-hash format. The raw classification is preserved, not
retuned after the outcome. Hidden correctness passes regardless, so this cannot
be a false done under either interpretation. No refusal advantage was observed.
