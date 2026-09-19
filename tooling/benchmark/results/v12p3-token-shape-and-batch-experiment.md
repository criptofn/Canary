# v1.2 token-shape measurement and the batched-primitive experiment

Date: 2026-09-18. Model `qwen3.8-flash`, real Claude CLI, real confined transport,
repo's own fixtures and recorded Plain arm. **Not a release artifact** — evidence only.

## Where the tokens actually go (measured, `tooling/probes/v12-token-shape.mjs`)

| task | turns | tool calls | total tokens | cache-read share | tool-result bytes (total / max / p50) |
|---|---|---|---|---|---|
| stateful-replay | 45 | 44 | 917,504 | 92.5% | 27,003 / 1,754 / 391 |
| bug-sum | 26 | 25 | 111,321 | 84.1% | 14,404 / 1,595 / 388 |
| bound-requirements | 20 | 19 | 60,931 | 79.1% | 12,554 / 1,553 / 560 |

Two conclusions follow directly:

- **Tool output is not the cost.** Every result the worker received was small (largest
  1.75 KB). Capping or truncating results would save nothing.
- **The cost is the accumulated conversation being re-read on every turn** (79–92% of all
  tokens), and it grows with the turn count, not with the work. Turning 44 tool calls into
  fewer calls is the only lever the executor can offer.

## The experiment: batched primitives, offered and refused

`production-tool.cjs` was changed to accept `op: 'batch'` (2–64 of the existing four
primitives in ONE confined process — identical boundary, identical paths, strictly fewer
launches), and the MCP tool description in `worker-tools.ts` advertised it as the preferred
form whenever the next steps are already known. Rebuild PASS, dist tripwire PASS, and the
model transport probe proved the batch itself executes every primitive inside the boundary.

Then the same fixture was measured again (`stateful-replay`, the arm's worst cell):

- **`batch` was used 0 times.** The model issued 50 individual calls
  (list 4, read 7, exec 21, write 16, plus 2 malformed) — more than the 44 calls of the run
  without the primitive.
- The session **reached the transport's own 15-minute ceiling** and was terminated without a
  result event: with the primitive available the arm did not finish the task at all.

The change was therefore **reverted**: `production-tool.cjs` and `worker-tools.ts` are byte-
restored to the state that the escape battery (48 executed / 48 blocked / 0 inconclusive) and
the transport probe were verified against, and both were re-run green afterwards.

## What this means for the release decision

The remaining overhead is **not a missing orchestration primitive**. Offering one changed the
model's behaviour not at all; the cost lives in how many round trips the model chooses to
take, which the boundary cannot fix without either re-training the caller or handing the
worker a shell-first interface — a capability increase the project's own priority order
(trust > correctness > simplicity > tokens) ranks below the properties it would risk.

Per the standing instruction ("if the remaining overhead is clearly fundamental rather than
removable orchestration waste, stop and report that honestly"), no further token work was
pursued, and v1.2 was not published: the measured aggregate over the three executable
fixtures is **+159.4%** (409,824 → 1,063,103), against a release condition of < 0%.
