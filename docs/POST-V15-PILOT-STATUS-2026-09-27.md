# Canary post-1.5 pilot status — 2026-09-27

## What this establishes

This is a no-model readiness and measurement-validity result. It does **not** establish that Canary improves an agent's work, reduces repair effort, or is worth its runtime and cost. No model sessions were started.

The measured candidate was built from commit `1b6dc6aae514b7b26773915da314ccf338f73514`, packaged as Canary `1.5.0`, installed in an isolated prefix, and invoked by its explicit path. Package SHA-256: `8243f3fc0c1f15fd5ec9977ba4ba240af5aeea1a4ff4d2c3027dd89fac8caf25`. Installed CLI SHA-256: `ba741bbeaa5d513b50e96385b999c7b0cf82392f9ae85e5f046f45f360e4ed7a`.

## No-model results

The twelve prepared workspaces have clean, independent task starts. All six plain-arm project checks passed. All six Canary-arm project checks passed; setup and doctor also completed, with `READY` recorded for each task. Refactron's install, build, typecheck, tests, and build passed in both arms. Schniedelsmp's Gradle tests passed in both arms with the explicitly recorded Java 21 and Gradle 8.13 toolchain paths.

Each task-specific independent oracle reproduced the target defect on its baseline. A separate positive-control copy with the recorded or reconstructed task fix passed that same oracle. The control fixes were applied only to isolated copies and were never made available to an agent.

| Task | Project | Plain checks | Canary setup and checks | Baseline oracle | Fixed positive control |
|---|---|---|---|---|---|
| H1 | Hermes_Agent | pass | READY / pass | target defect reproduced | pass |
| H2 | Hermes_Agent | pass | READY / pass | target defect reproduced | pass |
| H3 | Hermes_Agent | pass | READY / pass | target defect reproduced | pass |
| H5 | Hermes_Agent | pass | READY / pass | target defect reproduced | pass |
| R1 | Refactron | install, build, typecheck, tests, build: pass | READY / same checks pass | target defect reproduced | pass |
| S1 | schniedelsmp.net | Gradle tests: pass | READY / Gradle tests pass | target defect reproduced | pass |

Full command output, exit codes, repository identities, toolchain paths, oracle inputs/results, positive-control diffs, and SHA-256 manifests are in [`tooling/benchmark/results/session-evidence/post-v15-pilot-20260927/`](../tooling/benchmark/results/session-evidence/post-v15-pilot-20260927/). The task preparation now resets H2 and H5 to the clean Hermes base and maps task labels to the existing Hermes, Refactron, and schniedelsmp scratch repositories; those two corrections were required for the twelve preparations to complete.

## Product and package verification

The repository unit suite completed with **1,287 passed, 0 failed, 4 skipped (1,291 total)**. `npm run verify:productization` completed with **103 PASS, 7 explicit SKIP, 0 FAIL**. The final repack matched the exact candidate used in preflight: package SHA-256 `8243f3fc0c1f15fd5ec9977ba4ba240af5aeea1a4ff4d2c3027dd89fac8caf25`; installed CLI SHA-256 `ba741bbeaa5d513b50e96385b999c7b0cf82392f9ae85e5f046f45f360e4ed7a`.

High-signal product checks included: the source and packed architecture closure matrices each passed 39/39 cases; all 13 architecture-closure mutants were caught; all 13 master-pass mutants and all 14 trust-boundary mutants were caught; the installed HARDENED authority passed 54 checks and blocked all 57 production attack attempts with 45 positive controls; Python, `node:test`, and `pytest` each passed their real execution/observation wiring tests; first-run onboarding passed 10/10 steps; the packed clean-room install passed 7/7; the documented Node/Python examples passed all 6 smoke steps; and the six real-project preflight checks passed as summarized above. The benchmark outcome instrument rechecked 447 stored trials without inventing missing verdicts.

The seven skips remain gaps, not passes: five are host-bound (Codex's live Stop-hook session; Go and Rust end-to-end toolchains; and real OS PTYs for two acceptance probes), and two require live Claude sessions with a reliable provider spend cap. The PTY probes still executed all product assertions available through the in-process terminal driver, but their host-level PTY assertions are explicitly unproven. Go/Rust end-to-end checks executed zero assertions because those toolchains were absent. The full gate output and skip reasons are recorded in `evidence-summary.json`.

This materially strengthens evidence for packaging, setup, fail-closed completion, proof provenance, provider routing, and trust-boundary behavior. It still does **not** measure whether real coding agents make fewer mistakes, need fewer repairs, finish faster, or justify Canary's cost. The earlier 6/10 product efficacy rating therefore remains unchanged pending the paired agent pilot.

## Why the agent pilot did not run

The local Claude Code settings point the model request at `token-plan.ap-southeast-1.maas.aliyuncs.com` with model `qwen3.8-flash`. The planned runner starts Claude Code with `-p`, which is a non-interactive automated call. Alibaba restricts Token Plan Personal and Team keys to interactive coding-tool use and lists automated scripts and custom applications as unsupported. Token Plan consumption is measured in provider Credits, not USD, so Claude Code's `--max-budget-usd 2.50` would not be a verified hard cap on that provider's charge. See Alibaba's [Claude Code configuration](https://help.aliyun.com/en/model-studio/claude-code), [Token Plan supported tools and restrictions](https://help.aliyun.com/en/model-studio/more-tools), and [Token Plan billing and quota](https://help.aliyun.com/en/model-studio/token-plan-personal-faq).

I therefore made zero model calls and incurred zero model charges. This follows the pilot's precondition that paid runs stop when third-party usage cannot be reliably bounded. I rechecked the host configuration and current Alibaba documentation before continuing: the configured endpoint still uses the Token Plan host and `qwen3.8-flash`; no separate pay-as-you-go key is present in the process environment. Alibaba's current [Token Plan FAQ](https://help.aliyun.com/en/model-studio/token-plan-personal-faq) explicitly disallows using that key for automated or other non-interactive scenarios.

Alibaba's [budget-management documentation](https://help.aliyun.com/en/model-studio/budget-management) does not make its budget switch a strict hard cap: it applies only to pay-as-you-go API charges, uses a monthly CNY budget, and says service-stop has a delay during which additional charges are still collected. A separate pay-as-you-go key plus that switch alone is therefore insufficient to prove the authorized USD 30 ceiling. The pilot remains stopped until the host has a provider-approved automated-use credential and an independently verifiable spend ceiling whose maximum exposure, including stop delay, stays within the authorized limit. No secret or credential value was read into the report.

## What remains unproven

These checks validate the task baselines, positive controls, package identity, and local setup. They do not measure natural agent mistakes, whether Canary's hook triggers during actual agent work, helpful or unnecessary blocks, repair turns, manual intervention, elapsed time, token overhead, or value for money. The product's efficacy rating therefore stays unchanged; this result is not grounds to raise the earlier 6/10 product score.

Before the twelve-session comparison can start, configure a dedicated provider endpoint/key permitted for automated Claude Code calls and a verified provider-side auto-stop no higher than the authorized $30 total (in the provider's billing currency). Keep the existing per-session CLI cap at or below $2.50, then verify that native per-session usage and provider billing are both captured. Do not send API secrets through chat; the local settings can be updated on the host.
