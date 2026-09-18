# Trust architecture

> Current v1.2 production boundary: [mechanism and limits](V1.2-CONFINED-CALLER.md).
> Executed integration evidence and release status: [report](V1.2-HARDENED-FINAL-BLOCKERS.md).

Where Canary's authority physically lives, what guards it, and — stated with the
same emphasis — which parts of the design are **contracts without an installed
provider**. Capability levels and how they are measured are in
[`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md); the full security contract with
its tiers and ceilings is [`SECURITY.md`](SECURITY.md).

## The one-sentence version

The worker may build software; it must not own the authority that decides whether
the work is proven. This document describes how far that is actually enforced
today. LOCAL sealing is not OS isolation; only the measured production boundary
can activate HARDENED.

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

Neither can return `HARDENED`, and `securityCapability()` never asks them to: when a
provider is configured it takes the level from the measured boundary instead
(§3), and only a store with no provider falls through to these probes.

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

### 3. Production confined-caller provider

The production Windows path is implemented in `provider/production.ts`,
`production-measurement.ts`, `production-attacks.ts` and the small native
launcher/pipe broker. Its complete chain, authority owners and deployment
commands are documented in [V1.2-CONFINED-CALLER.md](V1.2-CONFINED-CALLER.md).

It reuses the existing candidate gates under confined execution, owns final
promotion and readback, and authenticates raw measurement evidence with Ed25519
custody anchored outside caller-selected stores. Current tool/deployment/host/store
bindings, a 15-minute freshness ceiling and a live signed broker challenge are
all required. Schema-1 harness records and LOCAL reservation receipts cannot
enable HARDENED or authorize caller-owned apply.

`boundary.ts` derives all six controls from that production evidence.
`measuredCapabilities` remains all-or-nothing; provider presence, declarations,
saved transcripts or standalone probes cannot substitute for a measured current
deployment and live authenticated broker. Legacy identity/service observations
are reported separately and do not activate the production path.

## Limits

The normal-user operator/broker is trusted. The adversary is the confined builder
or candidate, not a holder of that user's unrestricted token. There is no claim
of administrator resistance, exhaustive network-protocol coverage, a separate
installed service account, key rotation, power-loss durability or Linux runtime
verification. Unsupported verification tooling fails closed.

Ordinary LOCAL workflows remain LOCAL. Configuring a provider forbids local
caller apply; the enrolled production protocol is required for protected review
and promotion. The legacy broker kernel and IPC remain LOCAL contracts, not an
alternate HARDENED signing route.

The full productization battery and merge remain separate release gates.
