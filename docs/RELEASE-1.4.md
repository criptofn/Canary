# Canary 1.4.0 — "last known-gaps release"

> **Status: RELEASE CANDIDATE. Not published.** These bytes are frozen on branch
> `codex/v14-last-known-gaps`. There is no tag, no GitHub release and no push of this branch.
> The newest *published* artifact remains `v1.3.0`.

v1.4 closes the concrete product gaps that were already known after v1.3. It is the last planned
internal development release: after it, the next phase is real repositories, real agent runs and
evidence-driven feedback. It invents no roadmap beyond that.

## What this release is for

Two goals, in the product's priority order: preserve the trust invariants exactly, and remove the
known gaps. Nothing here adds authority to a worker, weakens a gate, or turns a measurement into a
claim it cannot support.

**No root-of-trust weakening occurred.** The completion gate is the same `checkpoint`
implementation it was in v1.3. The only new writer is the Codex hook file, and it follows the same
containment discipline as every other Canary write (link refusal, backup, ownership recorded so
`uninstall` removes exactly Canary's entries). The full trust battery — mutation batteries,
authority guards, adversarial authority, poisoned-environment authority, trust-boundary mutations,
dist-mutation guard, architecture closure, provider boundary and production custody — passes on
these bytes.

## The token position (read this before quoting any number)

**The everyday token result is roughly parity with a modest saving, and that is the whole claim.**

| | model tokens |
|---|---|
| Plain (not using Canary at all) | 409,824 |
| **Canary, everyday path** | **379,792 — 92.7 %** |

That is **7.3 % lower in aggregate**, with individual measured tasks ranging from **17.1 % lower to
essentially parity (+0.02 %)**. Correctness was equal on the measured benchmark and there was no
false done in either arm. **This release does not claim the everyday path is never more expensive
on any task**, and it does not claim any correctness advantage — none was demonstrated, because the
untreated arm was already correct.

**The previous 7.3 % figure excluded a real cost, and that is now stated rather than left in an
appendix.** It was measured with the agent launched *without* the MCP server, so it omits a standing
payload paid **every turn**: 5,726 bytes (1,475 B of instructions + 4,251 B of tool definitions), of
which 1,923 B (33.6 %) is expert-only ceremony an everyday user never calls. **The real everyday
footprint is therefore somewhat worse than 92.7 %, not better.**

**There is no ≤ 75 % claim and no ≥ 25 % claim.** The token-optimisation target was **rejected with
evidence**, not deferred: two independent routes to a lower number were measured before this
release — removing the entire standing MCP payload returns about **2 points**, and eliminating the
repair turn entirely is about **5.9 %** and was described in the v1.3 audit as "an upper bound on an
impossible act". Their impossible sum lands near **85 %**. Reaching 75 % would require the agent to
do materially less work, i.e. to remove verification, which the priority order forbids. No further
clean gain was demonstrated, so **no further token work was done**: a smaller number bought by
weakening the gate is not a win.

## Codex is the second measured integration

Canary is a safety engine with thin agent adapters. Until v1.4 that was asserted with one data
point. Now `canary setup` also writes a `Stop` hook into the project's `.codex/hooks.json`, running
the **same** `checkpoint` — one implementation, no fork, no new authority — and it was **measured on
a real `codex exec` session** (`codex-cli 0.154.0`): the hook was executed twice, once blocking
(`{"decision":"block","reason":…}` on stdout, exit 0) and once with `stop_hook_active: true`
allowing, with the harness **continuing the turn** on Canary's reason.

Two measured caveats ship on the capability row itself, not in a footnote:

- **Codex runs a project hook only after a one-time review and trust (`/hooks`).** Until that
  happens the hook is written and **gates nothing**.
- Codex has **two** trust layers: a project `.codex/` layer that is not loaded at all until the
  *project* is trusted, and the per-hook record. `--dangerously-bypass-hook-trust` covers only the
  second.

Also measured: Codex **rejects an entire `hooks.json` that carries an unknown top-level field**, so
Canary's writer emits only `hooks` and preserves everything else in the file.

`canary agents` prints the real table for the repository in front of you and never reports an
advisory integration as if it could gate.

## Cursor remains external-test-required

Cursor is still reported as **UNMEASURED**, and no protection is claimed for it. No Cursor host was
available to test on (`cursor-agent` and `cursor` are absent from PATH, and none of the four known
Cursor directories exists on the machine this release was built on). **The measurement was not
faked.** The procedure for whoever has a Cursor host is recorded in
[`V1.4-GAP-AUDIT.md`](V1.4-GAP-AUDIT.md) (Gap B).

## CI debt was materially reduced

v1.3 shipped with red CI. v1.4 root-caused every red job and classified it. Five distinct defects:

- the `standalone` job pinned **Node 22**, but `--build-sea` was **added in Node v25.5.0** — so the
  job asked an incapable runtime to build the artifact and then reported the artifact as broken
  (every leg failed with `status 9` and no explanation). **Fixed** (Node 26.3.0, plus a WHAT/WHY/
  WHAT-TO-DO refusal in the tool).
- three test files asserted `setup` exits 0 while their fixtures never declared a harness, so they
  passed only on a developer machine that had Claude Code installed. **The same defect was in the
  benchmark harness and 32 probe files.** All **fixed**, and the fix is proven load-bearing by a
  discrimination control run with an empty `HOME`.
- a Windows-only suite failed ~50 lines off Windows instead of skipping. **Fixed** with an explicit
  `{ skip }` carrying the same reason — a **SKIP is never a PASS**, and the guard is kept so the
  suite still fails loudly if the skip is removed.
- two tests asserted Windows-specific values against host-dependent results (`gradlew` vs
  `./gradlew`; the Windows provider step ids). **The product was right both times**; the tests now
  assert host-correct values, and the provider test covers the Linux `egress-policy` step it
  previously missed.
- the Windows CI leg was cancelled by its 30-minute cap on every push. Measured: the same commit
  takes ~80 s on ubuntu, while on the GitHub-hosted Windows runner individual tests stalled for
  **92 s – 24 min** against **115 ms – 2.2 s** on a developer Windows machine. Classified a **host
  limitation** (not a product or test defect), documented in the workflow with that profile, and
  given a budget so the leg **runs to completion and reports a named verdict** instead of being
  cancelled.

**No assertion was deleted, relaxed, or skipped into a pass anywhere in this release.**

## Beginner UX and low-evidence repositories

**Beginner UX improved without weakening meaning.** The everyday path no longer opens with
internal vocabulary: `setup`'s trust-store refusal and its seal refusal (previously
`REFUSED — <raw internal throw>`), `canary result`'s "no sealed checks, no proof, no result", and
the last-resort handler (previously a bare `ERROR: <internal text>`) are translated. **Every message
keeps its exact exit code**, its factual content and its actionable next step, and the internal
detail moved behind the existing `--verbose` flag. Where an operator workflow *parses* the text
(`unbound: <digest>`, `available to bind:`), the lines were left byte-exact on purpose: a message a
workflow reads is a contract, not prose.

