# The everyday token measurement, v1.5 — fully accounted

> ## WITHDRAWN v1.5 POST-AUDIT - DO NOT QUOTE THE FIGURES IN THIS BLOCK
>
> The v1.5 candidate published `83.21 % of Plain, -16.79 %`. That is **withdrawn**. An
> independent audit found the aggregate pooled a cell whose tokens came from the
> **fallback estimator** rather than the declared provider-native ledger; this closure
> then found the same class of defect again in the follow-up run (a tree edited
> mid-run, five instrument digests across six cells). Under the corrected accounting
> **no valid dataset supports a claim of token savings at all**. See *The withdrawn
> headline, and what replaced it* below. The block that follows is kept only as the
> record of what was claimed and why it failed.

> **Headline, with its limits attached — WITHDRAWN, kept only as the record of what was
> claimed and why it failed.** Over two independent runs of the same three
> fixtures, the everyday Canary path (`guarded`) used **83.21 %** of the tokens a plain
> agent used — **−16.79 %** in aggregate — at **equal measured correctness** and with
> **no false done in either arm**. The run-to-run figures were **−19.26 %** and
> **−13.39 %**.
>
> **The standing MCP payload is inside these numbers**, and this release adds evidence
> that it was actually in the session rather than merely configured.
>
> **What this does NOT establish.** Two runs, one trial per cell: the same plain arm
> cost 543,518 tokens in run 1 and 394,733 in run 2 — a **27 % drift between runs of an
> identical configuration**. A −16.79 % aggregate delta is smaller than that drift, so
> this measures a **direction that was consistent in both runs**, not a stable effect
> size. On one of the three fixtures Canary was **more expensive in both runs**.

## The withdrawn headline, and what replaced it

**Withdrawn: `83.21 % of Plain, −16.79 %`.** A headline percentage is only as good as the
dataset under it, and this one had two holes.

