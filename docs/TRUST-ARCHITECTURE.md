# Trust architecture

Where Canary's authority physically lives, what guards it, and — stated with the
same emphasis — which parts of the design are **contracts without an installed
provider**. Capability levels and how they are measured are in
[`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md); the full security contract with
its tiers and ceilings is [`SECURITY.md`](SECURITY.md).

## The one-sentence version

The worker may build software; it must not own the authority that decides whether
the work is proven. This document describes how far that is actually enforced
today (not far enough for the word "hardened", which is why nothing says it).

## What exists and is enforced

### 1. The sealed authority store (outside every project tree)

| Piece | File | What it does |
|---|---|---|
| Record envelope | `apps/cli/src/authority-envelope.ts` | Signed-record serialization that **preserves every key**, including `__proto__`; refuses accessors, sparse arrays, non-finite numbers, and documents deeper than 32 levels or larger than 1 MiB. `signedBytes()` defines exactly what a signature covers. `verifySeal()` needs only a public key and imports no filesystem or execution capability, so worker-side code can verify a record without being able to mint one. |
| Store | `apps/cli/src/trust-store.ts` | `keys/ed25519*`, `records/<project>/<kind>.json`, `ledger.json`. Minting is serialized by ONE store-wide lock with a bounded wait and an explicit refusal (a held lock is never stolen; a killed holder costs a 5 s wait, not a wedge). Sequence updates are compare-and-set against an `expectedSeq`, a record whose sequence does not equal the ledger's is not `valid`, and a missing or corrupt history never reads as an empty history. Keys are never regenerated automatically in an initialized store. Writes are atomic (temp + fsync + rename). Key material that is a symlink, junction or hardlink is refused, as is a reserved Windows device name as a record id. |

Two probes answer "how strong is this, really?":

- `probeTrustLevel` **measures** by writing. A successful write proves the same
  uid that runs the worker could write it too — that is `LOCAL`, named plainly.
- `probeTrustLevelReadOnly` is the companion for commands that promise zero
  writes (`status`, `result`, `agents`): an access check plus store presence, no
  write, with the reason text saying which measurement produced the level.

Neither can return `HARDENED`: there is no code path that could honestly do so.

### 2. The authorization kernel (implemented, not yet wired to the CLI)

`apps/cli/src/broker.ts` is the control-plane **logic**: a worker may *request*,
and only controller-held state authorizes.

- `enroll(Enrollment)` is controller-only, one-time, and pins the subject,
  plan/environment digests, objective duty ids, network authority, target id and
  **distinct** Ed25519 verifier and reviewer keys. It refuses `HARDENED` and
  re-enrollment, and there is no generic signing endpoint.
- The only worker endpoint is `request(json)`, ≤ 64 KiB, with exact fields
  (`request-verification`, `submit-verification`, `submit-acceptance`). There are
  no worker-selected commands, paths, cwd, mounts, keys, environments, network
  overrides or promotion verbs.
- A ticket binds a random 256-bit run id, sequence, subject digest, policy digest
  and purpose; a new ticket invalidates older verification and acceptance even
  when the source bytes are unchanged.
- Supervisor and reviewer receipts are signed by their **separate** pinned keys
  and must carry every ticket field, the evidence digest and the exact duty set.
  An unmet or unknown objective result cannot be signed away by a reviewer.
- `beginPromotion` / `reservePromotion` are controller-only and create a
  **fresh promotion-purpose window**; the reservation is a LOCAL intent that
  mutates no Git state.
- The kernel executes nothing: no candidate code, no project checks, no Git, no
  plugins. That property is transitive by design.

### 3. Platform contracts (declared, deliberately unimplemented)

`apps/cli/src/platform-boundary.ts` declares what a real provider chain must
satisfy and **refuses** rather than silently downgrading: `VerificationJob`,
`VerificationSandbox`, `VerificationSupervisor`, `ProtectedPromoter`,
`NetworkAuthority`, plus capability reporting.

## What does NOT exist — and what that means

No installed provider implements any of the following, so none of it protects
anything today:

- a broker **service** with authenticated local IPC and controller-only enrollment;
- **immutable source import** and a verification supervisor holding approved
  plan/environment handles;
- a real **filesystem/process/egress sandbox** with a separate runner identity;
- **proof collection inside** that boundary (today's plan execution is the 1.0
  hardened-env path, which is a process/environment boundary, not an OS jail);
- an authenticated **review path** with reviewer credential custody;
- a **protected promoter** with atomic ref CAS and crash reconciliation;
- enforced **network policy**, OS identities/ACLs, key rotation, and
  install/upgrade tooling.

Consequences, stated once and not softened:

1. `canary setup`, `doctor`, `checkpoint`, `isolate`, `accept`, `promote`, `work`
   and `finish` run on the **LOCAL** sealed store. They are unchanged by the
   kernel's presence.
2. `HARDENED` is unreachable. Requesting isolation that cannot be established
   means *refusing the request*, never quietly reporting `LOCAL`.
3. The same uid that runs the worker can replace the store, its keypair and its
   ledger together. Sealing detects; it does not prevent.
4. On Windows, mode bits do not protect the private key and Node cannot fsync a
   directory; power-loss durability needs a provider-level answer.

## Why the kernel is here anyway

Because the *order* matters. A boundary that is specified and tested before the
providers exist can be implemented against tests; a boundary invented alongside
its first provider is implemented against whatever that provider happens to do.
The kernel and its contracts are the specification, the attack suites
(`trust-store-attacks`, `broker`, `platform-boundary`) are its behavioural
definition, and `tooling/probes/p0-trust-boundary-mutations.mjs` kills 14/14
behavioural mutants of it — including a mutant that tries to let routine evidence
become promotion authority.

What is *not* acceptable, and is therefore not present anywhere in this
repository, is describing the contracts as protection.
