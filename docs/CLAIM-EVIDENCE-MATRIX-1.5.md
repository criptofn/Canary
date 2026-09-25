# Canary v1.5 — claim / evidence matrix

Every important public claim this release wants to make, with the evidence behind it, how to
reproduce it, what limits it, and its status. Statuses are the only five permitted:

**PROVEN BY CURRENT EVIDENCE** · **SUPPORTED BUT LIMITED** · **UNMEASURED** · **NOT SUPPORTED** ·
**REJECTED**

No claim below is listed as "basically works". Where this release does not have the evidence, the
status says so — that is the point of the table, not a gap in it.

**State of this candidate:** the audited code commit is `e51b6fc` (all six CI legs green there);
later commits on the branch are documentation only. **v1.5 is not tagged, not released and not
merged** — `main` is still `4271e6e` (`v1.4.0`). One intermittent Windows containment-sweep failure
is **open and unexplained**; the everyday token-saving claim is **withdrawn with no replacement**.
Full evidence trail: [`POST-AUDIT-CLOSURE-1.5.md`](POST-AUDIT-CLOSURE-1.5.md).

Column notes: **EVIDENCE** names the artefact, not a promise. **REPRODUCE** is the exact command a
person outside this project runs. **LIMITATION** is part of the claim.

---

## A. Verification-gate claims (the product's core)

| CLAIM | EVIDENCE | REPRODUCE | LIMITATION | STATUS |
|---|---|---|---|---|
| A completion whose sealed checks fail is **blocked**, with a decision naming the failing check and an on-disk evidence file | `tooling/probes/v15-first-run.mjs` — block decision naming `tests (npm run test, exit 1)`; evidence file exists (1,898 B) and names both failing tests; `tooling/benchmark/results/session-evidence/v15-first-run-postbuild.txt` | `node tooling/probes/v15-first-run.mjs` | Measured on the Claude Code `Stop` hook shape and on a driven `canary checkpoint`. `stop_hook_active` prevents a second block. | **PROVEN BY CURRENT EVIDENCE** |
| A green plan that cannot discriminate the change is **NOT PROVEN**, never READY | `v15-first-run.mjs` ("doctor refuses a green plan as a proven task"); unbound-requirement path in the same probe | `node tooling/probes/v15-first-run.mjs` | Requires the change to be classifiable; check-only/prose/licence/generated changes are exempt by design. | **PROVEN BY CURRENT EVIDENCE** |
| `uninstall` removes Canary's entries and **preserves the user's own** hook, permissions and MCP server | `v15-first-run.mjs` — deep JSON equality of the user's three files before/after; `.canary` removed | `node tooling/probes/v15-first-run.mjs` | Measured for the file shapes the probe seeds (Claude Code settings, Codex hooks, MCP server entry). | **PROVEN BY CURRENT EVIDENCE** |
| No output claims `HARDENED` unless all six controls are measured available | `apps/cli/test/provider-status.test.ts` (12/12), asserting the positive claim string is absent and `status`/`exitCode` stay `NOT CONNECTED`/`2` | `node --test apps/cli/dist/test/provider-status.test.js` | The gate is structural (`measuredCapabilities` is all-or-nothing), not a wording convention. | **PROVEN BY CURRENT EVIDENCE** |

## B. HARDENED boundary claims

