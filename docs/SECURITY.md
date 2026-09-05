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
- **Package-manager isolation that cannot be dodged — semantically, not
  textually** (audit F8→B5→B5.1, hardened post-sol RB-1). Canary OWNS the
  package-manager surface via CLOSED ALLOWLISTS at three levels: executables
  (only `$npm`/`$yarn`/`$tsc`/`$bin:` tokens and literal `node`; raw
  `npm`/`npm-cli.js`/`$bin:npm`, wrappers like `cmd /c npm`, and pnpm/bun/
  corepack frontends are rejected fail-closed), subcommands (closed allowlist;
  unknown aliases and `exec`/`dlx`/`shell`/`publish` refused), and — post-sol
  — OPTIONS: every install-family option token must be an exact spelling from
  a closed allowlist that is property-tested prefix-disjoint from the
  protected config universe (npm applies abbreviations like `--ig`/`--userc`/
  `--reg`, `--no-` negations and LAST-WINS ordering — probe-verified on npm
  11.16 AND 11.19 — so exact-string denylists are bypassable by construction;
  unknown and per-package config forms `--@scope:registry`/`//…:auth` are
  refused everywhere). Canary's isolation flags
  (`--ignore-scripts`, `--userconfig`, `--cache`, `--registry`) are APPENDED
  AS THE ARGV SUFFIX, so npm's own last-wins semantics make the EFFECTIVE
  protected configuration Canary's regardless of accepted spellings. A user
  `--` in an install is rejected (nothing may follow the suffix block); short
  options are rejected; in the script/info families any option whose resolved
  key (case-folded, negation-stripped, prefix-expanded) touches a protected
  key is refused.
- **F6e residual — the controlled-userconfig race is narrowed, not
  closed** (post-glm F6e; stated plainly per the 2026-09-05 re-audit):
  three sites touch `empty.npmrc`, and they are not alike —
  (a) workspace setup CREATES it (`apps/cli/src/pipeline.ts`,
  `runExperimentInner`); that is creation, not a point of use;
  (b) the treeHash `npm ls` observation (`apps/cli/src/pipeline.ts`,
  `treeHash`) re-writes it immediately before passing
  `--userconfig` (that site pins only the userconfig key, not the
  install-isolation flag set);
  (c) the executor `$npm` injection (`packages/runner/executor/src/index.ts`)
  re-writes it immediately before the full isolation-flag argv suffix
  is appended. At both CONSUMERS (b, c) the re-write means a tamper
  written EARLIER cannot survive into npm's read. But write→spawn→npm-read is still a window:
  code holding workspace write access can replace the file's contents
  inside it. The argv-suffix flags keep every PINNED key immune (CLI
  beats userconfig — userconfig path, cache, registry, ignore-scripts),
  yet npm settings Canary does not pin (proxy-family keys, e.g.) could
  ride a replaced file. Consistent with the tier honesty above: the
  filesystem is Canary's weakest boundary — F6e narrows one concrete
  race there; it does not mathematically guarantee the file is unchanged
  when npm reads it.
- **Content pinning.** Repo content arrives only as a tarball fetched by a
  full 40-hex commit SHA (codeload), never a branch, and its digest is recorded
  in the bundle.
