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

# 2. Re-print the per-control table from the last signed transcript
node tooling/probes/v15-hardened-boundary.mjs --from-saved

# 3. Token benchmark: recompute every published figure from the RAW trial records
node tooling/probes/v15-everyday-aggregate.mjs

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
VERDICT / HOST / REPRO`, then `PASS 6 · FAIL 0 · HOST UNSUPPORTED 0`, and exits 0. Probe #3 prints
per-task and per-run ratios and fails if any published figure does not recompute.

## 5. Where the evidence lives

| Subject | Artefact |
|---|---|
| Claim/evidence matrix, all statuses | [`CLAIM-EVIDENCE-MATRIX-1.5.md`](CLAIM-EVIDENCE-MATRIX-1.5.md) |
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

1. **The token effect size.** Two runs, **n=1 per cell**, and the plain arm drifted **27 %** between
   runs on identical configuration — larger than the −16.79 % effect. Try to show the aggregate
   result is noise. If you can, the claim narrows to "direction only", and the docs should say that.
2. **`bug-sum` is more expensive with Canary in both runs** (+43.8 %, +22.5 %). Check whether the
   aggregate is carried entirely by `stateful-replay`; the docs say it is. If it is, say so louder.
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
8. **The first-run journey is on a synthetic scratch repository**, not a real one.
9. **Cursor is resolved by documentation, not by a run** — Cursor is absent from the author's
   machine. Verify the missing-primitive argument, and check the author did not merely assert it.
10. **The real-world evidence** depends on agent runs the author drove. Check for cherry-picking and
    whether "where Canary added no value" is reported honestly.

**Added after the real-world workstream — the three findings most worth attacking:**

11. **The sealed step's restricted environment (highest-value target).** Canary hands its sealed step
    PATH = `node_modules/.bin` + Node dir + System32/Windows only (12 entries against the shell's
    29): `python`, `python3`, `java`, `sh`, `bash` and **`git`** are invisible even when on PATH, and
    `JAVA_HOME` is stripped. Measured consequence: refactron's suite is **27 failed inside Canary, 0
    failed outside it**, while `canary setup` reports *"That is your project talking, not Canary"*.
    **Try to falsify whether that misattribution is real, and judge how many real projects this
    silently mis-gates.** Reproduce with `node tooling/probes/v15-realworld-gate-env.mjs`.
12. **A false red in the discrimination overlay.** A worker that writes a genuinely discriminating
    check at a path the overlay does not recognise as a test (`scripts/smoke-test.js`) is refused
    `NOT PROVEN` even though its check provably fails without the change and passes with it
    (`onboarding.ts:1790`, `:1382`). Attack whether the overlay's path heuristic is defensible.
13. **The worker can re-seal its own authority.** In the wild, an agent ran `canary setup --yes`
    itself and sealed its own commit as the baseline, reaching a `PASS`. It is documented
    (`docs/EXECUTION-AUTHORITY.md:78-92`), but decide for yourself whether documenting it is enough.

## 8. What the author knows is NOT verified

At the time this kit was written: the **full productization battery**, the **full unit suite**, the
**mutation/security gates**, the **CI legs** and the **Windows core leg** had **not** been run on the
final v1.5 tree, and v1.5.0 had **not** been tagged or released. A gate with no result is not a pass.
The matrix records each of these as `NOT RUN`.