| CLAIM | EVIDENCE | REPRODUCE | LIMITATION | STATUS |
|---|---|---|---|---|
| All six boundary controls hold on a real host, measured | `tooling/probes/v15-hardened-boundary.mjs`: **6/6 PASS**, exit 0; 57 attacks executed/57 blocked, 45 positive controls, 0 failures, 0 inconclusive; full record in `tooling/benchmark/results/session-evidence/v15-hardened-boundary-fresh.txt` | `node tooling/probes/v15-hardened-boundary.mjs` | One host (Windows 10.0.26200). The measurement is **disposable**: it installs no service. A host that cannot confine is reported `HOST UNSUPPORTED` (exit 3), never PASS. | **PROVEN BY CURRENT EVIDENCE** |
| The controls rest on raw observations, not on booleans | `apps/cli/src/provider/production-measurement.ts:130-206` — every control re-derived from native return values and broker transcripts; per-control ACTUAL values printed by the probe | `node tooling/probes/v15-hardened-boundary.mjs` (live) — `--from-saved` prints the same table as **HISTORICAL** and exits 2, never as a current PASS | An auditor must read the validator to check this; the probe prints what it validated, not the whole validator. **v1.5 post-audit:** `--from-saved` previously presented a stale OS-temp transcript as a current `PASS` while the live store said `LOCAL` 0/6; that is fixed and regressed | **PROVEN BY CURRENT EVIDENCE** |
| `networkEgress` is denied by a **named** mechanism — a bare timeout earns nothing | Probe ACTUAL: control `CONNECTED`; restricted `TIMEOUT` with `isolationError=2, diagnosticReturn=0`; validator at `production-measurement.ts:170-175` | as above | Covers controlled TCP only. IPv6, UDP, DNS rebinding, proxies and redirects are out of scope. | **SUPPORTED BUT LIMITED** |
| A host that cannot execute inside the confinement is reported as unsupported, not as a pass | `apps/cli/test/confined-activation.test.ts:42-75` — named, counted host-bound SKIP; CI capability probe exports the reason | `node tooling/probes/v12-production-authority.mjs --capability` (exit 3 on such a host) | The GitHub-hosted `windows-latest` image measurably cannot confine (raw `EPERM`). | **PROVEN BY CURRENT EVIDENCE** |
| A **persistent, machine-wide** HARDENED service is installed | — | `canary provider install-plan` prints steps and executes nothing; `canary provider status --verbose` shows `service installed=false` | — | **NOT SUPPORTED** (explicitly not claimed) |
| Administrator resistance | — | — | The trusted operator/broker is the normal user; a local administrator can reconfigure the boundary. | **NOT SUPPORTED** |
| Linux runtime verification | `hostVerified: false` in the Linux enforcement code | — | Not verified on Linux at all. | **UNMEASURED** |

## C. Cursor

| CLAIM | EVIDENCE | REPRODUCE | LIMITATION | STATUS |
|---|---|---|---|---|
| Cursor's state is resolved, not left vague | `docs/CURSOR-1.5.md` — `CURSOR: NOT SUPPORTED / NOT MEASURABLE` with the missing primitive named | read the doc; re-measure with the commands it records on a host that HAS Cursor | On **this** host Cursor is absent, so nothing about Cursor behaviour was observed. The primitive is identified from Cursor's public documentation, not from a run. | **SUPPORTED BUT LIMITED** |
| Cursor cannot be gated because it has no completion hook | `docs/CURSOR-1.5.md` §3 — **this hypothesis is FALSE and the doc says so** | Cursor's own hook documentation | Cursor *does* document a `stop` hook and the block→follow-up mapping. | **REJECTED** |
| Cursor is protected / integrated by this build | — | — | Nothing in Canary writes, reads or binds anything Cursor-specific beyond a detection heuristic; `setup` writes only `.claude/settings.json`, `.codex/hooks.json`, `.mcp.json`. | **NOT SUPPORTED** |
| Absence of a `.cursor/` directory means a repository is unprotected | — | — | Absence of configuration is never evidence of protection; `canary agents` says `UNMEASURED`, which is honest. | **REJECTED** (as an inference) |

## D. Token accounting claims

