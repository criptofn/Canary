# Canary 1.0 authorization contract

Completion authorizes only the exact clean committed candidate against its
frozen base and applicable sealed authority, for the exact declared task and
requirements. Every objective duty must be proven independently. Every
remaining subjective duty requires terminal acceptance of that same subject.

The agent's normal flow is:

```sh
canary setup
canary task "Fix the TypeError"
canary isolate fix
# Work and commit in the displayed candidate directory.
canary isolate --verify fix
canary isolate --promote fix
```

Setup is reused across tasks. Promotion repeats verification and fast-forwards
the base only, then checks the applied commit/tree. A stored evidence bundle
cannot authorize promotion. A missing frozen task cannot be repaired by late
registration: register the task and open a new candidate.

For "make my game prettier", technical tests can pass while completion remains
NOT PROVEN. A functional e2e does not prove aesthetics. Review the exact committed
candidate, then run `canary accept fix` yourself in an interactive terminal.
Commit all intended changes before review; acceptance refuses dirty or unresolved
state and rechecks the full subject after the typed confirmation. Mixed work,
such as "fix the crash and make the dialog prettier", needs both regression
evidence and subjective acceptance. A red technical check always blocks.

## Objective targets

"Render latency under 100ms" has an objective truth condition. A generic bench
script is insufficient; human acceptance cannot waive the missing measurement.
Use a script that asserts the threshold, and bind it explicitly:

1. Run `canary task "render latency under 100ms"`. Copy the printed target digest.
2. Add `"canary": {"proofs": {"<that 64-character digest>": "bench"}}` to
   `package.json`. `scripts.bench` must assert this exact target. For an objective
   UI specification such as "button must be #D94141 and width 240px", use an
   e2e script that asserts those properties and bind its printed digest to `e2e`.
3. Commit the script and mapping; run `canary setup` to inspect and seal the
   selected plan and binding, then isolate the candidate.

Bindings reference selected plan scripts of the matching kind. Setup rejects
malformed mappings. A candidate cannot replace the sealed script text; replacing
frozen proof authority requires re-isolation. Canary checks this explicit mapping
and command success. It does not infer that arbitrary test code measures the
declared threshold. The human-approved mapping is the semantic trust boundary.
Non-numeric subjective performance requests, such as "make scrolling feel faster",
may require human judgment even when a generic benchmark exists.

## Identity and freshness

`authorization.ts` owns canonical declarations, frozen/live comparison and the
acceptance subject digest. Registration, isolation, review and consumption share
these functions. There is no separate legacy acceptance-scope hash.

`canary-task/2` contains the request digest, conservative union of task kinds,
requirement count and digests, subjective visual/performance flags, and explicit
objective target identities. Text is trimmed and whitespace runs collapse to a
space before hashing the entire UTF-8 value. There is no 4000-character prefix
limit. There are at most 64 requirements; the 65th refuses the whole registration
without changing the prior record. Requirements form a sorted multiset: reordering
is inert; duplicates retain multiplicity.

`canary-acceptance/3` stores a canonical subject and its SHA-256 digest, candidate
name, timestamp and `acceptedBy: tty-human`. The subject binds candidate commit
and tree, frozen base commit/tree, applicable sealed plan/script/proof authority
and Git store, full frozen/live task identities, and subjective duty IDs.
Timestamps, display wording and evidence paths do not control freshness.

Material task replacement, such as warm red to cool blue under the same `ui`
kind, requires re-isolation. Frozen requirements must remain represented;
replacement or removal also requires re-isolation. Growth is permitted but old
acceptance does not cover the added scope. Changed candidate commit/tree or
applicable authority stales consent. Restoring the exact accepted subject cleanly
can restore freshness; this is intentionally content equality, not permanent
revocation. Invalid or old incomplete records fail closed at candidate completion.

## Claims and limits

Status and bare Canary perform the same read-only recognition checks, with no
project commands or project writes. CONNECTED and past checkpoint output are
not claims of present code health. Candidate PASS is a live observation; evidence
persistence is best-effort. Failed storage is not a durable proof artifact.

The normal unattended acceptance path refuses. A TTY is not cryptographic human
identity: same-UID PTY automation, direct local file forgery, mutable runtimes and
change-and-revert within a sampling window remain outside the enforceable local
boundary. Sealed command text does not make candidate-authored tests meaningful.
Classification is deterministic and declaration-bound, not a semantic theorem
prover; under-declaration remains a limitation. Candidate verification is weaker
than the dependency experiment pipeline's isolated baseline/candidate repetitions.
See [SECURITY.md](SECURITY.md) and [EXECUTION-AUTHORITY.md](EXECUTION-AUTHORITY.md).

No daemon, model/API call, account, runtime dependency or remote attestation was
added for 1.0. The extra human step is only the authority-bearing review for
subjective completion; explicit objective thresholds need inspectable proof
bindings, not human acceptance.