**Low-evidence repositories are better served, and discovery still does not invent authority.** The
root cause was not missing discovery but missing **disclosure**: when the universal adapter finds
two equally-anchored checks it deliberately refuses to choose and returns one clarification line —
and `setup` used to discard that line and print a generic refusal. It is printed now, and both
no-check refusals name the universal contract (Makefile / Taskfile / Justfile, a shipped `gradlew`
or `mvnw`, configured CMake/Meson/Zig/Swift/Elixir/Crystal/Rake/Composer/PHPUnit, or a check the
project's CI already runs) instead of understating what Canary reads.

**CHECK DISCOVERY may get better; SEMANTIC AUTHORITY did not move.** Binding is still an operator
act in `package.json` `canary.proofs`; `canary work` still refuses with `REQUIREMENT UNBOUND` before
opening any candidate; the checkpoint still refuses to certify before executing when authority
drifted.

## Two public statements were corrected because they had become false

- `README.md` told readers that `v1.2.0` was the newest published artifact and that **no `v1.3.0`
  artifact existed**. v1.3.0 had been tagged, released and verified. The Install block now points at
  the real artifact.
- `AGENTS.md` and `apps/cli/src/agents.ts` described Codex as having **"no reliable blocking hook
  exists yet"**. That was stale prose hiding a mechanism that exists — and a stale apology is as
  wrong as an overclaim.

## Installing this candidate

```sh
npm install -g ./canary-rn-cli-1.4.0.tgz     # Node.js 22 or newer
canary --version                             # canary 1.4.0
cd your-repo && canary setup --yes
```

Check the tarball against the `.sha256` published with it. It is one self-contained bundle with
**zero runtime dependencies**. `docs/TROUBLESHOOTING.md` covers every failure that has actually
been observed, and the bug-report template asks for the four JSON-envelope commands rather than
logs.

> **A single-executable build additionally needs Node ≥ 25.5.0.** That is a requirement of the
> *distribution build*, not of the CLI: `--build-sea` was added in Node v25.5.0. The npm tarball
> above needs only Node 22+.

## Known limitations

Unchanged from v1.3 except as noted:

- `LOCAL` is not an OS boundary, and **`HARDENED` remains unreachable** on any host where the
  provider has not been measured and activated. Nothing in v1.4 changes that; the provider is
  implemented and refuses to start without a proven separation, and what it still lacks is
  privileged activation.
- A declared binding is **declared proof coverage, not semantic truth**.
- Everyday edits are not confined.
- One block per stop; one harness-owned MCP approval at project scope (avoidable at local scope).
- Cursor: UNMEASURED. No protection claimed.
- Confined coverage is **5 of 20** fixtures; the other 15 refuse before model execution.
- `CANARY_CONFINED_CHECK` stays opt-in, with evidence pointing in both directions.
- No demonstrated correctness advantage.
- **New:** Codex gating requires a trusted project *and* a trusted hook, or it gates nothing.
- **New:** the everyday token claim excludes a 5,726 B/turn standing payload.
- **New:** the GitHub-hosted Windows CI leg stalls on a handful of pipeline tests; classified a host
  limitation with its measured profile documented in the workflow.

## The release candidate artifact

| | |
|---|---|
| file | `canary-rn-cli-1.4.0.tgz` |
| size | **208,136 bytes** |
| SHA-256 | `aafff076686241cb9a35945766d808522e3a823bb74041d25f9b811e3e46d54d` |
| entries | **16** — exactly the pack allowlist (`dist/main.js`, `tools/windows-boundary` ×7, `tooling/test-support/fixtures` ×6, `package.json`, `LICENSE`) |
| runtime dependencies | **none** (the manifest declares no `dependencies`, `peerDependencies` or `optionalDependencies`) |
| licence | `package/LICENSE` ships in the tarball (Apache-2.0 §4(a)) |

Verified on the artifact itself, not on the source tree: it installs into a prefix whose path
**contains spaces**, `canary --version` prints `canary 1.4.0`, and the whole everyday journey runs
from the installed bytes — `setup --yes` → `READY`, `doctor` → `READY`, a green completion allowed
**silently**, a failing completion blocked with a JSON decision that names the failing check and
points at the evidence file, `stop_hook_active` preventing a second block, the Codex `Stop` handler
written and drivable, and `uninstall` removing Canary's entries while the user's own hook,
permissions and MCP server survive. Upgrading an existing **v1.3.0** installation to this artifact
in the same prefix duplicates neither the hook nor the MCP entry and leaves setup idempotent
(`tooling/probes/v14-rc-artifact-journey.mjs`, 41 checks, 0 failures).

The bundle was scanned for local paths, developer identity, benchmark scratch and secret-shaped
strings: **zero matches**.

## The release report

The frozen-bytes audit — branch, commit, battery result, unit counts, artifact digest, clean-install
and upgrade evidence — is returned with this release as
**CANARY v1.4 RELEASE CANDIDATE AUDIT**.
