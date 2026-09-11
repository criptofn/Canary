# Migrating 1.0 → 1.1

Canary 1.1 adds ecosystems, agent capability reporting and sealed authority. It
was built so that an existing 1.0 installation keeps working **without touching
its config**, and the parts that guarantee that are pinned by tests rather than
promised.

## What stays byte-identical

| Thing | Why it does not move |
|---|---|
| `planDigest` | The digest adds the new step fields **only when they are present**, in a fixed order. A plan of `<pm> run <script>` steps hashes exactly as it did in 1.0, so every existing seal stays valid. A test writes the old formula out longhand and compares. |
| `scriptDigests` keys | Legacy steps key on the bare script name. Scope-qualified keys (`scope::script`) appear only for steps that carry a scope — i.e. never for a 1.0 Node plan. |
| The `.canary/canary.local.json` bytes for a Node-only repo | Setup still omits the `project` key entirely, and a Node-only composite plan is the same plan as before (same steps, same order, same `pm`, same seal). |
| Exit codes | Unchanged across every command. |
| The attested pipeline (`run` / `prove` / `check` / `report`) | Untouched by this work; the dependency-swap domain still behaves as it did in 1.0. |
| Evidence bundles | The generated contract is unchanged; nothing in the new tiers writes into the attested pipeline's artifacts. |

## What changes for you

1. **A sealed copy of your authority appears outside the repo.** Your first
   `canary setup` after upgrading mints it in the trust store
   (`%LOCALAPPDATA%\canary\trust` on Windows, `~/.local/share/canary/trust`
   elsewhere). Until then, `canary status --verbose` says
   `sealed copy: none yet` — that is a fact about the store, not a problem with
   your project. Nothing is sealed automatically; the store is only written by
   `setup`.
2. **Setup prints the plan from a composite view.** For a Node-only repo the
   plan is identical, but the wording of the plan line changed. If your repo root
   declares **more than one** ecosystem (for example a `package.json` *and* a
   `pyproject.toml` in the same directory), setup now discovers and seals checks
   from all of them — read the plan it prints before accepting it. Checks in
   *sub*directories are deliberately not discovered (see
   [`COMPATIBILITY.md`](COMPATIBILITY.md)).
3. **`doctor` no longer requires a `package.json`.** A directory with no
   project Canary can model reports `UNSUPPORTED`; a project that simply was
   never set up reports `NEEDS ATTENTION`. Previously both were `UNSUPPORTED`.
4. **New commands**: `canary result` (free, machine-readable state) and
   `canary agents` (which agents work here, and at what capability).
5. **`--json` is available on the everyday commands.** In JSON mode the human
   prose moves to stderr and stdout carries exactly one versioned object. Exit
   codes and status words are identical with and without the flag.

## What a 1.0 store cannot contain

There is no 1.0 store: the sealed authority is new in 1.1. A v1.0 installation
therefore starts from an empty store, and an empty store **fails closed** — reads
report `unavailable`/`missing` rather than inventing authority. Running `setup`
is what creates the first record, exactly as it creates the first config.

Records are never migrated, re-signed or auto-repaired. If a record fails
verification it reads as `forged`/`malformed`, and the recovery is a deliberate
`canary setup` re-seal — never a silent rewrite.

## Rollback

Nothing in 1.1 rewrites 1.0 state in place, so a rollback is: stop using the new
commands, and (optionally) delete the trust store directory. Your
`.canary/canary.local.json` is byte-compatible with the 1.0 CLI, and the sealed
copy is a mirror that detects divergence — it is never the sole authority for the
everyday tier.

## If you use the candidate workflow

`canary task` / `isolate` / `isolate --verify` / `isolate --promote` /
`accept` keep their semantics and their sealed-plan checking, now with the plan
sealed over the composite view. Candidates created before the upgrade still
verify against the authority frozen in their own record. `canary accept` still
refuses the non-interactive path by design.
