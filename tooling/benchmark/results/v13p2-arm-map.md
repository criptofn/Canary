# v1.3 §A — the arm map: which Canary SHAPE is cheaper, measured from the recorded corpus

**This cost nothing to produce.** Every number below was already recorded; the v1.2 documents reported
the confined transport as *the* Canary arm and never compared the shapes against each other. Doing that
comparison changes what v1.3 should build, so it is recorded here before anything else is measured.

All three arms run the same fixture, the same model, the same starting bytes and the same hidden oracle.
**CORRECTION (v1.3 §22): this file originally said `canary setup --yes` runs for EVERY arm
(`run-trial.mjs:255`), "so Canary is wired in all of them and the difference between `plain` and `guarded`
is one paragraph of instruction, not wiring". That is FALSE** — the setup block at `run-trial.mjs:254`
lists the protected arms and `plain` is not among them (`run-trial.mjs:803` says so again: "the plain arm
HAS no Canary"). `plain` gets no seal, no Stop hook and no MCP entry, so the ratios below are
**Canary versus genuinely not using Canary** — which is the comparison the token target asks for. The
correction strengthens the result and removes an explanation: `plain` was never gated, so "no false done in
any arm" cannot be credited to a gate that was present everywhere.

| task | `plain` | `guarded` | `workflow` | confined transport |
|---|---|---|---|---|
| bound-requirements | 126,977 (12 t) | **105,255** (10 t) | 200,565 (13 t) | 20,472 (6 t) |
| bug-sum | 70,070 (7 t) | **70,083** (6 t) | 153,178 (12 t) | 26,970 (8 t) |
| stateful-replay | 212,777 (18 t) | **204,454** (17 t) | 374,821 (21 t) | 595,419 (24 t) |
| **aggregate** | **409,824** | **379,792 — 92.7 %** | **728,564 — 177.8 %** | **642,861 — 156.9 %** |
| correctness | 12/12, 15/15, 406/406 | same | same | same |
| false done | none | none | none | none |

Sources: `results/session-evidence/v12tok-main-<task>-plain-1.json`,
`v12tok-guarded-<task>-guarded-1.json`, `v12tok-main-<task>-workflow-1.json`, and the confined-transport
records `v12p4-forced-*` / `v13edit-*`.

## What this says

**1. The everyday shape is the ONLY Canary configuration cheaper than plain — and it is the one v1.3
promises.** The `guarded` arm tells the agent: *verification in this repository is automatic; when you
believe the work is complete, simply finish; you will be told exactly what to fix, so do not re-read
output you have already seen and do not repeat a check you have just run* — and then leaves the decision
to verify with the model (`run-trial.mjs:506-514`, deliberately, because the aggressive variant produced
a false done). Result: **92.7 % of plain, equal correctness, no false done.**

**2. The ceremony is what costs, not the verification.** `workflow` — the documented
`canary work` → `finish` path — is **+77.8 %**, nearly twice the everyday shape, *with identical
correctness*. So v1.3's "zero ceremony" goal and its token goal are the same goal. This is the strongest
evidence yet that `work`/`finish` are an EXPERT surface, not the ordinary path.

**3. The long task does not explode on the everyday shape.** The `guarded` arm takes **17 turns and
96.1 % of plain** on `stateful-replay`, where the confined transport takes 24 turns and 180 %. The
explosion belongs to the transport configuration, not to "Canary on a long task".

**4. The confined transport is a trade, not a win.** It is dramatically cheaper on short, well-specified
changes (−84 % and −62 %) and much more expensive on the long one (+180 %). That is a shape, not a bug,
and it should be documented as one rather than presented as the Canary number.

## The honest position on the v1.3 token target

**≤75 % of plain is NOT met by any recorded configuration.** The best measured shape is 92.7 %. The
target is not reachable by making the everyday shape cheaper in bytes — the guarded arm already makes
almost no tool calls (2–5 commands) and its cost is 17 turns × ~12 K of context, i.e. it is close to the
floor for an agent that must read a repository and think.

Two consequences, stated rather than glossed:

- **The claim that ships must be the measured one:** Canary's everyday shape costs about the same as
  working without it (−7.3 %), while catching work a green suite cannot discriminate; its confined
  transport makes short tasks 2–6× cheaper and long ones more expensive. Anything stronger is not
  supported.
- **What would move the number is not more primitive work**, it is the agent doing fewer turns at a
  smaller context — and the `invisible` arm's recorded false done is the standing proof that buying that
  with "stop verifying" is the wrong trade unless a real gate backs the instruction. In the v1.3 product
  a real gate DOES back it, which is exactly why shipping the instruction through Canary's own channels
  is the next step rather than another primitive.
