# Canary v1.5 — public audit kit

For a reviewer who did **not** build Canary. Everything here is reachable from a clone of the
repository; nothing requires private builder knowledge, credentials, or a conversation with the
author.

**Your job is to try to disprove the claims, not to endorse them.** §7 lists the specific places
where this project believes it is most likely to be wrong.

---

## 1. What Canary is, in one paragraph

Canary is an independent verification layer for software changes made by coding agents. It seals a
project's own checks, runs them when an agent claims to be finished, and **blocks the completion**
when they fail — so "done" is a command's output rather than a model's assertion. It is not a
linter, not a test framework, and not a correctness oracle.

## 2. The claims — and the non-claims

The full claim/evidence matrix, with reproduction commands, limitations and a five-way status for
every claim, is [`CLAIM-EVIDENCE-MATRIX-1.5.md`](CLAIM-EVIDENCE-MATRIX-1.5.md). Read that first;
this kit only tells you how to attack it.

**Non-claims, stated up front because they bound everything else:**

- no claim that Canary makes code **correct**;
- no claim that Canary **never** allows a false done;
- no claim that HARDENED is available on every host (a host that cannot confine is
  `HOST UNSUPPORTED`);
- no claim that Canary is **always** cheaper — on one of three fixtures it was more expensive in
  both runs;
- **no everyday token-saving percentage at all.** The v1.5 candidate's `83.21 % of Plain / −16.79 %`
  is **withdrawn** (mixed accounting), and the corrected data has **two COMPLETE runs that disagree
  in sign**. The only surviving token number is the standing MCP payload's **~438 tokens**, which is
  a measurement of a cost, not of a saving;
- no claim of **administrator resistance**, exhaustive network coverage, a separate installed
  service account, key rotation, power-loss durability, or Linux runtime verification;
- **no claim that an external audit has happened.** This document is a *request*.

## 3. Threat model, in the product's own words

- **In scope:** the confined builder or candidate — code that Canary itself executes.
- **Out of scope:** a holder of the operator's unrestricted token, and a local administrator. The
  trusted operator/broker is the normal user.
- `LOCAL` is **not** an OS boundary: records are sealed outside the repository with an Ed25519 key,
  but the same uid can replace the store, the key and the ledger together.
- **Fail-closed is the product:** `INCONCLUSIVE`, `NOT PROVEN`, `BLOCKED` and `UNSUPPORTED` are
  outcomes, not bugs. A refusal is not a successful result.

