# The everyday token measurement, v1.5 — fully accounted

> **Headline, with its limits attached.** Over two independent runs of the same three
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

Reproduce the aggregate without trusting this document or the benchmark reporter:

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

| run | task | plain | guarded | guarded as % of plain | delta |
|---|---|---|---|---|---|
| v15-everyday | bound-requirements | 123,250 | 123,446 | 100.2 % | **+0.2 %** |
| v15-everyday | bug-sum | 69,944 | 100,614 | 143.8 % | **+43.8 %** |
| v15-everyday | stateful-replay | 350,324 | 214,758 | 61.3 % | **−38.7 %** |
| v15-everyday-r2 | bound-requirements | 161,776 | 123,212 | 76.2 % | **−23.8 %** |
| v15-everyday-r2 | bug-sum | 71,504 | 87,562 | 122.5 % | **+22.5 %** |
| v15-everyday-r2 | stateful-replay | 161,453 | 131,099 | 81.2 % | **−18.8 %** |

## Aggregate

| run | plain | guarded | guarded as % of plain | delta |
|---|---|---|---|---|
| v15-everyday | 543,518 | 438,818 | 80.74 % | **−19.26 %** |
| v15-everyday-r2 | 394,733 | 341,873 | 86.61 % | **−13.39 %** |
| **combined** | **938,251** | **780,691** | **83.21 %** | **−16.79 %** |

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

- **n = 1 per cell, 2 runs.** No confidence interval is claimed. Plain drifted 27 %
  between runs on identical configuration, which is the same order as the effect.
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

- over two runs of three Canary-authored fixtures, the everyday path used **83.21 %** of
  a plain agent's tokens in aggregate (−16.79 %), at equal correctness, with no false
  done in either arm, **including** the standing MCP payload;
- the standing payload costs **~438 tokens** per session, measured provider-natively;
- per-task results range from **+43.8 % (more expensive)** to **−38.7 % (cheaper)**.

**Withdrawn as current claims (historical only):**

- the historical **92.7 % / −7.3 %** figure — it excluded the standing payload and must
  not be quoted as Canary's current footprint;
- **`5,726 bytes ≈ 1,432 tokens`** — a derived figure that overstated the measured
  payload by 3.3×.

**Still not claimed** (and no evidence here supports them): universal or guaranteed
savings; **≥ 25 %** savings; **≤ 75 %** of plain — the measured 83.21 % **does not meet**
that target; **"up to 87 %" as typical** (it was the best pairing in one 3×3 replication
and is not typical or universal); **"always cheaper"**; and any correctness or
false-done advantage, since none was observed.
