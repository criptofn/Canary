# NIGHT-M10.2 — FROZEN TASK AUTHORITY (2026-09-09)

Build target: builder clone `/home/jan/qwen-builder-cage/canary`, branch
`qwen-builder`, built on audited commit `0981edf`. Scope: close the two
CONFIRMED HIGH F4 bypasses from the independent GLM re-audit of M10.1, with
truthful claims and an adversarial regression battery. No redesign, no new
machinery beyond the frozen-authority gate; M7/M8/M9 unchanged.

## The audit finding (verbatim substance)

- **F4-GATE-1** — a candidate with no task authority AT ISOLATION self-mints
  authority by registering a `refactor` task afterwards: M10.1 read the LIVE
  task at verify time, the derived duty floor (tests-green) was satisfied by
  the sealed green plan, verify PASSed, promotion ACCEPTED, base moved.
- **F4-GATE-2** — deleting `rec.intent` from the agent-writable record
  `<base>/.canary/candidates/<name>.json` after isolation made the record
  read as a pre-M10 legacy record; the compat posture returned the taskless
  bypass; PASS + promotion.

M10.1's claim "no agent-writable metadata [can open the door]" was FALSE at
the record layer: M9's sandwich covers the window DURATION only; out-of-window
record edits are invisible to it. The corrected trust boundary is stated in
the `CORRECTIONS` section appended to `NIGHT-M10.1-HARDENING-2026-09-09.md`.

## The fix (production)

`apps/cli/src/candidate.ts` — one gate, before the ladder, reading ONLY the
frozen snapshot:

```ts
const frozenTask = rec.intent?.task ?? null;
const frozenKinds = frozenTask && Array.isArray(frozenTask.kinds) ? frozenTask.kinds : [];
if (!frozenKinds.length) {
  obligations.unshift({ id: 'task-authority', mode: 'objective', status: 'unproven',
    note: rec.intent ? '…FROZEN at isolation… registration afterwards is growth…'
                     : '…no intent snapshot… absence proves nothing and fails safe…' });
}
```

- Authority discharges **only** from the snapshot frozen at isolation. Empty,
  missing, or non-authoritative frozen task → `[task-authority] UNPROVEN`
  (objective) riding the ladder.
- Post-isolation registration may ADD duties (live kinds still feed
  `obligationsFor`; §11 keeps live ⊇ frozen or blocks pre-execution) but can
  NEVER mint authority retroactively.
