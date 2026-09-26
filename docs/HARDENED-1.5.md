# HARDENED in v1.5 — a real, measured optional path

> **Verdict: `HARDENED` is MEASURED on an explicitly supported host configuration.**
> It is no longer an architectural possibility, a label, or a configuration flag.
> On this host, all six boundary controls were observed holding under a real
> measured deployment, and the whole thing reproduces from one command in about
> two minutes with **no elevation**.
>
> Two things are still **not** claimed, and they are different things:
> a *persistent, machine-wide* HARDENED service is still **not installed** (it
> needs Administrator), and a host that cannot execute inside the native
> confinement still gets **HOST UNSUPPORTED**, never a pass.

Reproduce it:

```sh
node tooling/probes/v15-hardened-boundary.mjs
```

---

## 1A. What HARDENED actually is, in this code

Read from the implementation, not from the names.

| Question | Answer | Source |
|---|---|---|
| What does HARDENED mean? | Authority is protected from the worker's **own OS identity**: the worker cannot rewrite the records, the key, or the history that judge it. | `docs/CAPABILITY-LEVELS.md` |
| Where is the level produced? | `measuredCapabilities()` is the **only** place a `HARDENED` level can be produced, and it requires **every** control to read `available` — it is all-or-nothing. | `apps/cli/src/platform-boundary.ts:48-59` |
| Which controls? | Six: `authorityCustody`, `workerFilesystem`, `verificationSandbox`, `authenticatedReview`, `protectedPromotion`, `networkEgress`. | `apps/cli/src/platform-boundary.ts:8-9`, `apps/cli/src/provider/confined-measurement.ts:19-22` |
| Which provider delivers it? | The **production confined-caller** provider (`apps/cli/src/provider/production.ts` + `production-measurement.ts` + `production-attacks.ts` + the native launcher/broker). A separate *identity path* (service + worker account) exists but is **not** what activates HARDENED here. | `docs/TRUST-ARCHITECTURE.md:65-84`, `apps/cli/src/provider/boundary.ts:301-321` |
| What OS primitives? | Windows **AppContainer** + **restricted token** + **low integrity** (`S-1-16-4096`) + **zero capabilities**, plus a native broker on an authenticated named pipe whose DACL excludes the confined package. | `apps/cli/src/provider/production-measurement.ts:154-156, 198-205` |
| Where is it implemented natively? | `tools/windows-boundary/CanaryConfinedLauncher.cs`, `CanaryBroker.cs` (+ `AppContainerRunner.cs`, `restricted-runner.ps1` in the tree). | `tools/windows-boundary/` |
| What does the level require before it activates? | A **valid production measurement**: fresh (15-minute ceiling), bound to host + store + toolchain digest + nonce, signed with an anchored producer key, **and** a live signed broker challenge. Presence, declarations, saved transcripts and standalone probes cannot substitute. | `apps/cli/src/provider/production-measurement.ts:220-253`, `docs/TRUST-ARCHITECTURE.md:72-84` |

### The six controls, and the observation each one rests on

Every row below is validated from raw native return values and broker transcripts;
aggregate "pass/complete/available" booleans carry no authority
(`production-measurement.ts:130-131`).

