# v1.3 §D — the `edit` primitive: what it fixed, and what it did not

**Question this answers.** The token audit located the confined arm's dominant cost in the model's OWN
output — whole-file `write` re-emissions appended to a conversation that is re-read every turn
(measured: `src/api.js`, 979 B on disk, written nine times; ~70 % of that run's 585,337 tokens). The
repair candidates were "put fewer bytes in the model's own message". This is the measurement of the
first one, and it is a **negative result for the token target**.

Three things were measured, at three different costs. All numbers are from executed runs.

---

## 1. The mechanism — deterministic, model-free

`tooling/probes/v13-edit-primitive.mjs`, through the REAL AppContainer boundary (9/9 PASS):

| property | measured |
|---|---|
| an anchored change applies and **nothing else moves** | byte-exact: the file differs from its previous bytes by exactly the inserted line |
| an ambiguous anchor is **refused**, file untouched | `find occurs more than once` — never "the first match" |
| a missing anchor, and a no-op edit, are refused | file untouched in both cases |
| `find:""` replaces the whole file | wholesale regeneration is still possible, so no capability is lost |
| **containment is unchanged** | `edit` of an absolute path outside the sandbox, of a parent-traversal path, and of the sealed `.canary/canary.local.json` are all DENIED, and every victim is byte-unchanged |

And the size of the thing itself, for a representative change (one line added to a 2,499 B source):

```
write call 1815 B   vs   edit call 141 B   — 8%
```

So the primitive is real, it is safe, and a change costs an eighth of what it cost before.

## 2. Tool choice — is it USED? (14,126 tokens, one small real task)

This repository has already made this mistake once: a previous experiment made a `batch` primitive
*available* and drew a conclusion about efficiency, while the model used it **zero times in 50 calls**
— measuring model preference, not the interface. So the same question was asked directly and cheaply
before any expensive run. `tooling/probes/v13-edit-choice.mjs` runs the REAL confined transport with
the REAL model on a ~2.5 KB module with one seeded defect:

```
model qwen3.8-flash; transport exit 0; 5 call(s), 9 operation(s)
operations by kind: {"list":2,"read":3,"edit":1,"exec":3}     <- edit 1, write 0
bytes the model put in its OWN message: 616 (edit 203, write 0) of a 2499 B source file
trusted readback: cache invalidated = true; suite exit 0
```

**The model chose `edit`, and used zero whole-file writes**, fixed the defect, and the trusted side
confirmed it. That is the opposite of the `batch` outcome, and it costs 14 K tokens to know.

## 3. The stress test — the stateful fixture, the ONE representative pilot

`node tooling/probes/v12-token-pilot.mjs --task stateful-replay --label v13edit` (real model, real
confined transport, real broker, hidden oracle on the promoted bytes).

| | plain (recorded) | Canary v1.2 (recorded) | **Canary + `edit` (this run)** |
|---|---|---|---|
| total tokens | 212,777 | 585,337 | **595,419** |
| turns | 18 | 22 | **24** |
| model output | 8,002 | 39,351 | **30,504** |
| cache read | 181,639 | 488,812 | **518,099** |
| hidden oracle | 406/406 | 406/406 | **406/406** |
| visible suite | green | green | **green** |

**`edit` did what it was designed to do, and it was not enough.**

- The model's own output fell **39,351 → 30,504 (−22.5 %)**, which is the term the primitive attacks.
- The total did **not** improve: **+179.8 %** against plain, where v1.2 recorded **+175.1 %**. The
  difference (+1.7 %) is inside run-to-run noise and must not be read as a regression either.
- The reason is visible in the same table: **cache read is 87 % of the total**, and it is driven by
  **turns × accumulated context**. Turns went 22 → 24, so a 22 % smaller output per turn was cancelled
  by two more turns of re-reading everything.

### And the model only half-adopted it

Counting the operations in the retained transport log of that run:

```
edit   4
write 10
read   8
list   8
exec  30
```

On the small one-shot change it chose `edit` every time (1 edit, 0 writes). On the long task, where it
iterates — writing its own fuzz/tests, discovering a case, regenerating — it still reached for
whole-file `write` **ten times**. So even the adoption is task-shaped: `edit` wins when a change is
aimed, and loses when the model is regenerating a file it is still designing.

---

## What this establishes, and what it does not

**Established by measurement**

1. The primitive is safe (containment identical, ambiguous anchors refused) and an eighth the size.
2. The model DOES choose it when it fits — so this is not the `batch` situation.
3. It reduced the model's own output by 22.5 % on the fixture where output is ~70 % of the cost.
4. **It does not reach the v1.3 token target, and the target's binding term is not bytes-per-write —
   it is turn count.** A smaller conversation per turn does not help if there are more turns.

**NOT established — do not claim these**

- Any token saving attributable to this change. The aggregate moved from +175.1 % to +179.8 %, which is
  noise; the honest statement is *"output per turn fell 22.5 %, the total did not move."*
- That `edit` is sufficient. It is necessary and insufficient.
- Generality from one run per cell: n = 1 for the Canary arm, and the plain baseline is a *recorded*
  run from a different day, not a paired one (the harness's known hygiene gap).
- Any correctness change: 406/406 in both arms, before and after.

## The next lever, now motivated by measurement rather than by theory

Turns. On this fixture the model spent **30 execs**, and the v1.2 analysis of the same fixture found
**~36 of 57 execs were the model re-running its own checks** — it cannot otherwise know it is done. Two
consequences, in order of evidence:

1. **Force the compact form.** `write` still replaced existing files ten times, because it is *allowed*
   to. Making `write` create-only, with `edit` (including `find:""`) as the only way to change an
   existing file, removes the choice without removing the capability. This is the same move that made
   the operations list work, and the measurement above is the reason to expect it to matter.
2. **Answer the question the model is trying to answer.** The confined worker has no way to ask "do the
   project's own sealed checks pass?" — so it builds its own apparatus. Giving the trusted side a
   compact verdict operation attacks the turn count directly instead of the bytes per turn.

Neither is implemented here. Neither should be claimed as working until it is measured the same way.
