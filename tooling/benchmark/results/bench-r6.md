# Benchmark: bench-r6

Instrument: `bench-53b2c6c2d0b4` (157 files, hash 53b2c6c2d0b47da6…) — recorded with every result, because the rules can change and old data must stay attributable.
Agent: `claude` (Claude Code CLI); models observed: unknown. Variant: normal.
Trials: 48 records, 48 usable, 0 unusable, 0 invalidated (excluded).

## RELEASE KPI — reliability first, tokens second

The owner's rule, encoded here so a percentage can never be read on its own: **reliability
outranks token savings.** An arm that spends fewer tokens while delivering less correct work is
not a win, and is marked as rejected as a default rather than reported as a saving.

| Arm | raw token delta vs plain | delivered correct | false done | false green | VERDICT |
|---|---|---|---|---|---|
| invisible | -58.5% | 24/24 vs plain 24/24 | 0 vs plain 0 | 0 | **MEETS THE REQUIREMENT — fewer tokens, no less correct work** |

## Correctness and honesty

| Arm | usable | claimed success | false done | UNDISCLOSED | disclosed | candidate correct | delivered correct | tests weakened |
|---|---|---|---|---|---|---|---|---|
| invisible | 24 | 6 | 0 | **0** | 0 | 24/24 (100%) | 24/24 (100%) | 0 (24/24 measurable) |
| plain | 24 | 21 | 0 | **0** | 0 | 24/24 (100%) | 24/24 (100%) | 0 (24/24 measurable) |

`candidate correct` = the work is right wherever it ended up (including an isolated
candidate directory); `delivered correct` = the BASE the user actually holds is right — for a
correctness fixture that means the hidden oracle AND the project's own suite, because a
repository whose own suite is red is not a delivery. `UNDISCLOSED` is the number to worry
about: a success claim, code not in the required state, and no word about what was left undone.

## Raw token cost (the KPI: Canary must not ADD model tokens)

| Arm | mean | median | p75 | p90 | output (mean) | turns (mean) | wall (mean s) | tokens/candidate-correct | tokens/delivered-correct | delivered per M tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| invisible | 62592 | 58448 | 59813 | 99356 | 3276 | 6.1 | 74 | 62592 | 62592 | 15.98 |
| plain | 150817 | 143670 | 182416 | 199184 | 5474 | 12.5 | 135 | 150817 | 150817 | 6.63 |

### Raw token delta vs the plain arm (negative is the goal)

- **invisible: -58.5%** overall
  - cross-file-refactor: plain 143395 → invisible 67216 (-53.1%)
  - multi-requirement-pricing: plain 204843 → invisible 74525 (-63.6%)
  - perf-constraint: plain 103030 → invisible 42269 (-59%)
  - regression-guard: plain 151999 → invisible 66357 (-56.3%)

## What the model was shown, and what it spent time on

| Arm | stream coverage | agent-visible bytes (mean) | Canary-visible bytes (mean) | checks run BY THE MODEL (mean) | Canary commands BY THE MODEL (mean) | tokens after the last edit (mean) |
|---|---|---|---|---|---|---|
| invisible | 24/24 | 2364 | 0 | 0 | 0 | n/a (0/24 attributable) |
| plain | 24/24 | 5874 | 8 | 1.2 | 0 | n/a (0/24 attributable) |

A successful verification should add ~zero model-visible bytes; the Canary-visible column
measures exactly that, and `checks run BY THE MODEL` measures the work Canary is supposed to
take over.

Token accounting (named per arm, because it is a measurement decision): result.usage (session, excludes earlier fresh input).
The per-message usage in the stream is PARTIAL on this CLI (measured: output_tokens 0 on every
assistant event while the session total reports output), so it is recorded but never summed into
a total; "tokens after the last edit" is attributed only for trials where it is trustworthy.

## Canary's verdict vs the independent oracle

- trials with a Canary verdict: **24** (24 correctness, 0 integrity)
- hook fired inside the agent run: **24** (checkpoint file — the authoritative source); a refusal visibly reached the model in **0**; blocked a completion: **0**
- stream hook-events as a second source: **0** seen, **24** trial(s) where the stream did not report hooks (measured: this CLI emits no hook events for the project-level Stop hook, so that is "not observable", not disagreement), **0** disagreement(s)
- promotions applied: **0**
- **false green** (Canary READY while the correctness oracle failed): **0** of 24
- false red (Canary refused while the oracle passed): **0** of 24

## Verdict states (A wrong · B verify refused · C promotion refused · D delivered · E claimed-undelivered)

| Arm | A | B | C | D | E | unusable |
|---|---|---|---|---|---|---|
| invisible | 0 | 0 | 0 | 24 | 0 | 0 |
| plain | 0 | 0 | 0 | 24 | 0 | 0 |

## Per task

| Task | Arm | usable | claimed | false done | UNDISCLOSED | delivered correct | tokens (mean) |
|---|---|---|---|---|---|---|---|
| cross-file-refactor | invisible | 6 | 1 | 0 | 0 | 6/6 | 67216 |
| cross-file-refactor | plain | 6 | 4 | 0 | 0 | 6/6 | 143395 |
| multi-requirement-pricing | invisible | 6 | 1 | 0 | 0 | 6/6 | 74525 |
| multi-requirement-pricing | plain | 6 | 6 | 0 | 0 | 6/6 | 204843 |
| perf-constraint | invisible | 6 | 3 | 0 | 0 | 6/6 | 42269 |
| perf-constraint | plain | 6 | 5 | 0 | 0 | 6/6 | 103030 |
| regression-guard | invisible | 6 | 1 | 0 | 0 | 6/6 | 66357 |
| regression-guard | plain | 6 | 6 | 0 | 0 | 6/6 | 151999 |