- **Classification.** Deterministic function of run facts; the LLM has no path
  to it (see docs/PLAN.md §6/§8). Tree drift outside the dependency subtree
  *downgrades* the verdict to INCONCLUSIVE (rule 9); a non-VALID tree
  OBSERVATION (empty/partial/missing the studied dependency) downgrades it too
  (rule 10, audit B6) — enforced, not advisory. Zero-execution / no-summary /
  infra-at-exit-0 rounds can never yield PASS (audit B2). Post-sol RB-2 adds
  the COVERAGE-CONSISTENCY pair: repetitions whose executed/observed totals
  differ are FLAKY (rule 12), and PASS/CONFIRMED_REGRESSION/PRE_EXISTING_-
  FAILURE additionally require the arms' totals to match (rule 13) — a suite
  that collapses from 128 to 1 executed test can no longer produce any strong
  verdict, while the legitimate 128→125+3 regression shape still confirms.
  `validateBundle` enforces the same parity independently (rules 12/13 plus
  ≥2 dense rounds per arm), so a resealed bundle refutes itself. Post-GLM
  adds rule 14, the **execution-authority** gate: every strong or
  execution-claim label (PASS / CONFIRMED_REGRESSION / PRE_EXISTING_FAILURE /
  FLAKY) additionally requires a Canary-observed, pinned-runner execution on
  every round, cross-checked against the text — a printed summary is a CLAIM;
  text alone can no longer produce strength in any direction (see
  docs/EXECUTION-AUTHORITY.md for the full rules 0..14 table and trust ladder).
- **Evidence integrity** (audit B3/B4). Artifact filenames are derived from a
  round's arm/round and must equal the canonical name, realpath-confined to the
  run dir (no `../`/absolute/cross-round swaps); a manifest digest makes any
  single-field rewrite without full recompute detectable (integrity, NOT
  authenticated provenance — no trust root); `prove`/`check`/`report` re-derive
  each round's summary, counts, failing-test identities AND execution
  observation FROM the artifact BYTES — including the post-GLM fifth artifact,
  `<arm>-<round>.attest.ndjson`, whose digest binds the lifecycle frames — so
  the bundle cannot misdescribe **what it recorded**. (Pre-GLM wording claimed
  "what actually ran"; the demonstrated finding-A class was precisely a bundle
  that faithfully recorded *fabricated-looking* output. What the bytes mean as
  an execution is now established by the observation channel and rule 14, not
  by the text re-derivation alone.) The structural
  floor (which fields MUST exist, per-state trustful requirements, unknown
  fields refused) is one machine-readable contract:
  `packages/evidence/schema/src/contract.ts` generates
  `schemas/evidence.schema.json` and drives the runtime validator — the two
  cannot silently diverge (post-sol M-1). `report` stamps
  **SELF-CONSISTENT / NOT SELF-CONSISTENT** (post-sol F1): exit 0 means the
  evidence agrees with the artifacts on THIS machine; it explicitly does NOT
  mean the committed proof was consulted — only `prove`/`check` assert that,
  and the banner says so. Refused bundles are never rendered as trusted.
- **Execution-observation channel (post-GLM A).** A strong verdict can only
  exist for an execution Canary *watched*: a Canary-authored in-process
  observer is injected (via `--require`, appended last into protected argv)
  **only** into a runner whose on-disk tree hash matches a pinned release in
  `KNOWN_RUNNER_RELEASES`; per-test lifecycle events stream back on a private
  fd the subject cannot be granted through argv (any spec-carried `--require`
  is refused fail-closed → INFRASTRUCTURE_FAILURE), and the runner's own text
  summary is demoted to a downgrade-only cross-channel check. Unpinned
  runners receive NO injection: status ABSENT, and strong labels are
  structurally unreachable — narrow + correct, never broad + fake. The pin
  table is trust-on-first-use (a human-reviewed allowlist of *bytes*, not a
  crypto trust root). Claim contract, validator rules, the three independent
  enforcement sites (classify gate / validateBundle mirror / prove byte
  binding) and residual ceilings: [docs/EXECUTION-AUTHORITY.md](EXECUTION-AUTHORITY.md).
