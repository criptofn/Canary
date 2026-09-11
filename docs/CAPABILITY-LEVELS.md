# Capability levels

Canary reports how much protection it can actually provide, and it **measures**
that instead of assuming it. The level is in every `canary result --json` /
`canary status --json` envelope (`security.level`) and in the verbose `status`
line, and it is produced by a probe that fails closed.

| Level | Means | How it is established |
|---|---|---|
| `HARDENED` | Authority is protected from the worker's own identity: the worker cannot rewrite the records, the key, or the history that judge it. | Requires a broker with a **different OS identity** than the worker. The provider that establishes it is IMPLEMENTED (`apps/cli/src/provider/`) but not INSTALLED here, and `HARDENED` is produced only by a boundary MEASUREMENT in which every control is observed available (`measuredCapabilities`). Run `canary provider status` to see which control is missing on this host, and `canary provider install-plan` for the privileged steps. |
| `LOCAL` | Records are sealed with an Ed25519 key that lives outside every project tree, so rewriting repo bytes no longer rewrites the checker's memory of them. The **same uid** that runs the worker can still replace the store, the key and the ledger together. | The store write probe **succeeds** — which is exactly what proves a same-uid writer could also write it. |
| `ADVISORY` | Canary observes and reports, but cannot prevent or block. | Used where a mechanism is a convention rather than an enforcement point. |
| `UNSUPPORTED` | The probe could not establish even the weaker guarantees (for example: the store is not writable, so authority-changing operations cannot be trusted). | The write probe fails, or the store cannot be examined. Verdicts that would need authority fail closed. |

## What `LOCAL` does and does not buy

**It does** mean an agent can no longer forge authority by editing the repository:
records are sealed outside the repo, and every read fails closed on any status
except `valid`. A record moved to another project's shelf, re-signed with a
foreign key, replayed at an older sequence, or altered by a byte reads as
`forged`, `mismatch`, `stale` or `malformed` — never as valid.

**It does not** mean the store is protected from a determined same-UID process.
That process can delete or replace the store, its keypair and its ledger
together — which is why the level is `LOCAL` and why the words "hardened" and
"protected" are not used for it anywhere in this build.

Refused on purpose, and each refusal has a test:

- key material that is a **symlink, junction or hardlink** (a second name for
  custody-bearing bytes is not authority);
- a keypair whose **halves disagree** (the old failure mode signed records that
  then read as forged, which is indistinguishable from an attack);
- a **reserved Windows device name** as a record id or kind;
- a record whose sequence **disagrees with the ledger**, or a store with a
  **missing/corrupt history** (lost history never becomes an empty history);
- concurrent minting that would silently **lose a generation** of the sequence
  ledger (minting is serialized, and a lock that cannot be taken is a refusal,
  never a guess).

## The honest ceiling, stated once

The enforceable boundary ends at the worker's own identity. Everything above the
`LOCAL` line — the broker with a separate identity, the restricted runner, the
protected promoter, the authenticated review path — is **implemented but not
INSTALLED**: the provider exists (`apps/cli/src/provider/`, with its boundary
measurement, authenticated IPC, refusing service and privileged install plan,
plus Linux enforcement code that carries `hostVerified: false`), and nothing in
this build routes the CLI's real paths through it yet. Until the owner authorizes
activation, the honest level remains `LOCAL`, and the measurement says so.

`docs/SECURITY.md` remains the full contract, including the tiers
(A: enforced in code, B: structural convention, C: absent and not claimed) and
the list of things Canary deliberately does not claim: no filesystem jail, no
network egress allowlist, no cryptographic trust root.
