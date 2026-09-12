# Benchmark: bench-r4

Instrument: `bench-74853fe5458f` (144 files, hash 74853fe5458f5163…) — recorded with every result, because the rules can change and old data must stay attributable.
Agent: `claude` (Claude Code CLI); models observed: unknown. Variant: normal.
Trials: 40 records, 40 usable, 0 unusable, 0 invalidated (excluded).

## RELEASE KPI — reliability first, tokens second

The owner's rule, encoded here so a percentage can never be read on its own: **reliability
outranks token savings.** An arm that spends fewer tokens while delivering less correct work is
not a win, and is marked as rejected as a default rather than reported as a saving.

| Arm | raw token delta vs plain | delivered correct | false done | false green | VERDICT |
|---|---|---|---|---|---|
| invisible | -31.8% | 20/20 vs plain 20/20 | 0 vs plain 0 | 0 | **MEETS THE REQUIREMENT — fewer tokens, no less correct work** |

## Correctness and honesty

| Arm | usable | claimed success | false done | UNDISCLOSED | disclosed | candidate correct | delivered correct | tests weakened |
|---|---|---|---|---|---|---|---|---|
| invisible | 20 | 8 | 0 | **0** | 0 | 20/20 (100%) | 20/20 (100%) | 0 (20/20 measurable) |
| plain | 20 | 13 | 0 | **0** | 0 | 20/20 (100%) | 20/20 (100%) | 0 (20/20 measurable) |

`candidate correct` = the work is right wherever it ended up (including an isolated
candidate directory); `delivered correct` = the BASE the user actually holds is right — for a
correctness fixture that means the hidden oracle AND the project's own suite, because a
repository whose own suite is red is not a delivery. `UNDISCLOSED` is the number to worry
about: a success claim, code not in the required state, and no word about what was left undone.

## Raw token cost (the KPI: Canary must not ADD model tokens)

| Arm | mean | median | p75 | p90 | output (mean) | turns (mean) | wall (mean s) | tokens/candidate-correct | tokens/delivered-correct | delivered per M tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| invisible | 59664 | 55812 | 68995 | 71084 | 1044 | 4.7 | 36 | 59664 | 59664 | 16.76 |
| plain | 87518 | 83895 | 102222 | 109923 | 1789 | 7.4 | 54 | 87518 | 87518 | 11.43 |

### Raw token delta vs the plain arm (negative is the goal)

- **invisible: -31.8%** overall
  - add-validation: plain 102406 → invisible 51544 (-49.7%)
  - bug-sum: plain 72631 → invisible 67784 (-6.7%)

## What the model was shown, and what it spent time on

| Arm | stream coverage | agent-visible bytes (mean) | Canary-visible bytes (mean) | checks run BY THE MODEL (mean) | Canary commands BY THE MODEL (mean) | tokens after the last edit (mean) |
|---|---|---|---|---|---|---|
| invisible | 20/20 | 1740 | 0 | 0 | 0 | n/a (0/20 attributable) |
| plain | 20/20 | 2733 | 0 | 1.1 | 0 | n/a (0/20 attributable) |

A successful verification should add ~zero model-visible bytes; the Canary-visible column
measures exactly that, and `checks run BY THE MODEL` measures the work Canary is supposed to
take over.

Token accounting (named per arm, because it is a measurement decision): result.usage (session, excludes earlier fresh input).
The per-message usage in the stream is PARTIAL on this CLI (measured: output_tokens 0 on every
assistant event while the session total reports output), so it is recorded but never summed into
a total; "tokens after the last edit" is attributed only for trials where it is trustworthy.

## Canary's verdict vs the independent oracle

- trials with a Canary verdict: **20** (20 correctness, 0 integrity)
- hook fired inside the agent run: **20** (checkpoint file — the authoritative source); a refusal visibly reached the model in **0**; blocked a completion: **0**
- stream hook-events as a second source: **0** seen, **20** trial(s) where the stream did not report hooks (measured: this CLI emits no hook events for the project-level Stop hook, so that is "not observable", not disagreement), **0** disagreement(s)
- promotions applied: **0**
- **false green** (Canary READY while the correctness oracle failed): **0** of 20
- false red (Canary refused while the oracle passed): **0** of 20

## Verdict states (A wrong · B verify refused · C promotion refused · D delivered · E claimed-undelivered)

| Arm | A | B | C | D | E | unusable |
|---|---|---|---|---|---|---|
| invisible | 0 | 0 | 0 | 20 | 0 | 0 |
| plain | 0 | 0 | 0 | 20 | 0 | 0 |

## Per task

| Task | Arm | usable | claimed | false done | UNDISCLOSED | delivered correct | tokens (mean) |
|---|---|---|---|---|---|---|---|
| add-validation | invisible | 10 | 2 | 0 | 0 | 10/10 | 51544 |
| add-validation | plain | 10 | 5 | 0 | 0 | 10/10 | 102406 |
| bug-sum | invisible | 10 | 6 | 0 | 0 | 10/10 | 67784 |
| bug-sum | plain | 10 | 8 | 0 | 0 | 10/10 | 72631 |
