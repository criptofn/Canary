# Canary v1.2.0

**Released 2026-09-19.** Artifact: `canary-rn-cli-1.2.0.tgz` (+ `.sha256`) ·
[GitHub release](https://github.com/criptofn/Canary/releases/tag/v1.2.0) ·
Licence: Apache-2.0 (the licence text ships **inside** the tarball).

This page is the 2–4 minute version. Every number below was produced by a command in this
repository, and the evidence ledgers record what was observed rather than what was intended.

## What v1.2 changes

**1. The worker runs behind a measured boundary, and the model has no other way to act.**
`canary provider model-transport` drives the real Claude CLI with native tools, skills, hooks,
project settings discovery and Chrome integration disabled, and advertises exactly one tool:
`mcp__canary_confined__implement`. Every file edit, shell command and Git operation crosses a
restricted, low-integrity AppContainer with zero capabilities. The worker receives no API
credential and no broker secret, and there is **no fallback**: with the enrollment absent, the
transport refuses before it contacts a model.

**2. Confined Git works.** Inside the AppContainer, Git could not resolve a DOS volume path
(`QueryDosDevice("C:")` is denied), so every mutation failed with *unable to get current working
directory*. A session-local, per-run drive alias now maps the sandbox root — and only that root —
with no global ACL change, no machine-wide mapping and no administrator rights. Measured:
`rev-parse --show-toplevel`, `status`, `diff`, `diff --cached`, `add`, plus a trusted-side readback
of the index the worker staged.

**3. The worker cannot acquire proof authority.** The broker refuses (403) any proposal that
creates, replaces, modifies or removes proof-binding declarations in `package.json` or
`canary.project.json`, including Windows case aliases; the worker cannot write the authority
source or the sealed plan (EPERM), and it cannot invoke `bind`/`setup`/`seal`. The operator's
`canary bind --reseal` is the only path that creates a binding, and it still is.

**4. A declared requirement that nothing measures fails before any worker starts.**
`canary work` refuses (exit 2), opens no candidate, and launches no worker: measured **0 worker
launches, 0 worker tokens**. The refusal is written with its own record schema and carries no
delivery verdict, so it can never be read as completed work.

**5. The packaged artifact ships its licence.** v1.1 shipped a tarball whose metadata declared
`Apache-2.0` but whose contents omitted the licence text. `LICENSE` is now staged into the
artifact, and the cleanroom probe installs the exact `.tgz` and asserts it.

## Token performance — what was measured, and what was not

Same model (`qwen3.8-flash`), same fixtures, same starting bytes, same hidden oracle, and the
CLI's own token accounting. Canary arm = the real confined transport with broker-owned review and
promotion; the Plain arm is this repository's own recorded arm.

| task | Plain | Canary v1.2 | Δ | turns Plain → Canary | correctness |
|---|---|---|---|---|---|
| bound-requirements | 126,977 | 20,472 | **−83.9%** | 12 → 6 | 12/12 vs 12/12 |
| bug-sum | 70,070 | 26,970 | **−61.5%** | 7 → 8 | 15/15 vs 15/15 |
| stateful-replay | 212,777 | 585,337 | **+175.1%** | 18 → 22 | 406/406 vs 406/406 |
| **aggregate** | **409,824** | **632,779** | **+54.4%** | | equal correctness |

**Read this honestly: v1.2 substantially reduces the workflow's overhead compared with the
previous implementation, and it is still not cheaper than Plain overall.** Two of three fixtures
used 61–84% fewer tokens; the stateful workload remained more expensive and dominates the sum.
**Canary does not generally save tokens, and this release does not claim that it does.** The
mechanism behind the reduction is measurable: the worker's tool carries an ordered list of
operations per call (4.67 operations per round trip on the stateful fixture, which fell from 45
to 22 turns).

## What was verified on the released bytes

- Confined Git escape battery: **48 executed / 48 blocked / 0 succeeded / 0 inconclusive**,
  every vector's unrestricted positive control fired first.
- Sandbox alias lifecycle: **18/18** — maps only its own sandbox, cannot be created or retargeted
  by the worker, collisions fail safe, stale mappings are skipped, cleanup after success, failure
  and worker crash.
- Real pre-bound production workflow, end to end: **24/24** — trusted preflight, frozen operator
  binding, real transport, confined implementation and Git, worker authority attacks refused,
  broker review 200 → promote 200, promoted bytes equal to the worker's bytes.
- Production attack battery: **57 executed / 57 blocked / 45 positive controls / 0 inconclusive**
  (52/52 authority checks), with live HARDENED status.
- Packaged artifact: cleanroom **7/7** — exact allowlist (including `LICENSE`), `npm install` of
  the tarball, packed `setup --yes` READY, hook gating, uninstall.
- Full unit suite: **1175 tests, 1171 pass, 0 fail, 4 skipped** (host-bound skips, never counted
  as passes). Dist tripwire PASS. Build, typecheck and `git diff --check` PASS.

## Verify your download

```bash
sha256sum -c canary-rn-cli-1.2.0.tgz.sha256      # or: certutil -hashfile <file> SHA256
npm install -g ./canary-rn-cli-1.2.0.tgz
canary --version                                  # canary 1.2.0
```

`v1.1.0` is untouched: it still resolves to `c559e55`.
