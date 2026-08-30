# Canary Execution Security Contract

Every external repository Canary runs is **untrusted code**. This contract is
implemented by `packages/runner`/`packages/support` for every arm of every
experiment — not by operator discipline. **Not every line below is equally
enforced**: "Boundaries — what is enforced, what is convention, what is
absent" tiers each claim honestly. Read that section before treating any
isolation as a kernel guarantee; v0.1 has no filesystem jail and no network
allowlist.

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
USERNAME / USERDOMAIN / LOGONSERVER / HOMEDRIVE / HOMEPATH / SYSTEMDRIVE
              NEUTRALIZED to fixed non-identity values (see below)
```

Notably absent — therefore structurally invisible to fixture code:

```
ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, QWEN_API_KEY,
GITHUB_TOKEN, GH_TOKEN, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / any
cloud credential, *_TOKEN, *_KEY, *_SECRET, *_PASSWORD, SSH_AUTH_SOCK,
NODE_OPTIONS, npm_config_auth tokens, ~/.npmrc contents (isolated HOME +
explicit empty --userconfig)
```

**Audit F6 caveat, stated honestly.** On Windows, replacing the environment
block is NOT sufficient by itself: the process loader appends logon-session
identity vars (`USERNAME`, `USERDOMAIN`, `LOGONSERVER`, `HOMEDRIVE`,
`HOMEPATH`, `SYSTEMDRIVE`) to every child regardless — an executed probe
(`env:{}` still yielded the real profile path) proved the naive allowlist was
leaking the operator identity. `sanitizedEnv` therefore DECLARES those six
with fixed neutral values (an explicitly-set var is not overwritten by the
loader), so the child's OBSERVED environment equals the declared allowlist on
both platforms. `packages/support/test/env.test.ts` runs a real child and
asserts observed == declared on the executing host; the bundle's per-round
`envKeys` records the names (never values) and is validated against the exact
declaration. The credential/injection vars listed above remain genuinely
invisible (the loader does not append them).

Evidence bundles record the allowlisted variable **names** per spawn, never
values.

## Boundaries — what is enforced, what is convention, what is absent

Audit F14 requires an honest tiering. Canary's isolation is **strongest at the
process/environment boundary** and deliberately **weakest at the filesystem/
network boundary**, because v0.1 runs fixtures with the operator's own OS user,
not inside a kernel sandbox. Claiming an fs jail or a network allowlist would
be a lie; here is the real picture.

### Tier A — enforced in code (the contract holds because it is implemented)

- **No shell.** Every external command is `spawn(argv, { shell: false })`;
  argument arrays only, so shell metacharacter injection is impossible.
- **Environment.** The deny-by-omission allowlist above (env.test.ts proves
  observed == declared on the host). Credentials are genuinely absent.
- **Pre-execution audit gate.** Lifecycle hooks (`preinstall|install|
  postinstall|prepare`) and project rc files (`.npmrc`/`.yarnrc`/`.yarnrc.yml`,
  matched case-INSENSITIVELY per audit F7, scanned recursively per red-team
  F10) in the pinned source abort the run BEFORE anything external executes.
- **Isolation-flag injection that cannot be dodged.** `--ignore-scripts`,
  cache/userconfig redirection and pinned registry are appended to every
  install-family command; the argv subcommand detector (audit F8) rejects
  short options, isolation-conflicting flags in any position, unverifiable bare
  options, and `exec`/`dlx`/`shell`/`explore` subcommands rather than letting
  them silently shift detection past the guards.
- **Content pinning.** Repo content arrives only as a tarball fetched by a
  full 40-hex commit SHA (codeload), never a branch, and its digest is recorded
  in the bundle.
- **Classification.** Deterministic function of run facts; the LLM has no path
  to it (see docs/PLAN.md §6/§8). Tree drift outside the dependency subtree
  *downgrades* the verdict to INCONCLUSIVE (rule 9) — enforced, not advisory.
- **Process containment.** Timeout kills the whole process tree; AND on every
  child exit (normal or killed) a descendant sweep runs (audit F5) so a runner
  helper that outlived its parent cannot leak ports/files into a later round.

### Tier B — structural convention (strong in practice, NOT OS-enforced)

- **Disposable workspace.** Everything Canary *itself* writes lives under
  `.canary-runs/` (gitignored) or OS temp, and caches/HOME/TMP are redirected
  inside it, so a *well-behaved* fixture stays within it. But nothing prevents
  fixture code from writing elsewhere it has POSIX/NTFS permission to — there
  is **no filesystem chroot/jail/bind-mount**. A hostile fixture with a
  hardcoded absolute path can write outside. The audit gate + `--ignore-scripts`
  + no-shell reduce the ways untrusted code runs, but do not sandbox its fs
  reach.
- **Post-exit descendants.** The F5 sweep catches descendants that retain the
  child's process group (POSIX) or PPID lineage (Windows). A descendant that
  `setsid()`-double-forks into daemonhood *before* the parent dies is not
  reliably enumerable by either OS without a kernel containment primitive
  (Job Objects / cgroups) that v0.1 does not claim. Documented residual risk,
  not a solved guarantee.

### Tier C — absent (do not claim these)

- **No network allowlist / egress control.** Once a fixture's own tests run
  (the whole point of Canary), that code can open arbitrary sockets. Canary
  controls what IT fetches (Tier A) and stops install-time scripts, but does
  NOT firewall the executed test process. Network isolation is not a v0.1
  property; it is a planned kernel-level follow-on (Job Object / cgroup-net /
  seccomp), explicitly out of scope here.
- **No filesystem jail**, as stated in Tier B.

The failure posture below is about Tier A: when a *Tier-A-enforced* bound
cannot hold, Canary stops. It does not promise to notice Tier-B/C violations.

## Network (what Canary itself touches)

- fetch repo content by pinned commit SHA (codeload/GitHub) and
  declared dependency installs (registry.npmjs.org) only.
- Every install command runs with `--ignore-scripts` — no transitive
  dependency lifecycle code executes.
- No git authentication is ever configured; content arrives as tarballs.
- Canary never publishes, pushes, purchases, or authenticates to external
  services on a downstream repo's behalf.

## Failure posture

If a step cannot complete within these bounds, the runner STOPS before
executing external code and classifies the arm
`INFRASTRUCTURE_FAILURE` with a machine-readable reason. Canary never
downgrades a boundary violation into a pass, and the LLM layer is not
consulted in this decision (it cannot be — see docs/PLAN.md §6/§8).

## Post-review hardening (red-team adversarial pass, pre-dates the audit below)

An internal red-team pass produced 13 findings; all confirmed ones were fixed
(the numbering here is the RED-TEAM's, distinct from the independent audit's
F1–F15 recorded in docs/AUDIT-REMEDIATION-2026-08-30.md):

- **RT-F1/F5 — count-aware classification.** A round that exits nonzero while
  its summary reports *zero* failing tests died for non-test reasons
  (port collision, teardown crash) and is classified infrastructure, not
  drift; a round that exits 0 while reporting failures is a *masked*
  failure and likewise never yields PASS.
- **RT-F2 — process-tree kill.** Timeout kills the whole tree
  (`taskkill /T /F` on Windows, negative-pgid SIGKILL on POSIX), so an
  orphaned grandchild cannot leak ports into later rounds and poison only
  one arm. (Superseded/extended by audit-F5: containment now also sweeps
  on NORMAL exit — see below.)
- **RT-F3 — runtime attestation.** Each arm's actual resolved dependency
  version is probed through the fixture's own module resolver
  (`createRequire`), not read from the spec; a version claim the runtime
  contradicts aborts the experiment as infrastructure.
- **RT-F4 — enforced tree drift.** Drift outside the dependency subtree
  *downgrades the verdict to INCONCLUSIVE*; scoped package names are
  escaped (`@types/axios` → `@types%2Faxios`) so a lookalike cannot
  masquerade as a nested dependency copy.
- **RT-F6 — flag enforcement by scan.** Isolation flags
  (`--ignore-scripts`, cache/userconfig redirection) are detected by
  scanning the spec argv for the package-manager subcommand, so
  `--loglevel install`, `ci`, `add`, and the `$yarn` path cannot silently
  skip them. (Superseded/extended by audit-F8: value-taking-option shift and
  conflicting flags are now hard rejections — see below.)
- **RT-F7 — proof honesty.** Proof compares numeric summary counts and
  *extracted failing-test names* (not loose substrings), validates the
  bundle on read, and asserts against the current run's artifact directory
  rather than a shared pointer file.
- **RT-F9 — auditable allowlist.** Every bundle round's `envKeys` is validated
  against the exact sanitized allowlist; `envExtra` was removed so no
  caller can widen a child's environment.

## Independent audit remediation (Codex audit 2026-08-30, findings F1–F15)

Full ledger with root causes, execution evidence and per-milestone commits:
**docs/AUDIT-REMEDIATION-2026-08-30.md**. Headline outcomes, each covered by
the current 133-test suite:

- **F1/F2/F13 — classification correctness.** A passing-summary-then-nonzero-
  exit can no longer produce CONFIRMED_REGRESSION (conservative INFRA);
  within-arm failure-profile (count + sorted identities) equality is required
  for any trustful label; failing-test identities are first-class bundle data.
- **F3 — evidence integrity is semantic.** `validateBundle` re-derives the
  classification from the bundle's own round facts and refutes
  self-contradictory hand-authored bundles.
- **F4 — the proof re-hashes reality.** `prove`/`check` re-hash every
  on-disk artifact against the recorded digests BEFORE asserting; tampering
  is refused (exit 3) with the divergent file named.
- **F5 — lifecycle containment on every exit** (Tier A/B above).
- **F6 — child-env observed == declared, proven** (Tier A above).
- **F7/F8 — config/argv gates** (case-insensitive rc audit; undodgeable
  isolation-flag injection).
- **F9/F10 — confinement guard is pure + tested end-to-end; scoped-drift keys
  match.**
- **F11 — CI runs the real proof assertions** (`run` + `check`), with only the
  two hash-exact assertions gated by a structured proofHost fingerprint.
- **F12 — `npm run report` works**; the report renders failing identities from
  the bundle itself.
- **F14 — this document**: guarantees tiered (A enforced / B convention /
  C absent); no fs-jail or network-allowlist claims anywhere.

## Platform status (audit F15 — no unproven cross-platform claims)

- **Windows (win32/x64, Node 26):** the fully executed platform — entire 133-
  test suite, including real-subprocess lifecycle/env tests, and the golden
  Axios proof (designated proof host).
- **Linux (POSIX paths):** the offline test suite, POSIX branches of the
  process sweep and env observation, and the pipeline's tar path are WRITTEN
  but have NOT yet been executed on Linux (no Linux host in the remediation
  session; CI's ubuntu legs run on push, not on this commit yet). The CI
  `core` job (ubuntu) runs the offline suite; the golden-proof job remains
  windows-only. Do not describe the golden proof as Linux-proven until a
  Linux run exists.