- **Process containment.** Timeout kills the whole process tree; AND on every
  child exit (normal or killed) a descendant sweep runs (audit F5) so a runner
  helper that outlived its parent cannot leak ports/files into a later round.
  The sweep follows stale-PPID lineage on Windows and group- AND session-level
  membership on POSIX (audit S1), so a `setpgid()`-escapee within the child's
  session is still caught.

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
- **No authenticated runner provenance.** `KNOWN_RUNNER_RELEASES` pins
  content BYTES (treeSha256): it proves the process hosted exactly the bytes
  Canary reviewed, not that those bytes arrived from the npm registry under a
  publisher key. Integrity + TOFU, not supply-chain attestation. In-process
  self-emulation (code inside the genuine pinned runner neutralizing the
  observer) remains unfixed *by construction* without an external root of
  trust — see docs/EXECUTION-AUTHORITY.md §8.

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
  conflicting flags are now hard rejections — see below; the option denylist itself was superseded by post-sol RB-1's closed allowlist + last-wins suffix.)
- **RT-F7 — proof honesty.** Proof compares numeric summary counts and
  *extracted failing-test names* (not loose substrings), validates the
  bundle on read, and asserts against the current run's artifact directory
  rather than a shared pointer file.
- **RT-F9 — auditable allowlist.** Every bundle round's `envKeys` is validated
  against the exact sanitized allowlist; `envExtra` was removed so no
  caller can widen a child's environment.

## Independent audit remediation (Codex audit 2026-08-30, findings F1–F15)

Full ledger with root causes, execution evidence and per-milestone commits:
**docs/AUDIT-REMEDIATION-2026-08-30.md** (round 1),
**docs/AUDIT-REMEDIATION-ROUND2-2026-08-31.md** (round 2) and
**docs/AUDIT-REMEDIATION-ROUND3-2026-08-31.md** (round 3 + internal adversarial
self-review). Headline outcomes, each covered by the then-current 371-test
suite (baseline now 438; see the Post-GLM section below):

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
- **F11 — CI runs the real proof assertions** (`run` + `check`). The CI
  golden-proof job is the DESIGNATED proof host (exact pins: node 26.3.0 +
  npm 11.16.0 on windows-latest), so every assertion executes there. (Updated
  by round-3 B3: the host-exact set is now SIX assertions — the two
  normalized-hash pairs, the evidence-environment↔proof-host binding, the
  runtime version match, and the per-round argv/envKeys re-derivations — and
  the gate reads the ACTUAL runtime, never the evidence's own metadata; off
  the proof host they report SKIPPED and the verdict downgrades to INCOMPLETE
  (exit 2), never PASS. Updated again by post-GLM F2: the runtime→proofHost
  comparison includes `nodeExecSha256`, the SHA-256 of the actual node
  executable bytes — the four metadata strings are claims a repackaged or
  patched runtime can print, so host-exactness now requires proving WHICH
  bytes executed; a committed proofHost lacking the digest pin is refused.)
- **F12 — `npm run report` works**; the report renders failing identities from
  the bundle itself.
- **F14 — this document**: guarantees tiered (A enforced / B convention /
  C absent); no fs-jail or network-allowlist claims anywhere.

### Round-2 Codex re-audit (B1–B6, 2026-08-31)

A re-audit of `f823b98` found six release blockers where the round-1 fixes were
real but incomplete; each is now fixed with reproduction + regression +
adversarial + mutation evidence (ledger: AUDIT-REMEDIATION-ROUND2-2026-08-31.md):

- **B1 — suite-qualified identity.** Failing-test identities now carry the full
  describe path, so two same-leaf-title failures in different suites stay
  distinct (the real Axios run has three; they were collapsed to two). Removes a
  false-CONFIRMED vector in rule-8 profile comparison.
- **B2 — execution validity.** Zero-test runs, no-runner-summary runs, and
  infra-shaped output at exit 0 can never become PASS (recognized at ANY exit
  code, without flagging benign prose that merely mentions an errno code).
- **B3 — artifact confinement + ownership.** Artifact filenames are derived from
  each round's arm/round (never the claimed `logPath`), which must equal the
  canonical name; every file is realpath-confined to the artifacts dir. Kills
  `../`/absolute traversal, cross-round and cross-type swaps.