| Control | Decided by |
|---|---|
| `authorityCustody` | the confined caller denied on 5 authority-write targets (store `producer.key`, `enrollment.json`, the anchor, the base repo's `.git/HEAD`, the candidate's `.git`) and on `descendant-read`, each paired with a successful unrestricted control; **plus** the confined caller refused on the broker pipe (`EPERM`/`EACCES`) while the control gets `200`, **plus** a pipe DACL that does not grant the confined package |
| `workerFilesystem` | the measured token: `appContainer=true`, `restricted=true`, `integrity=S-1-16-4096`, `capabilities=0` — and the caller still doing its own work; plus environment secrecy (the trusted parent's variable is visible to the control arm and `null` to the confined arm) |
| `verificationSandbox` | candidate code genuinely executed inside the boundary for **both** the caller and verifier package identities, and ceased (`token[1].pid == token[0].pid`, `token[1].exit == 0`), with every native attack executed |
| `authenticatedReview` | every authority event bound to the confined identity (`appContainer`/`restricted`/zero-capability/LOW) **and** to the live nonce; a foreign identity or stale challenge refused |
| `protectedPromotion` | only the broker applies (`appliedBy=broker`), the applied head/tree are read back identical, receipt↔digest are bound, and eight denial predicates hold (re-enroll, promote-before-review, body substitution, digest substitution, foreign project, foreign candidate, replayed receipt, replay after apply) |
| `networkEgress` | the unrestricted arm reaches the controlled listener (`CONNECTED`, confirmed by before/after connection counts) while the confined arm is denied by a **named** mechanism — `WSA-10013`, or a Windows network-isolation diagnostic (`diagnosticReturn=0`, `isolationError ∈ {1,2,3}`) with the control arm's diagnostic clean. **A bare timeout earns nothing.** |

### Which controls are missing

**None of the six.** What is missing is the *persistent privileged activation* that
would make this survive a reboot as an installed service — see §1C.

### Why earlier hosts could or could not execute inside the boundary

- **GitHub-hosted `windows-latest` — CANNOT (host capability, measured).** Every
  confined exec reports `spawnSync C:\Program Files\Git\cmd\git.exe EPERM`; the
  probe's own capability mode returns exit 3 and the product correctly reports
  **NOT HARDENED**. The native confinement suite reports a **named, counted
  host-bound SKIP** there — never a PASS (`apps/cli/test/confined-activation.test.ts:42-75`).
- **This development host — CAN (measured).** `--capability` reports
  `5/5 confined exec probes ran`, exit 0.

### Host capability vs product defect — the distinction that cost real time

Two v1.4 failures first *looked* like "the Windows runner can't do this". Both were
**product defects**, and the difference matters because mislabelling a product
defect as a host limitation is exactly the "release blocker hidden as host
limitation" failure this project forbids:

1. the containment sweep issued a **per-process WMI query** (27/29 failures at
   ~334 s each) — rewritten to one `Get-CimInstance Win32_Process` snapshot with a
   BFS in PowerShell (`packages/support/src/index.ts`);
2. **existence-after-resolution** in `verifyArtifacts` under 8.3 short temp paths
   (`C:\Users\RUNNER~1\…` vs `C:\Users\runneradmin\…`) — `fs.realpathSync` does not
   expand short names, `fs.realpathSync.native` does (`apps/cli/src/prove.ts`).

Four further failures were **budgets that were too tight for a loaded machine**,
not host limits: `productionHost()` and its heartbeat (10 s → 60 s), the provider
launch readiness deadlines (5 s → 60 s), the native call timeout (150 s → 300 s),
and the launcher's `WaitForSingleObject` (120 s → 240 s).

The rule this leaves behind: **a host limitation is only ever concluded from a raw
OS refusal (`EPERM`/`EACCES`/`WSA-*`) that is quoted in the reason, and a timeout is
never a host verdict.**

## 1B. `canary provider status` now tells the truth compactly

Before v1.5 the command printed, on a host with nothing measured, six control lines
of roughly 430 characters each that said one thing twice, and never plainly
answered the two questions a user has. It now answers, by default, in about a dozen
lines: current provider, current security level, whether HARDENED is available,
exactly which prerequisite is missing, **whether this host was actually measured**,
and the two commands that would change the answer. The per-control reasoning and
raw observations moved behind `--verbose` — nothing was deleted from them.

Two invariants are enforced by test, not by intention
(`apps/cli/test/provider-status.test.ts`):

- **no output claims HARDENED while the controls are not measured** — the positive
  claim string is asserted absent, and `status`/`exitCode` stay `NOT CONNECTED`/`2`;
- **host primitives and activation are separate fields.** `hostPrimitives` records
  what the host was observed to *offer*; `deploymentMeasured` records what was
  actually *measured*. `hostPrimitives !== null` must never be read as HARDENED.

## 1C. Activation — the reproducible path, and what "fallback" means

There are two distinct levels of activation. Conflating them is how a product
overclaims.

### (a) Measured boundary on this host — supported, unprivileged, reproducible

| | |
|---|---|
| **Supported OS / environment** | Windows 10/11 x64 that can execute a child inside AppContainer + restricted token + low integrity. Measured working on Windows 10.0.26200 (`DESKTOP-1OHL66A`). |
| **Required host capabilities** | AppContainer support; the ability to create a restricted/low-integrity token; PowerShell + a C# compiler for the native launcher (the launcher is compiled as part of the run). |
| **Required permissions** | **None. Not elevated** — the measurement ran as a standard user (`elevated: false`). |
| **Installation / activation steps** | `node tooling/probes/v15-hardened-boundary.mjs` (or the underlying `node tooling/probes/v12-confined-caller.mjs`), then `canary provider enroll <base> <store>` + `canary provider serve-production <store>` for a long-lived deployment. |
| **How to verify activation** | `canary provider status` must print `HARDENED`, and `canary provider status --json` must show `status: READY` with `security.level: HARDENED` and `provider.controlsAvailable == 6`. Anything less is not HARDENED. |
| **How to disable it safely** | The probe removes its own measurement authority and profiles on exit (`removeMeasurementAuthority`, `production-measurement.ts:264-277`); a deployment store can simply be deleted. Nothing machine-wide is installed, so nothing machine-wide needs removing. |
| **What fallback means** | `LOCAL`: records are still sealed outside the repository with an Ed25519 key, but a process running as **you** could replace the store, the key and the ledger together. `LOCAL` is a real, useful level and it is *not* an OS boundary. |

### (b) Persistent machine-wide activation — implemented, NOT installed, needs Administrator

`canary provider install-plan` prints the exact privileged steps (service account,
worker identity, per-identity egress policy) and **executes nothing**. On this host
`canary provider status --verbose` reports the identity path as
`service installed=false running=false worker=not enrolled`. This remains an
explicit **non-claim**: no separate installed service account, no administrator
resistance.

### No silent downgrade

If HARDENED is requested and cannot be supplied, the system must not quietly claim
the stronger boundary. That is structural, not aspirational: the measured level is
all-or-nothing (`platform-boundary.ts:48-59`), and a request for `HARDENED` is
refused unless **the measurement itself** establishes it
(`requireMeasuredLevel`, `platform-boundary.ts:69-72`, tested in
`apps/cli/test/confined-activation.test.ts`).

## 1D. The boundary measurement, as executed

Full raw output: `tooling/benchmark/results/session-evidence/v15-hardened-boundary-fresh.txt`.
Host: `DESKTOP-1OHL66A (win32 10.0.26200, x64)`. Reproduction:
`node tooling/probes/v15-hardened-boundary.mjs`.

Battery totals from the signed transcript of that run:
**57 attacks executed, 57 blocked, 45 positive controls, 0 failures, 0 inconclusive**;
36 of those were native attacks across **two** confined package identities, each with
17 paired unrestricted controls; 18 custody attacks on the measurement record itself
were refused with a correctly named reason, and the restored record still validated.

| CONTROL | EXPECTED | ACTUAL | VERDICT |
|---|---|---|---|
| `authorityCustody` | confined caller denied on the 5 authority targets + descendant read, and refused on the broker pipe | 6/6 authority attacks denied (error 5); paired control arm 17/17 allowed; pipe from confined `pipe-connect EPERM` | **PASS** |
| `workerFilesystem` | AppContainer + restricted + low integrity + zero capabilities, tool still works | `appContainer=true restricted=true integrity=S-1-16-4096 capabilities=0`; environment control `"trusted-parent-only-test-value"` vs restricted `null` | **PASS** |
| `verificationSandbox` | real execution inside the boundary for both identities, then cessation | 2 package identities; `pid 28024 == 28024`, `exit 0`; 17 attacked vs 17 control attempts per identity | **PASS** |
| `authenticatedReview` | every event bound to the confined identity and live nonce; foreign refused | 10 authority events: 8 refused (403), 2 accepted (200); accepted review `appContainer=true`, `identity==user=true` | **PASS** |
| `protectedPromotion` | only the broker applies; applied bytes read back identical | `appliedBy=broker`; head `4ab455bc06dd…` == review head; tree `19bceb87c8ba…`; 8 refusals of forged/substituted/replayed promotion | **PASS** |
| `networkEgress` | unrestricted reaches the listener; confined denied by a **named** mechanism | control `CONNECTED` to `10.212.253.230:59990`; restricted `TIMEOUT` with `isolationError=2, diagnosticReturn=0`; listener connections 1 → 2 | **PASS** |

**Measured: 6/6. PASS 6. FAIL 0. HOST UNSUPPORTED 0. HARDENED: MEASURED.**

Two notes an auditor should hold onto:

- the `networkEgress` confined arm returned `TIMEOUT`, and that alone would **not**
  have earned the control; it passes because the run also carries a clean control
  diagnostic and a non-zero Windows network-isolation error, which is the causal
  evidence the validator demands (`production-measurement.ts:170-175`);
- the measurement is **disposable**: the probe deletes its deployment, profiles and
  candidate on exit. What it proves is that the controls hold on this host; it does
  not leave a service running.

## 1E. Reproducibility for someone outside this project

One command, no elevation, no private state:

```sh
git clone <repo> && cd canary
npm ci && npm run build
node tooling/probes/v15-hardened-boundary.mjs     # ~2 minutes
```

It prints one row per control and distinguishes four verdicts — and never converts
one into another:

| Verdict | Means | Exit |
|---|---|---|
| `PASS` | the control was observed holding on this host | 0 (all six) |
| `FAIL` | the control was measured and did **not** hold | 1 |
| `HOST UNSUPPORTED` | this host cannot execute inside the native confinement, so nothing about the control was measured here | 3 — explicitly **not** success |
| `CONTROL NOT PROVIDED` | Canary does not implement it (auditor-facing non-claims, listed by the probe) | — |

The non-claims the probe prints so that the *edge* of the claim is visible:
administrator resistance; exhaustive network coverage (IPv6, UDP, DNS rebinding,
proxies, redirects); a separate installed service account; key rotation;
power-loss durability; Linux runtime verification (`hostVerified: false`).

## Limitations, stated plainly

- **`--from-saved` is HISTORICAL EVIDENCE and cannot establish a current boundary.** It exits
  **2**, labels every row `HISTORICAL`, and prints its own disproof (age versus the product's
  15-minute ceiling, host match, whether the recorded store still exists). v1.5 post-audit: it
  previously printed `HARDENED: MEASURED` / `RESULT: PASS` from a stale OS-temp transcript while
  the live store reported `LOCAL` with 0/6 controls — a defect in the PROBE, not in the product's
  validator, and it is fixed and regressed (`tooling/benchmark/hardened-evidence.{mjs,test.mjs}`).
  A **failed live battery now exits 4** rather than falling through to an older file.
- The trusted operator/broker is the normal user; the adversary is the **confined
  builder or candidate**, not a holder of that user's unrestricted token.
- The persistent machine-wide service is **not installed**; `install-plan` prints
  rather than executes.
- The measurement is disposable and single-host; it says nothing about a host that
  cannot confine, and such a host is reported as HOST UNSUPPORTED.
- Controlled TCP egress is measured; UDP/IPv6 and every endpoint are not.
- No correctness advantage is claimed anywhere in this document.
