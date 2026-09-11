# Security policy

Canary's security model — what is enforced in code, what is a structural
convention, what is only a contract without an installed provider, and the local
ceilings it explicitly does **not** claim — lives in:

- [`docs/SECURITY.md`](docs/SECURITY.md) — the full contract, tiered.
- [`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md) — where authority
  lives today, and the list of providers that do not exist yet.
- [`docs/CAPABILITY-LEVELS.md`](docs/CAPABILITY-LEVELS.md) — what `LOCAL`,
  `ADVISORY`, `UNSUPPORTED` and the unreachable `HARDENED` mean, and how the level
  is measured.

This file exists so GitHub's security tooling and anyone scanning the repository
root can find the policy.

**Read the ceilings before reporting.** They are deliberate and detailed: there is
no filesystem jail and no network egress allowlist for the code Canary runs, the
evidence manifest is tamper-*evidence* rather than authenticated provenance, the
trust store is protected against forging but not against a same-UID process
replacing it wholesale, and `HARDENED` is not available because no provider with a
separate OS identity is installed. A report that something already documented as
out of contract is not a vulnerability — but a report showing that a *documented*
bound is weaker in practice than claimed is exactly what we want.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). If that channel is unavailable, open a
normal issue asking for a private contact channel and containing **no exploit
details**.

Please include, where applicable:

- the exact commit or tag;
- the command you ran and its full output (Canary's own discipline: a claim
  without a reproduced command is not yet a report);
- which tier of `docs/SECURITY.md` the finding breaks — Tier A (enforced in code),
  Tier B (structural convention), or Tier C (absent and not claimed);
- whether it needs same-UID access, a hostile repository, or a hostile spec.

## Supported versions

v1.1 is an implementation candidate, not a release. Fixes land on the current
development branch; older tags are not maintained.