- **B4 — evidence bound to bytes.** A manifest digest (content integrity, NOT
  authenticated provenance) plus per-round re-derivation of summary/counts/
  identities FROM the artifact bytes, plus assertProof pinning identity/schema/
  repo/commit/runtime, plus report verifying-or-labelling the evidence
  (banner wording since renamed SELF-CONSISTENT by post-sol F1). The
  bundle can no longer lie about what its bytes contain.
- **B5 — package-manager closed allowlist.** Raw `npm`/`npm-cli.js`/`$bin:npm`
  forms and unknown subcommands are rejected; install-family isolation flags
  are in effective position and a user `--` in an install is refused.
  (Option SPELLINGS were still denylisted by exact text at this point — the
  post-sol RB-1 finding; now closed allowlist + last-wins suffix, above.)
- **B6 — tree observation completeness.** EMPTY/partial dependency-tree
  observations no longer "prove" confinement; only a VALID observation (parsed,
  non-empty, contains the studied dependency) supports a trustful label.

### Round-3 Codex re-audit (B1–B6 + secondaries, 2026-08-31)

Ledger: **docs/AUDIT-REMEDIATION-ROUND3-2026-08-31.md**. Headline outcomes:

- **R3-B1 — identity coverage.** A failing round must fully account for its
  reported failure count with parsed identities (`identityCoverage`); partial
  parses cap every trustful label at INCONCLUSIVE (classifier rule 11 + an
  independent validator gate). Root-level mocha failures (`1) title:`) now
  yield real identities instead of collapsing to empty sets.
- **R3-B2 — pending is not execution.** "0 passing / 0 failing / N pending"
  can never PASS or CONFIRM (executed-total = passing+failing only); a summary
  with NO machine-readable counts proves nothing either. Hard infra patterns
  are line-scoped so a PASSING test quoting "Cannot find module" no longer
  false-INFRA's a whole round.
- **R3-B3 — host-exactness is reality, not paper.** The proof-host gate is
  decided by the ACTUAL verifying runtime (`actualHostFingerprint()`), never
  by the evidence's mutable environment block; resealed host metadata now
  FAILS the environment-binding assertion instead of skipping checks to a
  fake PASS, and any skipped host-exact assertion downgrades the verdict to
  INCOMPLETE (exit 2).
- **R3-B4 — release-critical fields bound to independent sources.** runId ↔
  the physical workspace directory; tarballSha256 ↔ the retained
  `fixture.tgz` bytes AND a required proof pin; per-round argv ↔ the committed
  spec re-expanded by the trusted policy code (proof host); envKeys ↔ the
  sanitizer policy re-evaluated (proof host); the full classification tuple
  (label/rule/REASON/reproductionCount) ↔ byte re-derivation + retained tree
  snapshots; failing identities asserted as an EXACT SET, not membership.
- **R3-B5 — wrapper-mediated execution closed.** Spec executables outside the
  literal allowlist (`node`; token forms) are refused fail-closed —
  `cmd /c npm install …`, `powershell`, `env`, `sh`, `xargs`, and
  pnpm/bun/corepack/volta frontends cannot reach a package manager with zero
  isolation flags.
- **R3-B6 — tree facts are now ANCHORED.** Each arm's `npm ls --json` raw
  stdout/stderr + canonical flatten are retained as arm-name-derived artifacts;
  an independent iterative re-flatten (different code path) re-derives hashes,
  copy counts, status, anomalies and drift; ANY observation anomaly caps the
  status at INCOMPLETE; a trustful verdict requires retained snapshots with
  EMPTY anomaly lists; and npm ≥ 11.19's empty-`{}` rendering of
  NOT-installed OPTIONAL deps is recognized as a complete observation —
  subject to the post-sol M-2 narrowing below.
- **Secondaries:** post-summary fatal-crash signatures (`crashSignal`) and
  failed containment sweeps (`sweepFailed`) now invalidate a round via rule 1;
  fetch/extraction failures are INFRASTRUCTURE (exit 2), not misuse (exit 3);
  subtree containment uses full-path-segment semantics.