- A record without `rec.intent` FAILS SAFE — no legacy interpretation, no era
  detection from unauthenticated agent-writable fields. Malformed `intent`
  shapes are refused by the existing loadRecord shape law (exit 2, "is
  malformed").
- Recovery is explicit in both notes: register → **RE-ISOLATE** → verify the
  new candidate. No flag, no env var, no compat escape, zero new knobs.
- Precedence unchanged: fail > unmet > unproven > pass. Authority rides as
  UNPROVEN even when every derived duty is MET; promotion gate 1 re-verifies
  LIVE and refuses (exit 2, zero promotion bundles, base unmoved). A forged
  non-empty frozen snapshot + matching live registration is byte-equivalent to
  a real re-isolation — the documented same-UID ceiling, not a gate gap.

`apps/cli/src/main.ts` — file header, `canary task` help, and `isolate
--verify` help now state frozen authority + re-isolate recovery ("there is no
opt-out"). `candidate.ts` header + ladder comments rewritten to the actual
trust boundary (Fix 5; the M10.1 claims removed are annotated in the night-1
CORRECTIONS block rather than silently rewritten).

## Test & probe surface (Fix 4)

- `tooling/probes/m10-obligations.mjs` — **S5 flipped** (hand-stripped intent
  → NOT PROVEN naming `[task-authority]`, RE-ISOLATE advice, promote locked —
  never a legacy PASS); **S12 rewritten** with both legs: taskless candidate
  NOT PROVEN + post-isolation registration CANNOT self-mint; register +
  RE-ISOLATE recovers PASS. Result: ALL PASS.
- `apps/cli/test/m10-obligations.test.ts` — legacy-compat test renamed to the
  fail-safe posture; **F4-H** (post-isolation minting stays unproven) and
  **F4-I** (intent-less record fails safe) added. Full suite: 638/638 pass.
- `tooling/probes/m10-2-adversarial.mjs` — NEW real-git battery, cases A–L:
  A taskless; B post-isolation `refactor` with every duty MET; C five other
  kinds; D register→re-isolate recovers; E intent deletion; F seven record
  shapes (readable → UNPROVEN, invalid → malformed refusal, never PASS); G
  hand-written backdated legacy-shaped record; H remove/re-add churn leaves
  the frozen verdict unchanged both directions (§11 catches shrink); I six
  env vars + four invented flags inert; J byte-copied genuine PASS bundle
  inert; K exact precedence combos (fail > unmet-red, unmet-del > unproven,
  frozen-unmet hides authority); L positive control — honest bugfix registered
  BEFORE isolation + committed regression test → PASS → promotion ACCEPTED,
  exactly one accepted bundle, base moved. Result: ALL PASS; hygiene: zero
  quarantine stamps, every blocked base HEAD byte-unchanged.
- `tooling/probes/m10-mutation-battery.mjs` — 22 mutations (+3 M10.2): gate
  removed → S12+; authority read from LIVE task → S12; gate re-conditioned on
  `rec.intent` → S5. Result: **22/22 caught, 0 survivors**, dist byte-
  restored and anchor-swept.
- `tooling/probes/m10-f4-bypass-repro.mjs` — now reports
  `F4-BYPASS: CLOSED` on the fixed build (verify 2 / `["unproven","unproven"]`
  bundles / promote 2 / zero promotion bundles / base unmoved), leg 2 control
  lands.

## Before/after reproduction of both bypasses (VALIDATION)

`repro.mjs` runner executed identically against BOTH builds (fixtures OS-temp;
the frozen audit worktree `wt-0981edf` was executed against, never written):

| bypass | OLD dist `0981edf` | NEW dist (this commit) |
|---|---|---|
| F4-GATE-1 post-isolation registration | verify 0 PASS, promote 0, base MOVED, 1 accepted bundle → **OPEN** | verify 2 NOT PROVEN naming `[task-authority]` (growth note), promote 2, base unmoved, 0 bundles → **CLOSED** |
| F4-GATE-2 `rec.intent` deletion | verify 0 PASS, promote 0, base MOVED, 1 accepted bundle → **OPEN** | verify 2 NOT PROVEN naming `[task-authority]` (fails-safe note), promote 2, base unmoved, 0 bundles → **CLOSED** |
| legitimate recovery (register pre-isolation → evidence → verify → promote) | lands | **lands**: PASS → ACCEPTED, base moved, exactly one accepted bundle |

Full outputs: `night-evidence/2026-09-09-m10-2/repro-old.log`,
`repro-new.log`.

## Fix 6 — productization reporting honesty

`tooling/verify-productization.mjs` — SKIP summaries now distinguish a skipped
probe that EXECUTED checks from one that executed zero:
`host-bound: N check(s) EXECUTED, M explicit SKIP(s) — SKIP never counts as
PASS` (plus `nothing here was accepted by execution` when N=0), and the
headline names `… SKIP step(s) EXECUTED ZERO checks — environment absent,
accepted as nothing`. New step 14f wires the A–L battery into
`verify:productization` (27 steps total); 14d's stale legacy-compat claim
replaced with the M10.2 correction.

## Results ledger (this pass, POSIX/WSL2 — Windows re-run still owed)

- contract tests `npm test`: 638/638 pass.
- `m10-obligations.mjs`: ALL PASS (incl. flipped S5, rewritten S12).
- `m10-2-adversarial.mjs`: A–L + hygiene ALL PASS.
- `m10-f4-bypass-repro.mjs`: ALL PASS, F4-BYPASS CLOSED.
- `m10-mutation-battery.mjs`: 22/22 caught.
- m7/m8/m9 mutation batteries + `verify:productization` (27 steps): see
  `night-evidence/2026-09-09-m10-2/`.

## Honest residuals

1. **Same-UID ceiling** (inherited, documented in the gate comment): an actor
   who owns every byte can write a forged non-empty frozen snapshot +
   matching live registration — byte-equivalent to an honest re-isolation.
   CLI-side checks cannot survive that actor; directive §16–§18 owns the
   threat model above it.
2. **Refactor-on-build-only-plan vacuity**: a `refactor` whose sealed plan has
   no tests step derives tests-green from plan presence only — inherited M10
   semantics, unchanged.
3. **Comment-only "test" files** satisfy regression-evidence (path-based
   `isTestPath`); deepening to content-aware review is M11 territory.
4. **POSIX-only results** — Windows audit-host re-run of suite/probes/battery
   owed (same residual as M10.1).

## Scope discipline

No versioned record format (explicitly ruled out — the simpler fail-safe path
was mandated). No redesign, no M11 features, no byte-assertion relaxations, no
weakening of M7/M8/M9, no touch to frozen audit refs or `scratch/aud0981edf`
scripts, no remote, no push, no copy into the real Windows repository.
