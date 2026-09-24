# Canary v1.5 — claim / evidence matrix

Every important public claim this release wants to make, with the evidence behind it, how to
reproduce it, what limits it, and its status. Statuses are the only five permitted:

**PROVEN BY CURRENT EVIDENCE** · **SUPPORTED BUT LIMITED** · **UNMEASURED** · **NOT SUPPORTED** ·
**REJECTED**

No claim below is listed as "basically works". Where this release does not have the evidence, the
status says so — that is the point of the table, not a gap in it.

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
| The controls rest on raw observations, not on booleans | `apps/cli/src/provider/production-measurement.ts:130-206` — every control re-derived from native return values and broker transcripts; per-control ACTUAL values printed by the probe | `node tooling/probes/v15-hardened-boundary.mjs --from-saved` | An auditor must read the validator to check this; the probe prints what it validated, not the whole validator. | **PROVEN BY CURRENT EVIDENCE** |
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
| The everyday path used **83.21 %** of Plain's tokens in aggregate (−16.79 %) over two runs, at equal correctness, no false done | `tooling/probes/v15-everyday-aggregate.mjs` recomputes every figure from the raw trial records and PASSes against the published numbers; `docs/BENCHMARK-EVERYDAY-1.5.md` | `node tooling/probes/v15-everyday-aggregate.mjs` | **n=1 per cell, 2 runs.** The plain arm drifted **27 %** between runs on identical configuration — larger than the effect. Direction measured; size unstable. | **SUPPORTED BUT LIMITED** |
| The standing MCP payload is **inside** that measurement | `agent.mcpToolsAdvertised` true for **3/3** guarded trials, false for **0/3** plain, recorded per trial; `agent.mcpConfig` set for guarded only | `node tooling/probes/v15-everyday-aggregate.mjs`; `node tooling/probes/v15-mcp-standing-payload.mjs` | Run 1 slightly predates the `mcpToolsAdvertised` field and is evidenced by `mcpConfig` alone; the probe states this. | **PROVEN BY CURRENT EVIDENCE** |
| The standing payload costs **~438 tokens** per session, measured provider-natively | `tooling/probes/v15-mcp-standing-payload.mjs`: mean 15,161 → 15,599; corroborated by the cached prefix differing by exactly **434** | `node tooling/probes/v15-mcp-standing-payload.mjs` | One model, one CLI version, one host. | **PROVEN BY CURRENT EVIDENCE** |
| The historical `5,726 bytes ≈ 1,432 tokens` | — | — | It was a `bytes ÷ 4` **derivation**, and it **overstated** the measured payload by **3.3×**. | **REJECTED** as a token figure |
| The historical **92.7 % / −7.3 %** is Canary's current footprint | — | — | Historical only: it excluded the standing payload. Marked superseded in `README.md` and `docs/RELEASE-1.4.md`. | **REJECTED** as a current claim |
| Canary saves **≥ 25 %**, or runs at **≤ 75 %** of Plain, in aggregate | — | `node tooling/probes/v15-everyday-aggregate.mjs` | The best measured aggregate is **83.21 %**, above the 75 % target. | **NOT SUPPORTED** |
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
| "The external audit has been performed" | **NOT SUPPORTED** — it has been *prepared and requested*, not performed. Only a reviewer outside this project can move this |
| Any seventh feature area | **REJECTED** — v1.5 has six workstreams and adds no seventh |

---

## What is NOT yet verified at the time of this matrix

Stated here rather than buried, because an audit kit that hides its own gaps is worthless:

| Item | Status |
|---|---|
| Full productization battery on the final v1.5 tree | **NOT RUN** at the time of writing (the tree changed after the last run) |
| Full unit suite on the final v1.5 tree | **NOT RUN** |
| Source/dist freshness (forced rebuild + dist tripwire) | **RUN** after the WS4 edits (build exit 0, first-run probe 58/0) but **must be re-run** after the claim-reset edits to `apps/cli/src/agents.ts` |
| CI legs for the v1.5 commit | **NOT RUN** — no push yet |
| Windows core leg reaching terminal SUCCESS for v1.5 | **NOT RUN** |
| Mutation / security gates on the final tree | **NOT RUN** |
| Real-world evidence (≥3 non-Canary repos, ≥6 agent tasks, false-done example) | **RUN** — `docs/REAL-WORLD-EVIDENCE-1.5.md`, bundle at `tooling/benchmark/results/session-evidence/v15-realworld/`. Findings in section G below |

**Consequence, stated plainly:** the gates that are `RUN` are green; the gates that are `NOT RUN`
have no result, and a gate with no result is not a pass. v1.5.0 must not be released, and has not
been.

---

## G. Real-world evidence — three defects the laboratory could not have found

`docs/REAL-WORLD-EVIDENCE-1.5.md`. Three non-Canary repositories (TypeScript/vitest, Java/Gradle,
Node ESM), six real agent tasks, and the originals verified untouched. **No natural false-done was
obtained, and none was manufactured** — the induced one is labelled `INDUCED` with a `LABEL.txt`
inside its artifact directory and must never be described as organic.

| FINDING | EVIDENCE | STATUS |
|---|---|---|
| **A worker that writes a genuinely discriminating check in the wrong directory is refused anyway** (a **false red**). H1's worker put a check at `scripts/smoke-test.js`; measured on its own commit it exits 0 with the fix and 1 without it, yet Canary returned `NOT PROVEN` because the discrimination overlay credits only `isTestPath` files (`onboarding.ts:1790`, `:1382`), which that path matches none of | bundle `runs/H1-hermes-maxagedays/`; doc §5.1, §6.3 | **CONFIRMED PRODUCT DEFECT** — not fixed in v1.5 |
| **The sealed step receives a restricted environment**, so Canary fails checks the project passes and blames the project. PATH is 12 entries against the shell's 29: `python`, `python3`, `java`, `sh`, `bash` and **`git`** are invisible even when on PATH, and `JAVA_HOME` is stripped. refactron's suite is **27 failed inside Canary, 0 failed outside**; `canary setup` reports *"That is your project talking, not Canary"* | `tooling/probes/v15-realworld-gate-env.mjs`; doc §4 | **CONFIRMED PRODUCT DEFECT** — not fixed in v1.5. Two of three real repositories could not be gated as found |
| **A sealed plan cannot distinguish "green" from "green because the demanding tests no longer run."** R1's agent converted 15 environment failures into explicit `it.skipIf` skips (27→12 failed, 96→111 skipped) — correct engineering, and invisible to the plan | bundle `runs/R1-refactron-pytest-ids/` | **CONFIRMED TEST/HARNESS LIMITATION** — disclosed, not fixed |
| **A worker can re-seal its own authority.** S1's agent wrote `canary.project.json`, ran `canary setup --yes` itself (43 mentions in its stream) and sealed baseline = its own commit `d7f6436`, reaching a `PASS` | bundle `runs/S1-schniedelsmp-idlookup/`; `docs/EXECUTION-AUTHORITY.md:78-92` | **DOCUMENTED LIMIT, NOW OBSERVED IN THE WILD** — not a new defect; the old framing was theory, this is an instance |
| Canary blocks a wrong "done" on real repositories | — | **UNMEASURED.** In 5 of 6 real tasks the gate did not fire in the blocking direction; the only block obtained was **induced** |
| Canary is worth its overhead on real work | — | **NOT SUPPORTED as a general claim.** H1–H5 all returned `NOT PROVEN` on **correct** agent code, and one of three repos could not be gated at all. This is a net cost on that population |
