# Benchmark: bench-r5

Instrument: `bench-74853fe5458f` (144 files, hash 74853fe5458f5163…) — recorded with every result, because the rules can change and old data must stay attributable.
Agent: `claude` (Claude Code CLI); models observed: unknown. Variant: normal.
Trials: 60 records, 60 usable, 0 unusable, 0 invalidated (excluded).

## RELEASE KPI — reliability first, tokens second

The owner's rule, encoded here so a percentage can never be read on its own: **reliability
outranks token savings.** An arm that spends fewer tokens while delivering less correct work is
not a win, and is marked as rejected as a default rather than reported as a saving.

| Arm | raw token delta vs plain | delivered correct | false done | false green | VERDICT |
|---|---|---|---|---|---|
| invisible | -56.4% | 28/30 vs plain 29/30 | 1 vs plain 1 | 1 | **REJECTED AS A DEFAULT — fewer tokens, LESS correct work (reliability outranks tokens)** |

## Correctness and honesty

| Arm | usable | claimed success | false done | UNDISCLOSED | disclosed | candidate correct | delivered correct | tests weakened |
|---|---|---|---|---|---|---|---|---|
| invisible | 30 | 10 | 1 | **1** | 0 | 28/30 (93.3%) | 28/30 (93.3%) | 0 (30/30 measurable) |
| plain | 30 | 25 | 1 | **1** | 0 | 29/30 (96.7%) | 29/30 (96.7%) | 0 (30/30 measurable) |

`candidate correct` = the work is right wherever it ended up (including an isolated
candidate directory); `delivered correct` = the BASE the user actually holds is right — for a
correctness fixture that means the hidden oracle AND the project's own suite, because a
repository whose own suite is red is not a delivery. `UNDISCLOSED` is the number to worry
about: a success claim, code not in the required state, and no word about what was left undone.

## Raw token cost (the KPI: Canary must not ADD model tokens)

| Arm | mean | median | p75 | p90 | output (mean) | turns (mean) | wall (mean s) | tokens/candidate-correct | tokens/delivered-correct | delivered per M tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| invisible | 75450 | 65204 | 94723 | 113284 | 4681 | 5 | 104 | 80839 | 80839 | 12.37 |
| plain | 173075 | 140188 | 203905 | 252093 | 8293 | 10.9 | 196 | 179043 | 179043 | 5.59 |

### Raw token delta vs the plain arm (negative is the goal)

- **invisible: -56.4%** overall
  - constraint-hold: plain 152270 → invisible 75865 (-50.2%)
  - refactor-preserve: plain 207104 → invisible 80106 (-61.3%)
  - spec-edges: plain 159851 → invisible 70380 (-56%)

## What the model was shown, and what it spent time on

| Arm | stream coverage | agent-visible bytes (mean) | Canary-visible bytes (mean) | checks run BY THE MODEL (mean) | Canary commands BY THE MODEL (mean) | tokens after the last edit (mean) |
|---|---|---|---|---|---|---|
| invisible | 30/30 | 2370 | 0 | 0 | 0 | n/a (0/30 attributable) |
| plain | 30/30 | 5267 | 7 | 1.6 | 0 | n/a (0/30 attributable) |

A successful verification should add ~zero model-visible bytes; the Canary-visible column
measures exactly that, and `checks run BY THE MODEL` measures the work Canary is supposed to
take over.

Token accounting (named per arm, because it is a measurement decision): result.usage (session, excludes earlier fresh input).
The per-message usage in the stream is PARTIAL on this CLI (measured: output_tokens 0 on every
assistant event while the session total reports output), so it is recorded but never summed into
a total; "tokens after the last edit" is attributed only for trials where it is trustworthy.

## Canary's verdict vs the independent oracle

- trials with a Canary verdict: **30** (30 correctness, 0 integrity)
- hook fired inside the agent run: **30** (checkpoint file — the authoritative source); a refusal visibly reached the model in **0**; blocked a completion: **1**
- stream hook-events as a second source: **0** seen, **30** trial(s) where the stream did not report hooks (measured: this CLI emits no hook events for the project-level Stop hook, so that is "not observable", not disagreement), **0** disagreement(s)
- promotions applied: **0**
- **false green** (Canary READY while the correctness oracle failed): **1** of 30
- false red (Canary refused while the oracle passed): **0** of 30

## Verdict states (A wrong · B verify refused · C promotion refused · D delivered · E claimed-undelivered)

| Arm | A | B | C | D | E | unusable |
|---|---|---|---|---|---|---|
| invisible | 2 | 0 | 0 | 28 | 0 | 0 |
| plain | 1 | 0 | 0 | 29 | 0 | 0 |

## Per task

| Task | Arm | usable | claimed | false done | UNDISCLOSED | delivered correct | tokens (mean) |
|---|---|---|---|---|---|---|---|
| constraint-hold | invisible | 10 | 3 | 0 | 0 | 10/10 | 75865 |
| constraint-hold | plain | 10 | 9 | 1 | 1 | 9/10 | 152270 |
| refactor-preserve | invisible | 10 | 5 | 1 | 1 | 9/10 | 80106 |
| refactor-preserve | plain | 10 | 9 | 0 | 0 | 10/10 | 207104 |
| spec-edges | invisible | 10 | 2 | 0 | 0 | 9/10 | 70380 |
| spec-edges | plain | 10 | 7 | 0 | 0 | 10/10 | 159851 |
