# Forced structured operations: measured effect on the Canary arm

Date: 2026-09-19. Model `qwen3.8-flash`, real Claude CLI, real confined transport, the
repository's own fixtures, the recorded Plain arm as baseline. Evidence, not a release claim.

## What changed

The model-facing tool contract now carries an ORDERED LIST of operations in one call
(`{ operations: [ {op,path,text,argv}, ... ] }`), and the one-operation form is no longer
offered to the worker. Authority is unchanged: the same four primitives (list / read /
write / exec), the same confined paths, the same AppContainer, one confined process per
call. A refused operation stops the list and names itself; a non-zero exit STATUS is a
normal result and the list continues. Trusted callers and the security probes keep the
exact one-operation contract and report shape they were verified against.

## The measurement (same fixtures, same starting bytes, same oracle, same model)

| task | Plain | Canary before | Canary forced | Δ vs Plain | turns Plain → forced | correctness |
|---|---|---|---|---|---|---|
| bound-requirements | 126,977 | 34,278–60,931 | **20,472** | **−83.9%** | 12 → 6 | 12/12 vs **12/12** |
| bug-sum | 70,070 | 111,321 | **26,970** | **−61.5%** | 7 → 8 | 15/15 vs **15/15** |
| stateful-replay | 212,777 | 917,504 | **585,337** | **+175.1%** | 18 → 22 | 406/406 vs **406/406** |
| **aggregate** | **409,824** | 1,063,103 | **632,779** | **+54.4%** | | all correct |

Round-trip compression, measured from the transport stream on the dominant bad case:
**21 model tool calls carrying 98 operations = 4.67 operations per call**, against 44 calls
carrying 44 operations before it. Turns fell 45 → 22 and tokens 917,504 → 585,337 on that
fixture. The cost that remains is context, not output: cache-read is 83.5% of the arm's
tokens, because ~5 results per call land in a conversation that every later turn re-reads.

## Boundary re-verified on the changed executor

Confined Git escape battery **48 executed / 48 blocked / 0 succeeded / 0 inconclusive**;
sandbox alias lifecycle **18/18**; pre-bound production workflow **24/24**; production
battery **57 executed / 57 blocked / 45 positive controls / 0 inconclusive** with **52/52**
authority checks; model transport: only the confined tool advertised, native Write/Bash and
alternate MCP rejected, no fallback when the boundary is unavailable, worker receives no API
or broker secret. Dist tripwire PASS. One honest nuance the transport probe records: the
input schema is **not enforced client-side**, so exclusivity of the structured form is at
the level of what the worker is OFFERED, not of what the transport would accept.

## Why the token objective is still not met

The aggregate is +54.4%, and it is one fixture: `stateful-replay`, where Plain spends
212,777 tokens and the confined arm 585,337. Two of three tasks are now strongly negative
(−84%, −62%); the third is not, and it dominates the sum.

What remains is not authority. It is how much of the conversation the caller must carry to
decide what to do next: the arm already packs 4.67 operations per call, and the residual
levers are capping individual results (worth a fraction of a dominant-but-still-positive
fixture) or a further turn reduction that is speculative. A generous projection — halving
the dominant fixture's turns again — lands near 300k there and roughly −15% for the set:
negative, but short of the −25% target, and not something I can claim without measuring it.