### Post-sol round-4 remediation (RB-1/RB-2/M-1/M-2/F1, 2026-09-01)

Ledger: **docs/AUDIT-REMEDIATION-ROUND4-POST-SOL-2026-09-01.md**. The final
independent Sol review of the frozen candidate `a0baa0c` confirmed five
items, each fixed structurally here:

- **RB-1 — semantic package-manager policy.** The exact-string denylist could
  not survive npm's own equivalence semantics (probe-verified on 11.16 and
  11.19): unique-prefix abbreviations apply, `--no-` negations apply, the CLI
  layer is last-wins, and the per-package family (`--@scope:registry`) retargets
  resolution even against a global pin. Replaced by closed exact-spelling allow
  lists + protected-suffix injection + resolution-based key banning (Tier A
  above); Sol's four demonstrated forms are refused and a property test covers
  every prefix/negation/case/`=` spelling of every protected key.
- **RB-2 — suite collapse is not a verdict.** Classifier rules 12/13 and an
  independent validator gate require stable-across-repetitions, comparable-
  across-arms executed/observed totals for any strong verdict (no hard-coded
  minimum; the Axios regression shape is preserved). Post-GLM F1 extended
  "comparable" from cardinality to failing-set containment: a would-be
  PRE_EXISTING_FAILURE may not fail an identity the baseline never saw fail.
- **M-1 — one evidence contract.** `contract.ts` now generates the published
  schema and drives the runtime floor; the round-3 evidence fields
  (`snapshots`, `observationAnomalies`, `crashSignal`, `sweepFailed`) are in
  the published contract, the trustful tier is expressed in both views, and
  deleting `commands`/`killedByTimeout`/`startedAt`/`durationMs` is now
  refused at runtime (it was schema-only before).
- **M-2 — empty-tree nodes need corroboration.** A `{}` node excuses itself
  as an expected-absent optional only in a document whose problem channels
  are well-formed and uncontradicted (R4-SR1 refinement: ELSPROBLEMS demands
  problems, never the reverse — npm's extraneous-only trees are silent-stderr
  by design); malformed channels, mentioned names, `missing:true`, the studied
  dependency, and channel contradictions all fail closed. Both tree parsers
  now bound traversal (200k nodes / depth 128) and read under realpath
  confinement like round artifacts.
- **F1 — report honesty.** The banner says SELF-CONSISTENT, never VERIFIED,
  and states that committed-proof agreement is a prove/check-only property.