| CLAIM | EVIDENCE | REPRODUCE | LIMITATION | STATUS |
|---|---|---|---|---|
| The everyday path used **83.21 %** of Plain's tokens in aggregate (−16.79 %), at equal correctness, no false done | `tooling/probes/v15-everyday-aggregate.mjs` recomputes every figure from the raw records, and **asserts this figure is not reproducible from eligible cells**; `docs/BENCHMARK-EVERYDAY-1.5.md` | `node tooling/probes/v15-everyday-aggregate.mjs` | **Withdrawn** (audit finding 2): the aggregate pooled a **fallback-estimator** cell, and the replacement run's six cells carry **five instrument digests** — the tree was edited while it measured. Kept only as the record of what was published and why it failed. | **REJECTED / WITHDRAWN** — it may not be quoted as Canary's current footprint |
| An everyday token-saving effect is **resolvable** from the current data | `tooling/probes/v15-everyday-aggregate.mjs` prints **no ratio** for an INCOMPLETE run; the rule lives in `tooling/benchmark/eligibility.mjs`; four raw runs in `tooling/benchmark/results/v15-everyday*.json` | `node tooling/probes/v15-everyday-aggregate.mjs` | **Two COMPLETE runs disagree in sign: 80.74 % (−19.26 %) and 102.91 % (+2.91 %, Canary more expensive).** `r2` and `r3` are **INCOMPLETE** (fallback ledger; five instruments) and contribute **no ratio at all**. Pooling the complete runs gives 89.81 % (−10.19 %), which is **smaller than the spread between runs of the identical configuration** — 22.17 points against **44.3 % drift in the plain arm alone** (376,688 → 543,518). At **n=1 per cell** this benchmark cannot resolve an effect of this size in either direction, and **no replacement percentage was selected after seeing the data**. | **NOT SUPPORTED** — **no everyday token-saving percentage is claimed** |
| The standing MCP payload is **inside** the measured sessions | `agent.mcpToolsAdvertised` true for **6/6** guarded trials, false for **0/6** plain, recorded per trial; `agent.mcpConfig` set for guarded only | `node tooling/probes/v15-everyday-aggregate.mjs`; `node tooling/probes/v15-mcp-standing-payload.mjs` | An observation **about the sessions** that stands independently of the withdrawn ratio: it says the payload was present and counted, **not** that Canary saved anything. Run 1 slightly predates the `mcpToolsAdvertised` field and is evidenced by `mcpConfig` alone; the probe states this. | **PROVEN BY CURRENT EVIDENCE** |
| The standing payload costs **~438 tokens** per session, measured provider-natively | `tooling/probes/v15-mcp-standing-payload.mjs`: mean 15,161 → 15,599; corroborated by the cached prefix differing by exactly **434** | `node tooling/probes/v15-mcp-standing-payload.mjs` | One model, one CLI version, one host. It measures **what the payload costs**, never a saving. | **PROVEN BY CURRENT EVIDENCE** |
| The historical `5,726 bytes ≈ 1,432 tokens` | — | — | It was a `bytes ÷ 4` **derivation**, and it **overstated** the measured payload by **3.3×**. | **REJECTED** as a token figure |
| The historical **92.7 % / −7.3 %** is Canary's current footprint | — | — | Historical only: it excluded the standing payload. Marked superseded in `README.md` and `docs/RELEASE-1.4.md`. | **REJECTED** as a current claim |
| Canary saves **≥ 25 %**, or runs at **≤ 75 %** of Plain, in aggregate | — | `node tooling/probes/v15-everyday-aggregate.mjs` | **No current aggregate exists at all.** The 83.21 % this row used to be measured against is withdrawn, and the two COMPLETE replacement runs disagree in sign; the ≤ 75 % target was never met by any eligible dataset. | **NOT SUPPORTED** |
| **"Up to 87 %"** is typical or universal | `docs/V1.3-PRODUCT-AUDIT.md` | — | It is the best pairing in a 3×3 replication of one favourable cell; the long task is repeatedly *more* expensive. Kept only with its qualifiers. | **REJECTED** as typical |
| Token accounting is provider-native, not estimated | `tooling/benchmark/stream.mjs:207-212` reads `result.usage`; no estimator enters a headline | read the code | The CLI does not itemise system context or the per-turn re-sent payload, and per-message usage in the stream is partial and never summed. Those components are **inside** the totals but unattributed. | **SUPPORTED BUT LIMITED** |

## E. Release / provenance claims

| CLAIM | EVIDENCE | REPRODUCE | LIMITATION | STATUS |
|---|---|---|---|---|
| v1.4.0 is published with the recorded bytes | Anonymous `GET /releases/tags/v1.4.0` → **200**, `draft=false`, `latest=v1.4.0`, 2 assets; downloaded asset = **208,993 B**, SHA-256 `42ed2056…` equal to the sidecar and to an independent computation | `gh release download v1.4.0` then hash it | The published digest is the **Linux CI** build. A Windows source build produces **209,117 B** / `f82203f3…` (see next row). | **PROVEN BY CURRENT EVIDENCE** |
| Packaging is byte-identical across hosts | — | — | **Cause measured:** `core.autocrlf=true` makes a Windows checkout materialise the packed text files with CRLF while Linux has LF; 13 of 16 entries differ by exactly their CRLF count (1,509 B uncompressed → 124 B gzipped). `dist/main.js`, `LICENSE`, `package.json` are identical. | **REJECTED** — recorded as a known limitation in `docs/RELEASE-1.4.md` |
| The v1.4.0 release was visible to the public when first reported | — | — | It was a **DRAFT** until 2026-09-24: anonymous `GET` returned 404 and `releases/latest` still resolved to v1.3.0. The earlier report saying "not draft" was wrong. Root cause was in `release.yml` (`gh release view` succeeds on a draft, so the create was skipped); fixed in v1.5. | **REJECTED** — corrected |
| An attestation covers the published artifact only | `actions/attest-build-provenance` over `pack/npm/*.tgz` in the release workflow | read `.github/workflows/release.yml` | A locally built tarball must never be presented as carrying that provenance. | **PROVEN BY CURRENT EVIDENCE** |

