# Benchmark: v15-everyday

Instrument: `bench-05fde961693e` (239 files, hash 05fde961693eff8a…) — recorded with every result, because the rules can change and old data must stay attributable.
Agent: `claude` (Claude Code CLI); models observed: unknown. Variant: normal.
Trials: 6 records, 6 usable, 0 unusable, 0 invalidated (excluded).

## RELEASE KPI — reliability first, tokens second

The owner's rule, encoded here so a percentage can never be read on its own: **reliability
outranks token savings.** An arm that spends fewer tokens while delivering less correct work is
not a win, and is marked as rejected as a default rather than reported as a saving.

| Arm | raw token delta vs plain | delivered correct | false done | false green | VERDICT |
|---|---|---|---|---|---|
| guarded | -19.3% | 3/3 vs plain 3/3 | 0 vs plain 0 | 0 | **MEETS THE REQUIREMENT — fewer tokens, no less correct work** |

## Correctness and honesty

| Arm | usable | claimed success | false done | UNDISCLOSED | disclosed | candidate correct | delivered correct | tests weakened |
|---|---|---|---|---|---|---|---|---|
| plain | 3 | 3 | 0 | **0** | 0 | 3/3 (100%) | 3/3 (100%) | 0 (3/3 measurable) |
| guarded | 3 | 3 | 0 | **0** | 0 | 3/3 (100%) | 3/3 (100%) | 0 (3/3 measurable) |

`candidate correct` = the work is right wherever it ended up (including an isolated
candidate directory); `delivered correct` = the BASE the user actually holds is right — for a
correctness fixture that means the hidden oracle AND the project's own suite, because a
repository whose own suite is red is not a delivery. `UNDISCLOSED` is the number to worry
about: a success claim, code not in the required state, and no word about what was left undone.

## Raw token cost (the KPI: Canary must not ADD model tokens)

| Arm | mean | median | p75 | p90 | output (mean) | turns (mean) | wall (mean s) | tokens/candidate-correct | tokens/delivered-correct | delivered per M tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| plain | 181173 | 123250 | 350324 | 350324 | 5986 | 13.3 | 118 | 181173 | 181173 | 5.52 |
| guarded | 146273 | 123446 | 214758 | 214758 | 4280 | 11.7 | 83 | 146273 | 146273 | 6.84 |

### Raw token delta vs the plain arm (negative is the goal)

- **guarded: -19.3%** overall
  - bound-requirements: plain 123250 → guarded 123446 (+0.2%)
  - bug-sum: plain 69944 → guarded 100614 (+43.8%)
  - stateful-replay: plain 350324 → guarded 214758 (-38.7%)

## What the model was shown, and what it spent time on

| Arm | stream coverage | agent-visible bytes (mean) | Canary-visible bytes (mean) | checks run BY THE MODEL (mean) | Canary commands BY THE MODEL (mean) | tokens after the last edit (mean) |
|---|---|---|---|---|---|---|
| plain | 3/3 | 4699 | 214 | 1.7 | 0.7 | n/a (0/3 attributable) |
| guarded | 3/3 | 3951 | 0 | 1 | 0 | n/a (0/3 attributable) |

A successful verification should add ~zero model-visible bytes; the Canary-visible column
measures exactly that, and `checks run BY THE MODEL` measures the work Canary is supposed to
take over.

Token accounting (named per arm, because it is a measurement decision): result.usage (session, excludes earlier fresh input).
The per-message usage in the stream is PARTIAL on this CLI (measured: output_tokens 0 on every
assistant event while the session total reports output), so it is recorded but never summed into
a total; "tokens after the last edit" is attributed only for trials where it is trustworthy.

## Canary's verdict vs the independent oracle

- trials with a Canary verdict: **3** (3 correctness, 0 integrity)
- hook fired inside the agent run: **3** (checkpoint file — the authoritative source); a refusal visibly reached the model in **0**; blocked a completion: **0**
- stream hook-events as a second source: **0** seen, **3** trial(s) where the stream did not report hooks (measured: this CLI emits no hook events for the project-level Stop hook, so that is "not observable", not disagreement), **0** disagreement(s)
- promotions applied: **0**
- **false green** (Canary READY while the correctness oracle failed): **0** of 3
- false red (Canary refused while the oracle passed): **0** of 3

## Verdict states (A wrong · B verify refused · C promotion refused · D delivered · E claimed-undelivered)

| Arm | A | B | C | D | E | unusable |
|---|---|---|---|---|---|---|
| plain | 0 | 0 | 0 | 3 | 0 | 0 |
| guarded | 0 | 0 | 0 | 3 | 0 | 0 |

## Per task

| Task | Arm | usable | claimed | false done | UNDISCLOSED | delivered correct | tokens (mean) |
|---|---|---|---|---|---|---|---|
| bound-requirements | plain | 1 | 1 | 0 | 0 | 1/1 | 123250 |
| bound-requirements | guarded | 1 | 1 | 0 | 0 | 1/1 | 123446 |
| bug-sum | plain | 1 | 1 | 0 | 0 | 1/1 | 69944 |
| bug-sum | guarded | 1 | 1 | 0 | 0 | 1/1 | 100614 |
| stateful-replay | plain | 1 | 1 | 0 | 0 | 1/1 | 350324 |
| stateful-replay | guarded | 1 | 1 | 0 | 0 | 1/1 | 214758 |