Secondaries fixed in this round: host-fingerprint sampling under sanitized env
(previously inherited the verifier's `NODE_OPTIONS`), lone-CR line-ending
parity across fact matchers/parsers, tree-artifact symlink confinement, deep-
tree budgets, and the string-`problems` producer/verifier differential.

**Honest integrity limits after rounds 3–4.** `sweepFailed` (and
`killedByTimeout` beyond its exit-code correlation) are KERNEL observations
the artifact bytes cannot carry — recorded, consumed by the decision table,
bound to the manifest, but not independently byte-re-derivable. Post-sol
M-2 narrows but does not eliminate the CONTENT-forgery surface for tree
observations: `{}`-as-optional is by construction indistinguishable in npm's
own output from a required dep silently missing, so retained-bytes
corroboration catches malformed/partial/contradicting documents but a forger
who controls the artifact directory and authors mutually consistent
stdout+stderr can still pose a complete tree (mitigated — not removed — by
the proof-host argv re-derivation and the committed proof pins; the studied
dependency can never be excused INTO presence). A total forger who re-derives
every bound field can still produce a self-consistent fabricated bundle. That
residual is tamper-evidence + committed-proof anchoring, NOT authenticated
provenance — restated here rather than hidden. Coverage parity (RB-2) reasons
from the experiment's own summaries; a suite that shrank BEFORE both arms ran
carries no cross-arm signal and is anchored only by the committed proof.

### Post-GLM observation hardening (finding A HIGH + B LOW, 2026-09-01/02)

A GLM-5.3 re-audit of the post-sol candidate `c1ff4e7` demonstrated that
`node -e "console.log('128 passing (1s)')"` — **no runner installed** —
classified **PASS**: the text channel had been the only execution authority.
Finding B (LOW) was its mirror image: case-SENSITIVE, ANSI-BLIND infra
matchers, where `"NPM ERROR code E404"` hid a genuine infrastructure failure
behind presentation alone.

Fixed at the architectural cause, not the auditor's strings — the full
contract (trust ladder, mechanism, rules 0..14, claim scope, verbatim residual
limits and the four items that are unfixable without a crypto root) is
**docs/EXECUTION-AUTHORITY.md**:

- **A — evidence AUTHORITY, not output heuristics.** No keyword lists, no
  `passing > 0` thresholds, no `node -e` special cases. A Canary-authored
  observer, injected only into a **byte-pinned** runner (TOFU allowlist),
  watches per-test lifecycle on a private fd and must AGREE with the text
  summary on every round for any strong label (rule 14: unattested or
  contradicted execution → INCONCLUSIVE, reason naming what it previously
  would have been). Enforced at three independent sites — the pure
  `classify()` gate, the `validateBundle` mirror keyed on its own constant,
  and prove's fifth-artifact byte binding — so weakening one leaves two.
  Subject `--require` in spec argv is refused fail-closed; unpinned runners
  get no injection and therefore no strength; forged frames from an unpinned
  fake buy nothing but a forensic `strayFd3Bytes` record.
- **B — presentation-symmetric matchers.** Case-folded HARD tier +
  ANSI-stripped, LF-normalized view at matcher entry (view-only: artifacts
  stay byte-exact; prove parity is structural). The pass/progress-glyph
  skip — which guards honest titles quoting error phrases — is now evaluated
  on the same stripped view, closing the false-positive half of the hole.
  Bidirectional battery: must-match AND must-stay-benign.
- **Robustness found en route:** `observationGateIssue` treats malformed
  disk-carried observations as a gate REFUSAL (rule 14), never a TypeError —
  the gate is total over hostile data (proven by test).

**Round 5 (self-falsification passes + adversarial panel, same branch).** Six
candidate findings survived refutation; two (the stale-pin class) were
already closed by commit `a87ae7f`, four became fixes:

- **F1 — containment for PRE_EXISTING_FAILURE.** Rule 13 additionally
  rejects a would-be PRE_EXISTING_FAILURE whose candidate fails ≥1 identity
  baseline never saw fail: a watched pass→fail transition is never swallowed
  into "already broken", and disjoint failing sets ({A} vs {B}) describe no
  comparable transition. Cardinality alone cannot see the compensated shape
  (baseline 1P+1F vs candidate 0P+2F keeps totals equal). The mirror
  (`validateBundle`) restates it; honest identical-failing-set PEFs and CRs
  are pinned to keep flowing (no over-block). Passing-side substitution at
  equal totals remains the deliberate F3 ceiling — documented and codified
  by a permanent test.
- **F2 — the mirror's "own constant" is now real.** Until this commit the
  schema mirror IMPORTED `STRONG_EXECUTION_LABELS`, so the "keyed on its own
  constant" phrasing above was aspirational. `STRONG_MIRROR_LABELS` is now a
  genuinely independent declaration in the schema package with a test
  pinning set-equality to the classifier's list: neither silent drift nor
  silent divergence.
- **F3 — §11 row truth.** Four validator branches named as permanently
  pinned (unparseable frame, non-object frame, `adapter-error`, masked-exit
  contradiction) were live but tested nowhere; they now have a layer-1 test.
- **F4 — rule-14 routing completeness.** Producers 6/7/8/12 had no routing
  test, so deleting the gate for exactly those four passed the whole suite.
  All four are now pinned, each with an attested-twin test proving the fact
  shape genuinely reaches its producer.
- **The stale-pin incident (root of the two pre-closed findings).** The
  `mocha@10.8.2` tree pin recorded at probe time (`68a0a02c…`) matched
  NOTHING — no install, no tarball, ever produced it. The true registry
  bytes hash `4b811f5a…`, confirmed three independent ways (golden-era
  fixture tree, clean `npm install --ignore-scripts`, official tarball whose
  sha512 equals the registry `dist.integrity`). Fail-closure held throughout
  — the golden proof degraded to INCONCLUSIVE, never a false PASS — but the
  claimed guard (a proof-host test) did not exist, so the fix is
  architectural, not "re-record the hash": a committed review manifest
  anchors the pin offline and a test recomputes `treeSha256` from the
  tarball's per-file bytes. One accepted panel kill: a frame-valid,
  zero-frame stream fooling the panel-H mirror is vacuous (a smart forger
  emits `hello`+`bye`; the mirror has no frame bytes to bind) — that is the
  §8 total-forgery ceiling, not a finding.

Permanent batteries: `apps/cli/test/execution-authority.test.ts` (exact GLM
reproducer verbatim), `apps/cli/test/attested-channel.test.ts` (validator +
end-to-end attack matrix), `packages/support/test/
known-runners-manifest.test.ts` (pins recomputed from committed review
manifests; canary-double explicitly manifest-free), `packages/runner/
executor/test/infra-matching-hardening.test.ts`, extended classify/schema/
prove/verify-tree suites. Post-GLM F5 (canary-double origin gate: the
double's public in-repo bytes earn execution authority only behind an
in-process test grant the production CLI never passes) is pinned in
`packages/support/test/known-runners-manifest.test.ts` (F5 posture matrix),
`packages/runner/executor/test/executor.test.ts`, and the F5 untrusted-/
trusted-pair in `apps/cli/test/attested-channel.test.ts`. The golden proof's 36 expectations and `proof.json`
were NOT re-anchored: the legitimate path passes through the real mechanism
(pinned 10.8.2 on the proof host) or degrades honestly off-host.

Suite baseline moved **371/52/370/0/1 → 423/60/422/0/1** (tests/suites/
pass/fail/skip) at commit `eb61f61`, then **425/61/424/0/1** with the pin
review-manifest anchor (`a87ae7f`), then **438/64/437/0/1** with the round-5
fixes; the one skip remains the platform-conditional symlink test. The
demonstrated class cannot recur silently: the counterexamples are now part
of the permanent test contract.

## Platform status (audit F15 — no unproven cross-platform claims)

- **Windows (win32/x64, Node 26):** the fully executed platform — entire
  438-test suite (64 suites, 1 platform-conditional skip), including
  real-subprocess lifecycle/env tests, and the golden Axios proof — 36
  assertions executed with ZERO skips on the designated proof host
  (win32/x64/node v26.3.0/npm 11.16.0; re-executed on the post-sol candidate
  2026-09-01 with unchanged expectations), 22 portable assertions executing
  and 6 host-exact skipping to an INCOMPLETE verdict on drifted hosts (fresh
  full run verified on node v26.7.0 / npm 11.19.0 on 2026-09-01, which
  additionally exercises the npm-11.19 empty-node tree representation
  end-to-end under the narrowed M-2 rule).
- **Linux (POSIX paths):** the offline test suite, POSIX branches of the
  process sweep and env observation, and the pipeline's tar path are WRITTEN
  but have NOT yet been executed on Linux (no Linux host in the remediation
  session; CI's ubuntu legs run on push, not on this commit yet). The CI
  `core` job (ubuntu) runs the offline suite; the golden-proof job remains
  windows-only. Do not describe the golden proof as Linux-proven until a
  Linux run exists.