## F. Claims this release explicitly does NOT make

| NON-CLAIM | STATUS |
|---|---|
| "Canary makes code correct" | **NOT SUPPORTED** — no correctness advantage was observed; both arms were equally correct in the benchmark |
| "Canary never allows a false done" | **NOT SUPPORTED** — measured false done was **0** in both arms of this benchmark, which is an observation, not a guarantee. In 6 of 6 cells the gate never even fired |
| "HARDENED is available everywhere" | **REJECTED** — a host that cannot confine is `HOST UNSUPPORTED`, exit 3 |
| "Canary is always cheaper" | **NOT SUPPORTED** — on `bug-sum` it was more expensive in **both** runs (+43.8 %, +22.5 %) |
| "The external audit has been performed" (of **these** bytes) | **NOT SUPPORTED** — one independent audit of `a004f55` has been performed and closed (section H), and a second-auditor pass on the new head is **still pending**. An audit of older bytes is not an audit of these bytes |
| Any seventh feature area | **REJECTED** — v1.5 has six workstreams and adds no seventh |

---

## Verification state at this matrix's revision — which commit each result covers

Stated here rather than buried, because an audit kit that hides its own gaps is worthless.
**Which bytes a result covers is part of the result.** The CI evidence below covers the
**code** commit `e51b6fc`; every later commit on this branch is documentation only and is
**not** covered by that run.