**Hole 1 — mixed accounting (the auditor's finding, CONFIRMED).**
`v15-everyday-r2-stateful-replay-guarded-1.json` contributed 131,099 tokens from
`usage.source = "streamed per-message usage (no result event)"` — the **fallback
estimator** — while the accounting rule names `result.usage` as the one method. The same
record has `agent.exitCode 4294967295`, `isError`, `parseFailure`, `sawResult: false` and
the harness's own `streamedUsageUsable: false`. Eleven provider-native cells and one
estimated cell were averaged into a single published percentage.

**Hole 2 — an unstable instrument (found by this closure).** The replacement run
(`v15-everyday-r3`) was complete and every cell eligible, but the tree was **edited while
it ran**: its six cells carry **five different instrument digests** (239/241/242/243
files). Those cells are individually sound and are still not one dataset — they are two
experiments, and a ratio across them compares instruments rather than arms. `bench.mjs`
already records the instrument; nothing enforced it. It does now.

### The corrected contract

`tooling/benchmark/eligibility.mjs` + `tooling/probes/v15-everyday-aggregate.mjs`. A cell
counts toward a headline only if the run **completed** (exit 0, no timeout, no
`isError`/`parseFailure`, a terminal `result` event) **on the declared ledger**
(`result.usage`), with a usable total. A run counts only if **every** cell is eligible
and **all cells share one instrument digest**. Otherwise the run is reported
**INCOMPLETE** and contributes **no ratio and no total** — the probe prints no percentage
at all rather than one computed over a hole. Regressed by
`tooling/benchmark/eligibility.test.mjs` (including an adversarial case where a *cheaper*
failed cell would flatter the ratio; it is not counted at all).

### What the corrected data actually says

| run | plain | guarded | ratio | verdict |
|---|---|---|---|---|
| `v15-everyday` | 543,518 | 438,818 | 80.74 % (−19.26 %) | COMPLETE |
| `v15-everyday-r2` | — | — | — | **INCOMPLETE** — fallback-ledger cell |
| `v15-everyday-r3` | 371,094 | 446,893 | 120.43 % (**+20.43 %**) | **INCOMPLETE** — five instruments |
| `v15-everyday-r4` | 376,688 | 387,649 | **102.91 % (+2.91 %)** | COMPLETE — one instrument, six eligible cells |

`r4` is the first run measured **after** the closure and on a **frozen** tree: six cells, all
ledger-eligible, one instrument digest throughout. It says the everyday path was
**2.91 % MORE expensive than plain**.

The two COMPLETE runs therefore point in **opposite directions** — one 19.26 % cheaper, one
2.91 % dearer — with a **22.17-point spread** against a **44.3 % drift in the plain arm alone**
(376,688 → 543,518) on identical configuration. Pooling them gives 89.81 % (−10.19 %), and the
probe prints its own warning that **the pooled delta is smaller than the spread between runs of
the identical configuration**.

**Therefore no token-saving claim is supported, and none is made.** Not a smaller saving, not a
different percentage — *none*. The honest summary is that this benchmark, at n=1 per cell on
Canary-authored fixtures, **cannot resolve an effect of this size in either direction**, and the
two runs that could be measured disagreed in sign. The `r4` result is also the more credible of
the two for a mundane reason worth stating: it is the only run whose tree was frozen while it
measured, so it is the only one whose six cells are unambiguously one experiment.

What this document still establishes, because it rests on direct observation rather than
on a pooled ratio: the standing MCP payload is genuinely **inside** the measurement
(6/6 guarded trials advertised `mcp__canary`, 0/6 plain), and it costs about **438 tokens**
measured provider-natively rather than the ~1,432 that `bytes ÷ 4` implied.

## Reproduce the aggregate without trusting this document or the benchmark reporter:

```sh
node tooling/probes/v15-everyday-aggregate.mjs
```

## The accounting rule, frozen before the run

The rule was fixed before measuring, because choosing it afterwards is how a benchmark
becomes an advertisement.

| Component | In the measurement? | How |
|---|---|---|
| initial system / harness context | yes | inside the provider-native session total; **not itemised** by the CLI |
| user task | yes | inside the session total; `record.prompt` holds the text |
| **standing MCP instructions + tool schemas** | **yes — the v1.5 fix** | `--mcp-config <fixture>/.mcp.json`, verified present in-session |
| repeated standing payload per turn | yes, as part of the session total | paid on each turn by prompt caching; the CLI does not expose a per-request breakdown |
| assistant outputs | yes | provider-native `output_tokens` |
| tool messages visible to the model | yes | inside the session total |
| retries / repair turns | yes | they are ordinary turns in the session |
| verification prompts sent to the model | yes | inside the session total |
| other persistent Canary context | yes | inside the session total |

**Accounting method, stated exactly:** `result.usage` from the real Claude Code CLI
(`--output-format stream-json`), the same provider-native ledger the harness has always
used — `input + output + cache_read + cache_creation`. Nothing here is a `bytes ÷ 4`
estimate. Two honesty limits of that ledger, which the harness already records:
per-message usage in the stream is **partial** and is never summed, and `result.usage`
**excludes earlier fresh input** (the harness also stores `sessionUsage` beside it; the
two were measured 2.6–2.8 % apart). No component is silently mixed between methods.

## The defect this release fixed

The historical everyday figure (**Plain 409,824 / Canary 379,792 = 92.7 %**) ran the
agent with `--strict-mcp-config` and **no `--mcp-config`**. That kept a developer's own
MCP servers out of the measurement — good — but it also meant the `.mcp.json` that
`canary setup` had just written was never loaded, so the Canary server's instructions
and tool schemas never entered the session and the provider-native total never contained
them. It was a **configuration gap, not an estimator gap**.

Two things were measured rather than assumed:

1. **The payload can be loaded.** `tooling/probes/v15-mcp-standing-payload.mjs` runs two
   otherwise identical sessions differing only by `--mcp-config`:
   **3/3** sessions mentioned `mcp__canary` with the flag, **0/3** without.
2. **What it costs, provider-natively.** The same probe measured a delta of **~438
   tokens** per session — corroborated by the cached prefix differing by exactly
   **434** (15,571 − 15,137). The old `bytes ÷ 4` derivation implied **~1,432**, i.e. it
   **overstated the payload by 3.3×**, because JSON tool schemas tokenise far better than
   four bytes per token. `bytes ÷ 4` must not be quoted as tokens.

The harness now records `agent.mcpConfig` and `agent.mcpToolsAdvertised` per trial, so a
future regression that drops the payload — and thereby flatters Canary — is visible in
the record and fails `tooling/probes/v13-standing-context.mjs` (check A4, inverted in
v1.5 for exactly this reason).

## The A/B, held constant

Same three historical fixtures, same model, same arm instructions, same starting bytes,
same hidden-oracle evaluation, same stopping condition (`--trials 1`, matching the
historical n=1-per-cell design). **The only intended difference is the arm.**

`plain` never runs `canary setup`, so it has no `.mcp.json` and correctly receives no
standing Canary payload. **That asymmetry is the measurement, not a flaw in it:** what a
Canary user actually pays is what the `guarded` arm now measures.

## Per task, per run — every cell, nothing pooled away

> **The two tables in this section and the next are the WITHDRAWN generation** (`v15-everyday` +
> `v15-everyday-r2`), kept because deleting a published dataset is how a benchmark becomes an
> advertisement. `r2` is **INCOMPLETE** under the corrected contract, so its cells and the pooled
> 83.21 % may not be quoted as a result. The current data is the four-run table above.

| run | task | plain | guarded | guarded as % of plain | delta |
|---|---|---|---|---|---|
| v15-everyday | bound-requirements | 123,250 | 123,446 | 100.2 % | **+0.2 %** |
| v15-everyday | bug-sum | 69,944 | 100,614 | 143.8 % | **+43.8 %** |
| v15-everyday | stateful-replay | 350,324 | 214,758 | 61.3 % | **−38.7 %** |
| v15-everyday-r2 | bound-requirements | 161,776 | 123,212 | 76.2 % | **−23.8 %** |
| v15-everyday-r2 | bug-sum | 71,504 | 87,562 | 122.5 % | **+22.5 %** |
| v15-everyday-r2 | stateful-replay | 161,453 | 131,099 | 81.2 % | **−18.8 %** |

## Aggregate (WITHDRAWN generation — these rows are the record, not a result)

| run | plain | guarded | guarded as % of plain | delta |
|---|---|---|---|---|
| v15-everyday | 543,518 | 438,818 | 80.74 % | **−19.26 %** |
| v15-everyday-r2 | 394,733 | 341,873 | 86.61 % | **−13.39 %** |
| **combined — WITHDRAWN, do not quote** | **938,251** | **780,691** | **83.21 %** | **−16.79 %** |

## Correctness — measured, not inferred a benefit

| | plain | guarded |
|---|---|---|
| cells | 6 (3 tasks × 2 runs) | 6 |
| hidden-oracle summary | identical in both arms | identical in both arms |
| false done | **0** | **0** |
| Canary blocked a completion | — | **0** |

**Both arms were equally correct, so no correctness benefit was observed and none is
claimed.** In this run Canary blocked nothing, because the agent's work passed the sealed
checks. A benchmark in which the gate never fires cannot demonstrate that the gate works;
that evidence lives in `docs/REAL-WORLD-EVIDENCE-1.5.md` and in the productization
battery instead.

## Where Canary was NOT worth it

Reported because the point is evidence, not advertising:

- **`bug-sum` cost more with Canary in both runs (+43.8 %, +22.5 %).** It is the smallest
  fixture, so the fixed overhead (the standing payload plus the arm instructions) is
  large relative to a short task. On small tasks Canary is a net cost.
- **`bound-requirements` is a coin-flip** (+0.2 % in run 1, −23.8 % in run 2): the sign
  is not stable, so nothing should be claimed about it.
- **The gate never fired in either arm**, so these six cells contain no evidence that
  Canary prevents a false done — only that it did not cause one.
- **`stateful-replay` carries the aggregate.** It is the long task, and it was cheaper
  both times (−38.7 %, −18.8 %); remove it and the remaining two fixtures are, if
  anything, slightly more expensive with Canary.

## Measurement limits

- **n = 1 per cell.** Four runs exist; two are **INCOMPLETE** under the corrected contract and the
  two COMPLETE runs disagree in sign. No confidence interval is claimed. Plain drifted **44.3 %**
  between the two complete runs on identical configuration, which is larger than any delta pooled
  across them.
- **One model, one CLI version** (Claude Code 2.1.278), one host, one agent
  configuration.
- **The fixtures are Canary-authored.** They are reused deliberately, so the change from
  the historical figure is interpretable, but they are not evidence about arbitrary
  real-world tasks; see `docs/REAL-WORLD-EVIDENCE-1.5.md`.
- **`configMismatch` on stored cells:** the historical everyday cells were recorded with
  fixture declarations that do not match how they were run
  (`bound-requirements` declares `registerRequirements: true` but ran `false`;
  `stateful-replay` declares only `[plain, workflow]`). The v1.5 runs reproduce that
  shape and the harness prints its NOTE; this is inherited, disclosed, and not presented
  as those fixtures' authored measurement.
- Components the CLI does not itemise (system context, the repeated standing payload
  per turn) are inside the totals but cannot be attributed individually. The harness
  **cannot observe** a per-request breakdown of the re-sent payload; saying otherwise
  would require an estimate, and estimates are not used in any headline here.

## Claim reset — what may now be said, and what may not

**Supported by the current evidence:**

- **nothing about an everyday token-saving percentage.** There is no supported figure, in either
  direction: the two COMPLETE runs disagree in sign (80.74 % / −19.26 % and 102.91 % / **+2.91 %**),
  and the pooled 89.81 % (−10.19 %) is **smaller than the spread between runs of the identical
  configuration** (22.17 points against 44.3 % plain-arm drift). It is an observation with a
  limitation, never a headline;
- the standing payload costs **~438 tokens** per session, measured provider-natively, and it is
  genuinely inside the guarded sessions (**6/6** guarded advertised `mcp__canary`, **0/6** plain);
- the **withdrawn** generation's per-task spread (**+43.8 %** more expensive to **−38.7 %** cheaper)
  remains a description of *those* cells, not of Canary.

**Withdrawn as current claims (historical only):**

- **`83.21 % of Plain, −16.79 %`** — mixed accounting (a fallback-estimator cell) and a replacement
  run whose tree changed mid-measurement. Withdrawn in `README.md`, `docs/CLAIM-EVIDENCE-MATRIX-1.5.md`
  and here; the aggregate probe asserts the figure is **not reproducible** from eligible cells;
- the historical **92.7 % / −7.3 %** figure — it excluded the standing payload and must
  not be quoted as Canary's current footprint;
- **`5,726 bytes ≈ 1,432 tokens`** — a derived figure that overstated the measured
  payload by 3.3×.

**Still not claimed** (and no evidence here supports them): universal or guaranteed
savings; **≥ 25 %** savings; **≤ 75 %** of plain; **"up to 87 %" as typical** (it was the best pairing
in one 3×3 replication and is not typical or universal); **"always cheaper"**; and any correctness or
false-done advantage, since none was observed.