Sources: [`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md), [`TRUST-ARCHITECTURE.md`](TRUST-ARCHITECTURE.md),
[`SECURITY.md`](SECURITY.md), [`HARDENED-1.5.md`](HARDENED-1.5.md).

## 4. Reproduce the major claims

Build once, then run any of these independently:

```sh
npm ci && npm run build

# 1. HARDENED: does the boundary actually hold on THIS host?  (~2 min, no elevation)
node tooling/probes/v15-hardened-boundary.mjs
#    exit 0 = all six controls PASS; 1 = a measured FAIL; 3 = HOST UNSUPPORTED (NOT success)
#    4 = the live battery failed (NOT MEASURED, and an older file cannot rescue it)

# 2. Re-print the per-control table from the last SAVED transcript
#    HISTORICAL ONLY: exits 2, labels every row HISTORICAL, and cannot report a current PASS.
#    (v1.5 post-audit: it used to print "HARDENED: MEASURED / RESULT: PASS" from a stale OS-temp
#    file while the live store said LOCAL 0/6. Fixed and regressed:
#    tooling/benchmark/hardened-evidence.{mjs,test.mjs}.)
node tooling/probes/v15-hardened-boundary.mjs --from-saved

# 3. Token benchmark: recompute the aggregate from the RAW trial records.
#    Reports each run COMPLETE or INCOMPLETE and prints NO ratio for an incomplete one.
#    (v1.5 post-audit: the published headline pooled a fallback-estimator cell and a run whose
#    tree changed mid-measurement. Both are now refused; the claim was WITHDRAWN.)
node tooling/probes/v15-everyday-aggregate.mjs

# 3b. Check provenance: can a worker rewrite an existing check and keep independent authority?
node tooling/probes/v15-check-provenance.mjs

# 4. Is the standing MCP payload really in the session, and what does it cost?  (~1 min)
node tooling/probes/v15-mcp-standing-payload.mjs

# 5. First-run journey on a freshly packed artifact  (install → block → repair → uninstall)
node tooling/probes/v15-first-run.mjs

# 6. The whole productization surface (long; rebuilds and runs every probe)
npm run verify:productization
```

**HARDENED host requirements.** Windows 10/11 x64 able to execute a child inside
AppContainer + restricted token + low integrity (the launcher is compiled during the run), plus
PowerShell and a C# compiler. **No elevation.** Measured working on Windows 10.0.26200; measured
**not** working on the GitHub-hosted `windows-latest` image, which is reported as
`HOST UNSUPPORTED` — that is a host verdict, not a pass.

**Expected outputs.** Probe #1 prints one row per control with `CONTROL / EXPECTED / ACTUAL /
VERDICT / HOST / REPRO`, then `PASS 6 · FAIL 0 · HOST UNSUPPORTED 0`, and exits 0. Probe #3 reports
each run as **COMPLETE** or **INCOMPLETE** and prints **no ratio for an incomplete run**; it fails if
the withdrawn headline turns out to be reproducible from eligible cells, and it prints its own
warning when a pooled delta is smaller than the run-to-run spread.

## 5. Where the evidence lives

| Subject | Artefact |
|---|---|
| Claim/evidence matrix, all statuses | [`CLAIM-EVIDENCE-MATRIX-1.5.md`](CLAIM-EVIDENCE-MATRIX-1.5.md) |
| Post-audit closure: seven findings, fixes, regressions, the open sweep result | [`POST-AUDIT-CLOSURE-1.5.md`](POST-AUDIT-CLOSURE-1.5.md) |
| Cell/run eligibility rule for any token ratio | `tooling/benchmark/eligibility.mjs` + `eligibility.test.mjs` |
| Windows sweep failure diagnostic (observability only) | `packages/support/test/lifecycle.test.ts` |
| HARDENED boundary: mechanism, controls, activation, measurement | [`HARDENED-1.5.md`](HARDENED-1.5.md) |
| HARDENED raw run output | `tooling/benchmark/results/session-evidence/v15-hardened-boundary-fresh.txt` |
| Everyday benchmark: method, every cell, limits, claim reset | [`BENCHMARK-EVERYDAY-1.5.md`](BENCHMARK-EVERYDAY-1.5.md) |
| Everyday raw trials (JSON, per cell) | `tooling/benchmark/results/v15-everyday*.json` |
| Standing-payload measurement | `tooling/benchmark/results/session-evidence/v15-mcp-standing-payload.txt` |
| First-run journey + friction points | [`FIRST-RUN-1.5.md`](FIRST-RUN-1.5.md) |
| First-run probe output | `tooling/benchmark/results/session-evidence/v15-first-run-postbuild.txt` |
| Cursor result and missing primitive | [`CURSOR-1.5.md`](CURSOR-1.5.md) |
| Real-world repositories and agent runs | [`REAL-WORLD-EVIDENCE-1.5.md`](REAL-WORLD-EVIDENCE-1.5.md) |
| v1.4 artifact provenance and packaging limitation | [`RELEASE-1.4.md`](RELEASE-1.4.md) |
| Release workflow (attestation, assets, draft handling) | `.github/workflows/release.yml` |

## 6. Release / artifact provenance

- v1.4.0: tag `v1.4.0` → `4271e6e` (tip of `main`). Asset `canary-rn-cli-1.4.0.tgz`,
  **208,993 bytes**, SHA-256
  `42ed2056e8b77b212d07ec92814cb2e67f908bf76733114e072605e7e5e5505c`, matching its published
  `.sha256` sidecar and an independent computation. Published via the `canary-release` workflow,
  which attests build provenance for the bytes **it** built.
- **Known limitation, measured:** packaging is deterministic per host but **not byte-identical
  across hosts**. `core.autocrlf=true` gives a Windows checkout CRLF for the packed text files
  while Linux has LF, so 13 of 16 entries differ by exactly their CRLF count (1,509 B uncompressed
  → 124 B gzipped). The Windows build of the same tree is **209,117 bytes** /
  `f82203f3f7009d2e9e31d3144db28d8d46108eed76f9a87b721f13cfc4b3aca4`. **Therefore "rebuild from
  the git tree and compare to the published digest" is not a valid audit step on Windows** — compare
  against the downloaded release bytes instead.
- A defect this release fixes: v1.4.0 was published as a **draft** (invisible to anonymous readers;
  `releases/latest` still resolved to v1.3.0) because `gh release view` succeeds on a draft and the
  workflow treated that as "already created". The draft flag was cleared with assets byte-identical
  before and after, and the workflow now reads the draft flag, publishes a draft, and asserts the end
  state is published with both assets.

## 7. Where to attack this — the author's own list of weakest points

### 7.0 START HERE — the Windows descendant sweep (OPEN, UNEXPLAINED, containment-relevant)

This is the only known **open** defect-shaped result in the release, it is **not** fixed, and it is
the highest-value thing to attack:

- On one hosted Windows run, `sweepDescendants finds and kills a live parent's child process`
  failed: **`sweep killed [7564] but not 2144`**, `duration_ms 35980` (the same test takes **894 ms**
  on the author's machine).
- It did **not** reproduce locally in **14** attempts (idle; 48 CPU burners on 24 cores; burners with
  the test pinned to 2 cores) — 0 failures, 1.6–2.9 s at worst.
- The next CI run was **green** — and that is **not** evidence it is fixed: **no product change was
  made between the failing run and the green one.** The only delta was a **diagnostic in a test
  failure message**, which cannot alter product behaviour.
- **Therefore: green ≠ fixed.** A missed descendant is a **containment** concern: `sweepWin32`
  enumerates one CIM snapshot and can omit a child only if (a) the child is absent from that
  snapshot, (b) its `ParentProcessId` is not the parent being queued, (c) its `CreationDate` is null
  or before the 61-second cut, or (d) the kill itself failed. The diagnostic has been improved to
  separate those shapes on the **next** failure — it has not yet observed one.
- What to attack: reproduce it on a loaded Windows host, or show the improved diagnostic still cannot
  distinguish the four shapes. On failure the message now prints the sweep input and expected child,
  the `cutUsedBySweep` recomputed from `spawnedAtMs`, the liveness of both processes, a **fresh
  `Get-CimInstance` observation** of both PIDs (`ProcessId`, `ParentProcessId`, `CreationDate`,
  presence) and the shape those observations are consistent with. **That output path was measured,
  not assumed** — see `docs/POST-AUDIT-CLOSURE-1.5.md` ("Second-auditor pass"), where a one-off
  mutation of the emitted file reproduced the runner's failure shape and produced the diagnostic
  text, after which the artifact was rebuilt byte-identically. Reproduce the ordinary path with
  `node --test packages/support/dist/test/lifecycle.test.js` under load, repeatedly.

1. **The token effect — can ANY effect be resolved from the current data?** The project currently
   claims **NONE**. The published `83.21 % / −16.79 %` is **withdrawn**; `r2` and `r3` are
   **INCOMPLETE**; the two COMPLETE runs disagree in **sign** (80.74 % / −19.26 % and 102.91 % /
   +2.91 %) across a 22.17-point spread against a **44.3 % plain-arm drift**. Do **not** spend your
   time deciding whether −16.79 % is noise — that number is already withdrawn. Try instead to show
   that some **other** number is supportable from these records, or that none is. Reproduce with
   `node tooling/probes/v15-everyday-aggregate.mjs`, and check the refusal itself: feed
   `tooling/benchmark/results/v15-everyday*.json` through `tooling/benchmark/eligibility.mjs` and try
   to get an INCOMPLETE run to print a ratio.
2. **`bug-sum` was more expensive with Canary in both historical runs** (+43.8 %, +22.5 %). These are
   **withdrawn-generation** cells, kept as observations: check whether the (withdrawn) aggregate was
   carried entirely by `stateful-replay`, and whether any surviving claim leans on that dataset.
3. **The benchmark fixtures are Canary-authored.** They are reused for comparability, not because
   they are neutral. Challenge whether they are representative.
4. **`configMismatch` on the stored cells** — the historical everyday cells ran with fixture
   declarations that do not match (`bound-registerRequirements`, `stateful-replay` authored arms).
   Verify this is disclosed rather than hidden, and judge whether it invalidates the comparison.
5. **HARDENED is measured on exactly one host**, the author's own. Try to falsify a control on
   another capable host, or find a control the validator accepts that the probe would report as
   PASS without it actually holding.
6. **The six controls are asserted as a set.** `measureBoundary` sets all six available when the
   production measurement validates. Attack whether the validator genuinely measures each control
   (`production-measurement.ts:130-206`) or whether one is inferred from another.
7. **Token attribution.** The CLI cannot itemise system context or the per-turn re-sent payload;
   those are inside the session total but unattributed. Attack whether any headline depends on an
   estimate (`bytes ÷ 4` is used **only** as a labelled cross-check, and is shown to be 3.3× wrong).
   The one surviving token observation — the **~438-token** standing payload, 6/6 guarded vs 0/6
   plain — is the thing to attack if you want to move a number in the docs.
8. **The first-run journey is on a synthetic scratch repository**, not a real one.
9. **Cursor is resolved by documentation, not by a run** — Cursor is absent from the author's
   machine. Verify the missing-primitive argument, and check the author did not merely assert it.
10. **The real-world evidence** depends on agent runs the author drove. Check for cherry-picking and
    whether "where Canary added no value" is reported honestly.

**Added after the real-world workstream — the three findings most worth attacking:**

11. **The sealed step's restricted environment — CONFIRMED, now FIXED (audit finding 6); attack the
    remaining gap, not the fixed defect.** The original measurement stands: PATH was
    `node_modules/.bin` + Node dir + System32/Windows only (12 entries against the shell's 29), so
    `python`, `python3`, `java`, `sh`, `bash` and **`git`** were invisible even when on PATH, and
    `JAVA_HOME` was stripped — refactron's suite was **27 failed inside Canary, 0 failed outside**,
    reported as *"That is your project talking, not Canary"*. **What v1.5 changed:** an OPERATOR may
    authorize a toolchain directory (`canary setup --toolchain-dir`), which is appended *after* the
    trusted dirs (a planted `git.cmd` earlier on PATH is still never executed), and an unresolvable
    required program is now attributed to the environment. **Still open to attack:** the
    authorization is an operator act, not automatic; there is **no `JAVA_HOME` handling**; `HOME` is
    still redirected; the "not found" signature set covers en/de-DE text plus exit codes 9009/127
    only. Find a locale or loader shape that is still mis-attributed to the project. Reproduce with
    `node tooling/probes/v15-realworld-gate-env.mjs` (the measurement) and
    `node tooling/probes/v15-sealed-toolchain.mjs` (the fix and its stated limits).
12. **A false red in the discrimination overlay — CONFIRMED, now FIXED (audit finding 7); attack the
    fix.** The observation stands: a worker that wrote a genuinely discriminating check at
    `scripts/smoke-test.js` was refused `NOT PROVEN` although its check provably failed without the
    change and passed with it (`onboarding.ts:1790`, `:1382`). The discrimination surface is now
    anchored to a **sealed plan script's text** (digest-verified) instead of the path heuristic.
    **Still open to attack:** does that anchoring credit anything it should not — can a worker obtain
    **uncaveated** authority for evidence it authored itself? Reproduce with
    `node tooling/probes/v15-check-provenance.mjs` (CASE A/CONTROL and CASE B).
13. **The worker can re-seal its own authority.** In the wild, an agent ran `canary setup --yes`
    itself and sealed its own commit as the baseline, reaching a `PASS`. It is documented
    (`docs/EXECUTION-AUTHORITY.md:78-92`), but decide for yourself whether documenting it is enough.

## 8. Current state of this candidate, in four categories

**CLOSED — the seven audited findings** (independent audit of `a004f55`; reproduced, fixed and
regressed here). Each row of the closure table carries its own regression command and its own
remaining limitation: [`POST-AUDIT-CLOSURE-1.5.md`](POST-AUDIT-CLOSURE-1.5.md),
[`CLAIM-EVIDENCE-MATRIX-1.5.md`](CLAIM-EVIDENCE-MATRIX-1.5.md) §H. Two of them are
**claim** corrections rather than boundary changes (finding 5), and one is a **harness** gap, not a
product defect (the no-git fixture). "Closed" means *closed for the measured and reproduced cases* —
each row states where its fix stops.

**OPEN — one unexplained result, and it is containment-shaped:** the intermittent Windows
descendant-sweep failure in §7.0. It did not recur; **no product change was made between the failing
run and the green one**, so the green leg is not evidence of a fix. The failure diagnostic was
improved so the next occurrence distinguishes the four exclusion shapes — that improves
**observability only**, and it is **not** claimed to fix anything.

**UNSUPPORTED / UNMEASURED claims** — no everyday token-saving percentage (withdrawn, no
replacement); no correctness advantage (neither arm was more correct); no general real-world
overhead justification (H1–H5 returned `NOT PROVEN` on correct agent code); Cursor unmeasured
(absent from the author's host); HARDENED measured on one host only; Linux runtime verification not
performed.

**Release state:** **NOT TAGGED, NOT RELEASED, NOT MERGED.** `main` is `4271e6e` (`v1.4.0`, the
latest published artifact). The audited code commit is `e51b6fc` — **all six CI legs green there**,
including the Windows core leg as a **terminal** success (1,211 tests, 1,206 pass, 0 fail, 5 skipped,
170.9 min of a 300-min cap). Every later commit on this branch is **documentation only** and is not
covered by that run.

**What has run, so you do not have to wonder:** full unit suite (1,284 pass / 0 fail / 4 skipped),
productization battery (104 PASS / 0 FAIL / 3 SKIP), mutation/security gates, HARDENED live 6/6,
first-run 66/0/0, the five v1.5 probes, and CI. A gate with no result is not a pass — which is why
the sweep result above is written as OPEN rather than as green.