| Item | Status |
|---|---|
| Full productization battery on the final v1.5 tree | **RUN — GREEN.** **104 PASS / 0 FAIL / 3 SKIP**, exit 0, 91.4 min, on `e51b6fc`. An earlier attempt was stopped deliberately at **25 probes / 341 PASS / 3 FAIL / 6 SKIP** so the one real defect it found could be fixed without corrupting the run (`session-evidence/v15-final-verify-productization.log`); the fix is described below, and the battery was then re-run to green |
| Full unit suite on the final v1.5 tree | **RUN — GREEN.** 1,288 tests / 216 suites: **1,284 pass, 0 fail, 4 skipped**, exit 0, on `e51b6fc` |
| Source/dist freshness | **RUN.** A forced rebuild was required: the first `tsc -b` reported exit 0 **without re-emitting** the changed module — the documented v1.2 trap. With `tsc -b <pkg> --force`, the emitted file carries the change, and `v12-dist-tripwire.mjs` reports **PASS (38 files)** |
| CI legs for the v1.5 code commit | **RUN — ALL SIX GREEN** on `e51b6fc` (run [`36131430147`](https://github.com/criptofn/Canary/actions/runs/36131430147)): core ubuntu, core windows, standalone ubuntu/windows/macos, golden proof. The branch head `a803132` is **documentation-only after that commit** and no CI run covers it |
| Windows core leg reaching terminal SUCCESS for v1.5 | **RUN — SUCCESS** on `e51b6fc`: **1,211 tests, 1,206 pass, 0 fail, 5 skipped**, **170.9 min** against a 300-min cap, **zero `not ok`** lines. The leg is **terminal** — completed, not timed out, not cancelled |
| The intermittent Windows descendant-sweep failure | **OPEN / UNEXPLAINED / DID NOT RECUR.** One hosted run failed `sweepDescendants finds and kills a live parent's child process` (`sweep killed [7564] but not 2144`, 35,980 ms); the next run was green with **no product fix in between** — the only delta was a **test-failure diagnostic**, which cannot change product behaviour. **Green is not fixed**, a missed descendant is a containment concern, and it is the first thing a second audit should try to reproduce. 14 local attempts (idle, 48-way load, 2-core pinned) could not reach it |
| HARDENED boundary, live | **RUN — GREEN 6/6** on the measured host (`v15-hardened-boundary.mjs`, exit 0). Disposable measurement; a host that cannot confine is `HOST UNSUPPORTED`, never PASS |
| Mutation / security gates | **RUN — GREEN** inside the battery: master-pass mutation battery, 1.1 P0 trust-boundary mutations, M10.2 adversarial authority, dist-mutation guard, HARDENED provider boundary, architecture closure matrix |
| Real-world evidence (≥3 non-Canary repos, ≥6 agent tasks, false-done example) | **RUN** — `docs/REAL-WORLD-EVIDENCE-1.5.md`, bundle at `tooling/benchmark/results/session-evidence/v15-realworld/`. Findings in section G below |
| An everyday token-saving percentage | **NOT CLAIMED.** Two COMPLETE runs disagree in sign, and n=1 per cell cannot resolve the effect (section D) |
| The v1.5 release itself | **NOT TAGGED, NOT RELEASED, NOT MERGED.** `main` remains at `4271e6e` (`v1.4.0`) |

### The one real battery FAIL, and its fix

`v13-everyday-vocabulary.mjs` pins a **budget of 13** internal terms in the ordinary path, set from
the v1.4 measurement. It **passed in all four v1.4 release logs** and failed on the v1.5 tree with
**19**. A per-command diff against the v1.4 breakdown isolated it to the v1.5 §4B/§4C wording fixes,
which used the word "sealed" where plain language says the same thing (`setup --yes` 0→2, `agents`
0→4; `status`, `doctor` and the completion gate unchanged at 7/1/5).

Three user-facing strings were reworded; **no fact and no action changed**, and **the budget was not
raised** — raising it would have been the gate-weakening this repository forbids. Re-measured after a
forced rebuild: **TOTAL 13, identical to the v1.4 distribution, probe PASS, exit 0**, with the probe
still confirming the internals stay reachable under `--verbose` and that the JSON envelope is
unchanged by the prose.

This is worth reading as evidence **about the process**: a release preparing to claim it had made
messaging clearer was caught making the user decode **six more internal terms**, by a ratchet set
from a measurement rather than from an ambition.

**Consequence, stated plainly:** every gate listed above as `RUN` is green, and the one result that
is **not** green — the intermittent Windows sweep — is recorded as **open and unexplained** rather
than as a pass that was re-rolled until it appeared. Where this release has no evidence it says
**no claim**, which is why the everyday token figure is now absent rather than smaller. **v1.5.0 has
not been released, tagged or merged, and is waiting on an external audit.**

---

## G. Real-world evidence — three defects the laboratory could not have found

`docs/REAL-WORLD-EVIDENCE-1.5.md`. Three non-Canary repositories (TypeScript/vitest, Java/Gradle,
Node ESM), six real agent tasks, and the originals verified untouched. **No natural false-done was
obtained, and none was manufactured** — the induced one is labelled `INDUCED` with a `LABEL.txt`
inside its artifact directory and must never be described as organic.

| FINDING | EVIDENCE | STATUS |
|---|---|---|
| **A worker that writes a genuinely discriminating check in the wrong directory is refused anyway** (a **false red**). H1's worker put a check at `scripts/smoke-test.js`; measured on its own commit it exits 0 with the fix and 1 without it, yet Canary returned `NOT PROVEN` because the discrimination overlay credits only `isTestPath` files (`onboarding.ts:1790`, `:1382`), which that path matches none of | bundle `runs/H1-hermes-maxagedays/`; doc §5.1, §6.3 | historical observation → **CONFIRMED PRODUCT DEFECT** → fixed as audit **finding 7**: the discrimination surface is anchored to a **sealed plan script's text** (digest-verified) instead of a path heuristic → regression `tooling/probes/v15-check-provenance.mjs` (CASE A + CONTROL) → **FIXED + REGRESSED** for the measured cases. **Limitation:** this widens which checks can discriminate; it never widens *authority* — worker-authored evidence is still caveated and is never silently upgraded to independent |
| **The sealed step receives a restricted environment**, so Canary fails checks the project passes and blames the project. PATH is 12 entries against the shell's 29: `python`, `python3`, `java`, `sh`, `bash` and **`git`** are invisible even when on PATH, and `JAVA_HOME` is stripped. refactron's suite is **27 failed inside Canary, 0 failed outside**; `canary setup` reports *"That is your project talking, not Canary"* | `tooling/probes/v15-realworld-gate-env.mjs`; doc §4 | historical observation → **CONFIRMED PRODUCT DEFECT** → fixed as audit **finding 6**: an **operator-authorized** toolchain directory is appended *after* the trusted Node/OS dirs, and a step that cannot resolve a required program is attributed to the environment (`SEALED ENV CANNOT RESOLVE`) instead of the project → regression `tooling/probes/v15-sealed-toolchain.mjs` (the suggested remediation is checked to make the same check PASS inside Canary) and `apps/cli/test/v15-sealed-toolchain.test.ts` **25/25** → **FIXED + REGRESSED for the tested cases**. **Limitations, stated:** authorization is an **operator act**, not automatic; there is no `JAVA_HOME` handling; `HOME` is still redirected; the not-found signature set covers en/de-DE text plus exit 9009/127 only; and the three real repositories were **not** re-run with an authorized directory, so **no claim is made that they now gate** |
| **A sealed plan cannot distinguish "green" from "green because the demanding tests no longer run."** R1's agent converted 15 environment failures into explicit `it.skipIf` skips (27→12 failed, 96→111 skipped) — correct engineering, and invisible to the plan | bundle `runs/R1-refactron-pytest-ids/` | **CONFIRMED TEST/HARNESS LIMITATION** — disclosed, not fixed |
| **A worker can re-seal its own authority.** S1's agent wrote `canary.project.json`, ran `canary setup --yes` itself (43 mentions in its stream) and sealed baseline = its own commit `d7f6436`, reaching a `PASS` | bundle `runs/S1-schniedelsmp-idlookup/`; `docs/EXECUTION-AUTHORITY.md:78-92` | **DOCUMENTED LIMIT, NOW OBSERVED IN THE WILD** — not a new defect; the old framing was theory, this is an instance |
| Canary blocks a wrong "done" on real repositories | — | **UNMEASURED.** In 5 of 6 real tasks the gate did not fire in the blocking direction; the only block obtained was **induced** |
| Canary is worth its overhead on real work | — | **NOT SUPPORTED as a general claim.** H1–H5 all returned `NOT PROVEN` on **correct** agent code, and one of three repos could not be gated at all. This is a net cost on that population |

---

## H. Post-audit closure — independent GPT-5.6 audit of `a004f55`

An independent auditor reproduced four new blockers and the three known real-world defects on
commit `a004f5544af6ea62e1f3a4c036af8c8358e23462`. Each was reproduced here on those exact bytes,
classified, fixed with the smallest safe correction, and regressed. **The audit was right on every
finding it raised**, including one where the defect was in *this candidate's own published claim*.

| # | FINDING | AUDITOR | THIS CLOSURE | STATUS AFTER FIX |
|---|---|---|---|---|
| 1 | Rewritten **existing** check inherited independent authority (false GREEN) | CONFIRMED TRUST-BOUNDARY DEFECT, HIGH | Root cause: `addedChecks` recorded only files **absent at baseline**, so a worker that *rewrote* a recognized check got an uncaveated *"evidence about this change"*. Provenance is now decided by git (`addedChecks` vs new **`modifiedChecks`**) and **both** are worker-authored evidence | **FIXED + REGRESSED** — `v15-check-provenance.mjs` 7/7; the audited build contains **zero** of the new identifiers, so it could not have passed |
| 2 | Headline pooled a **fallback-estimator** cell | CONFIRMED | Worse than reported: `usage.source` was `streamed per-message usage (no result event)` with `streamedUsageUsable:false`. New `tooling/benchmark/eligibility.mjs`; a cell needs a completed run on the declared ledger, and a run needs **all cells on one instrument** | **FIXED + REGRESSED** — but see the TOKEN row below: **the claim did not survive the fix** |
| 3 | `--from-saved` printed a stale transcript as a current `PASS` | CONFIRMED (product validator NOT bypassed) | `--from-saved` is now **HISTORICAL, non-authoritative**: exit **2**, every row `HISTORICAL`, and it prints its own disproof (854.3 min old vs a 15-min ceiling; recorded store gone). A **failed live battery now exits 4** instead of falling through to an older file | **FIXED + REGRESSED** — `hardened-evidence.test.mjs` 11/11 |
| 4 | Two R1 attempts **mixed** into one output directory | CONFIRMED | One attempt per directory with **refusal on existing evidence**; regression 22 PASS / 0 FAIL. **R1 attempt 1's raw record is NOT on disk and CANNOT be reconstructed** — attempt 2 truncated it. This is stated plainly; nothing was reconstructed | **FIXED + REGRESSED** (the historical gap is documented, not invented) |
| 5 | `LOCAL` described as worker-independent proof | EXPECTED ONBOARDING BEHAVIOUR, but **CLAIM TOO STRONG** | LOCAL proof is now stated as **same-user / operator-selected**, with `HARDENED` kept as the worker-independent path | **FIXED + REGRESSED** — `apps/cli/test/local-authority-same-user.test.ts` 5/5. **This is a claim correction, not a boundary:** at LOCAL the same user can still replace the store, the key and the ledger together, and a worker holding that user's authority can still re-seal its own commit (observed in the wild — section G) |
| 6 | Sealed step loses `python`/`java`/`git`; Canary blamed the project | CONFIRMED PRODUCT DEFECT | an operator-authorized directory is **appended after** the trusted Node/OS dirs (never in front — anti-shadowing asserted) and refused inside the repository; attribution now says `SEALED ENV CANNOT RESOLVE` when Canary's restriction is the cause, and `PROJECT CHECK FAILURE` only when the project genuinely failed | **FIXED + REGRESSED for the tested cases** — `v15-sealed-toolchain.mjs` PASS (the suggested remediation is measured to make the same check pass inside Canary), `apps/cli/test/v15-sealed-toolchain.test.ts` **25/25**. **Limitations:** authorization is an **operator act**; no `JAVA_HOME` handling; `HOME` still redirected; not-found signatures cover en/de-DE text plus exit 9009/127 only; the three real repositories were **not** re-run with an authorized directory |
| 7 | Legitimate sealed-script check outside a test path = false red | CONFIRMED | Fixed **together with #1** by anchoring check surface to a **sealed script's text** rather than a path heuristic. Less false red, **no** more false green | **FIXED + REGRESSED** — same probe, CASE A/CONTROL |
| — | No-git first-run fixture was inside an ancestor repo | harness gap | Fixture now proven repo-free (`rev-parse` fails **and** no ancestor `.git`); final run 66 PASS / 0 FAIL. **Product was correct** — this was never a product defect | **FIXED + REGRESSED** |

### The token claim did not survive its own fix

| CLAIM | STATUS |
|---|---|
| `83.21 % of Plain, −16.79 %` (v1.5 candidate) | **REJECTED / WITHDRAWN.** Mixed accounting (finding 2). Withdrawn in `README.md`, `docs/BENCHMARK-EVERYDAY-1.5.md` and here; the aggregate probe asserts the figure is **not reproducible** from eligible cells |
| The replacement dataset supports a saving | **NOT SUPPORTED.** `r3` looked measurable but its six cells carry **five instrument digests** — the tree was edited while it measured — so it is **INCOMPLETE** and contributes no ratio. Its arithmetic, for the record only, was **120.43 % (Canary MORE expensive)**. The two **COMPLETE** runs are **80.74 % (−19.26 %)** and **102.91 % (+2.91 %)**: they disagree in **sign**. Spread **22.17 points** against **44.3 % drift in the plain arm alone** (376,688 → 543,518) |
| Any current everyday token figure | **NONE IS CLAIMED.** Not a smaller saving, not a different percentage — none. The pooled 89.81 % (−10.19 %) is an **observation with a limitation, not a result**: it is smaller than the spread between runs of the identical configuration, and the probe prints that warning itself. At n=1 per cell on Canary-authored fixtures this benchmark cannot resolve an effect of this size in either direction. A replacement needs several complete runs against a **frozen** tree; that has not been produced, and **no percentage was selected after seeing the data** |
| The standing MCP payload is inside the measured sessions and costs ~438 tokens | **PROVEN BY CURRENT EVIDENCE** — **6/6** guarded trials advertised `mcp__canary`, **0/6** plain; **~438 tokens** measured provider-natively, not the ~1,432 `bytes ÷ 4` implied. **Scope:** this is a measurement of the payload's *cost and presence*, not of any saving — it survives the withdrawal of the ratio it used to sit under |
