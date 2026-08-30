# Canary Execution Security Contract

Every external repository Canary runs is **untrusted code**. This contract is
enforced by `packages/runner` for every arm of every experiment — not by
operator discipline.

## Environment sanitization (deny-by-omission)

External processes receive ONLY this allowlist (Windows; POSIX analogues on
other hosts):

```
PATH          node dir + System32 + Windows dir only
PATHEXT
SystemRoot    (from host, value = system path, no secrets)
windir
ComSpec
TEMP / TMP    redirected into the run workspace
HOME / USERPROFILE   redirected into the run workspace (isolated)
```

Notably absent — therefore structurally invisible to fixture code:

```
ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, QWEN_API_KEY,
GITHUB_TOKEN, GH_TOKEN, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / any
cloud credential, *_TOKEN, *_KEY, *_SECRET, *_PASSWORD, SSH_AUTH_SOCK,
NODE_OPTIONS, npm_config_auth tokens, ~/.npmrc contents (isolated HOME +
explicit empty --userconfig)
```

Evidence bundles record the allowlisted variable **names** per spawn, never
values.

## Filesystem and network boundaries

- Fixture workspace: disposable, under `.canary-runs/` (gitignored) or OS
  temp. npm/yarn caches and isolated HOME live inside it. Nothing is written
  outside it except Canary's own run artifacts.
- Network: fetch repo content by pinned commit SHA (codeload/GitHub) and
  declared dependency installs (registry.npmjs.org) only.
- Every install command runs with `--ignore-scripts` — no transitive
  dependency lifecycle code executes.
- The repo's own `preinstall|install|postinstall|prepare` scripts are
  statically verified absent before any install; if present → refusal
  (INFRASTRUCTURE_FAILURE, reason `lifecycle-hook-present`), no execution.
- No git authentication is ever configured; content arrives as tarballs.
- Canary never publishes, pushes, purchases, or authenticates to external
  services on a downstream repo's behalf.

## Failure posture

If a step cannot complete within these bounds, the runner STOPS before
executing external code and classifies the arm
`INFRASTRUCTURE_FAILURE` with a machine-readable reason. Canary never
downgrades a boundary violation into a pass, and the LLM layer is not
consulted in this decision (it cannot be — see docs/PLAN.md §6/§8).

## Post-review hardening (adversarial validation, 2026-08-30)

A red-team pass produced 13 findings; all confirmed ones are fixed and
covered by the 73-test suite:

- **F1/F5 — count-aware classification.** A round that exits nonzero while
  its summary reports *zero* failing tests died for non-test reasons
  (port collision, teardown crash) and is classified infrastructure, not
  drift; a round that exits 0 while reporting failures is a *masked*
  failure and likewise never yields PASS.
- **F2 — process-tree kill.** Timeout kills the whole tree
  (`taskkill /T /F` on Windows, negative-pgid SIGKILL on POSIX), so an
  orphaned grandchild cannot leak ports into later rounds and poison only
  one arm.
- **F3 — runtime attestation.** Each arm's actual resolved dependency
  version is probed through the fixture's own module resolver
  (`createRequire`), not read from the spec; a version claim the runtime
  contradicts aborts the experiment as infrastructure.
- **F4 — enforced tree drift.** Drift outside the dependency subtree
  *downgrades the verdict to INCONCLUSIVE*; scoped package names are
  escaped (`@types/axios` → `@types%2Faxios`) so a lookalike cannot
  masquerade as a nested dependency copy.
- **F6 — flag enforcement by scan.** Isolation flags
  (`--ignore-scripts`, cache/userconfig redirection) are detected by
  scanning the spec argv for the package-manager subcommand, so
  `--loglevel install`, `ci`, `add`, and the `$yarn` path cannot silently
  skip them.
- **F7 — proof honesty.** Proof compares numeric summary counts and
  *extracted failing-test names* (not loose substrings), validates the
  bundle on read, and asserts against the current run's artifact directory
  rather than a shared pointer file.
- **F9 — auditable allowlist.** Every bundle round's `envKeys` is validated
  against the exact sanitized allowlist; `envExtra` was removed so no
  caller can widen a child's environment.
