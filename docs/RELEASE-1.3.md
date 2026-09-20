# Canary v1.3.0

**Prepared 2026-09-20 — NOT published.** There is **no** `v1.3.0` tarball, tag or GitHub release yet, and
none will exist until the repository owner authorizes it. `v1.2.0` remains the newest *published* artifact.
Licence: Apache-2.0 (the licence text ships **inside** the tarball, a v1.2 fix this release keeps).

This page is the 2–4 minute version. Every number below was produced by a command in this repository, and
the evidence ledgers record what was observed rather than what was intended. The full executed evidence,
including the trust batteries, is [`docs/V1.3-RELEASE-AUDIT.md`](V1.3-RELEASE-AUDIT.md).

## What v1.3 changes

**1. The everyday path is the product.** `canary setup --yes` once per repository, then use your coding
agent the way you already do. Canary seals the plan, wires the Claude Code `Stop` hook, and from then on the
completion check runs itself: when the agent says it is done, the sealed checks run, and a completion can be
**blocked** once with one actionable line. There is no Canary command to run per task, and no Canary
vocabulary to learn — proofs, bindings, sealed bases, candidate promotion and verification receipts stay
inside the implementation.

**2. A green suite that cannot tell your change from the base is not evidence about it.** The gate asks
whether the sealed checks **fail without the change**. If they pass on both sides the verdict is
`NOT PROVEN` and the completion is blocked, with the repair stated: point a check at the behaviour you
changed so it fails without your change and passes with it. A change touching only checks, prose, licences
or generated files is never asked this. This is the concrete thing the everyday path adds over "just running
the tests".

**3. The expert surface is unchanged, and labelled with what it costs.** `canary work` → commit in the
candidate → `canary finish` still freezes a task's authority and proves the change in a copy before it
touches the repository. It is measured to cost **more** than the everyday path and is documented as the
expert surface you choose for isolation, not as the ordinary way to work.

**4. No gate was weakened, and no worker gained authority.** The confined transport, the broker's
proposal review, the proof bindings, the seal and the promotion path are semantically what v1.2 shipped. A
create-only restriction on the confined `write` primitive was built, measured (**842,597** tokens over 32
turns against **288,942** over 19 for the unrestricted form) and **reverted** rather than shipped on the
strength of an argument.

**5. The per-batch confined check ships opt-in, because the evidence is genuinely mixed.**
`CANARY_CONFINED_CHECK=1` is required; the default is off. On `bound-requirements` it helps substantially
(32,362 tokens — 25.5 % of plain — with the flag, 51,050 — 40.2 % — without) and on `bug-sum` it **hurts**
(42,800 — 61.1 % — with, 25,999 — 37.1 % — without), with the no-flag runs sitting entirely below the
with-flag runs. A flag whose sign depends on the task does not become a default.

## Token performance — what was measured, and what was not

Same model (`qwen3.8-flash`), same fixtures, same starting bytes, same hidden oracle, and the CLI's own
token accounting. One recorded run per cell, correct in every cell, no false done in any arm.

| arm | what it is | model tokens | vs plain | correctness |
|---|---|---|---|---|
| `plain` | no Canary at all — untreated control | 409,824 | — | 12/12 · 15/15 · 406/406 |
| **everyday (`guarded`)** | `setup` once, then work normally | **379,792** | **92.7 %** | 12/12 · 15/15 · 406/406 |
| expert (`workflow`) | candidate ceremony, `work` → `finish` | 728,564 | 177.8 % | 12/12 · 15/15 · 406/406 |

**Per cell, because one aggregate hides the shape of it** (n = 1 per cell):

| fixture | plain | everyday | ratio |
|---|---|---|---|
| bound-requirements | 126,977 | 105,255 | 82.9 % |
| bug-sum | 70,070 | 70,083 | 100.02 % (parity) |
| stateful-replay | 212,777 | 204,454 | 96.1 % |

So the honest description of the everyday path is **parity or slightly better, never worse, plus an
independent completion gate** — not a uniform discount.

**The ≤75 % aggregate target was NOT met.** It *is* met, replicated three times on each arm, on the two
short bound cells confined mode can execute (13.1–36.5 % and 54.0–73.3 % of plain), but not in aggregate:
**86.8 % by median, 110.5 % by mean**, because the long stateful cell dominates and is repeatedly *more*
expensive than plain. **Canary does not generally save tokens, and this release does not claim that it
does.** The wording this release is allowed to use is the measured one: on the authored everyday benchmark
Canary used 92.7 % of the tokens of a plain agent at equal correctness while providing an independent
completion gate. Not "Canary saves 25 % of tokens".

**Confined-mode ratios are experimental measurements, not canonical fixture results.** All three benchmark
fixtures declare `benchmarkConfig: {"arm": "guarded"}`, so running them under confined transport is — in the
harness's own words, printed on every such run — *"an experiment outside the configuration the fixture was
authored and validated for; do not present it as that fixture's measurement."* The caveat applies to both
arms equally, so the ratios remain like-for-like; it does bound how the absolute numbers may be quoted. The
everyday numbers are the exception and the stronger case, because `guarded` **is** the authored arm.

## Known limitations, stated here so they are not discovered later

1. **Confined coverage is partial: 5 of 20 fixtures.** Only `bound-requirements`, `bug-sum`,
   `impossible-test`, `stateful-replay` and `version-bump` have every declared requirement bound to a
   sealed check. The other 15 **refuse before any model execution** — 0 worker launches, 0 worker tokens
   spent, **no** delivered-correctness credit. They are refusals, not results. No binding was invented to
   raise the count.
2. **Cursor is `UNMEASURED`.** Cursor documents importing Claude Code hooks, which *would* make the hook
   Canary installs effective there, but that was not reproduced on a real Cursor install — so **no
   protection is claimed**. `canary agents` reports it as `UNMEASURED` in place.
3. **`HARDENED` remains unreachable** on any host without a measured deployment; the provider is
   implemented and refuses to start without a proven separation, and privileged activation is still
   missing.
4. **One harness-owned MCP approval** remains when Canary's tools are registered at project scope;
   registering at `local` scope needs no approval (`tooling/probes/v13-mcp-scope.mjs`).
5. **No correctness advantage is demonstrated.** The v1.2 corpus already had the plain model at ceiling
   (36/36 delivered correct). v1.3's value is the completion guarantee, not a higher pass rate.
6. **`CANARY_CONFINED_CHECK` is opt-in and its evidence is mixed** — see item 5 above.

## Releasing these bytes

The complete productization battery is run against the frozen release tree; `exit 0` with only explicitly
listed, host-bound skips is the release condition, and a `SKIP` is never a pass. Merging to `main`, pushing,
tagging, publishing, and flipping `CANARY_CONFINED_CHECK` on by default all remain the owner's acts.
