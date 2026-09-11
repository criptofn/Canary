# The `spec.json` contract

`canary run`, `canary prove` and `canary check` take one declarative input: an
experiment spec. This document is the author-facing contract.

- Machine-readable schema: [`schemas/spec.schema.json`](https://github.com/criptofn/Canary/blob/main/schemas/spec.schema.json)
- Authoritative runtime validator: `packages/core/planner/src/index.ts` → `validateSpec()`
- Shipped example: [`fixtures/axios-0.27-to-1.0/specs/axios-mock-adapter.json`](https://github.com/criptofn/Canary/blob/main/fixtures/axios-0.27-to-1.0/specs/axios-mock-adapter.json)

If the schema and the validator ever disagree, the validator wins and the schema
is the bug — report it.

## Shape

An experiment is two arms of the same downstream project, differing only in one
dependency's version, each executed several times:

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | `1` (legacy) or `2` (current). |
| `id` | yes | `[A-Za-z0-9._-]+`. Names the run directory and is how `report` finds the latest evidence. |
| `dependency.package` | yes | npm package name, optionally scoped. |
| `dependency.baseline` | yes | Version installed in the **baseline** arm. |
| `dependency.candidate` | yes | Version installed in the **candidate** arm. Must differ from `baseline`. |
| `downstream.repo` | yes | `owner/name` on github.com. |
| `downstream.commit` | yes | **Full 40-hex commit SHA.** Branches and tags are refused: the arms must be reproducible from the record alone. |
| `commands.prepare` | yes | Non-empty array of argv arrays, run once before either arm. |
| `commands.swap` | yes | The act that distinguishes the candidate arm. Must contain a `{candidate}` token. |
| `commands.test` | yes | The evidence engine — the downstream project's real test command. |
| `commands.build` | no | `null`/omitted, or an array of argv arrays. |
| `commands.toolchainOverrides` | no | Pins applied **identically to both arms** and recorded in evidence. |
| `repeats.baseline` | yes | Number of baseline rounds, `>= 2`. |
| `repeats.candidate` | yes | Number of candidate rounds, `>= 2`. |
| `timeoutSecs` | no | `install` / `test` / `build`. A timeout is a killed round (`exit -1`) → `INFRASTRUCTURE_FAILURE`, never a test result. |
| `environmentNotes` | no | Human notes, recorded in evidence, zero verdict authority. |
| `notes` | no | Author notes. Never read by the classifier. |

Two rules JSON Schema cannot express, both enforced at runtime:
`dependency.baseline !== dependency.candidate`, and every argv being non-empty.

## Commands are argv arrays, never shell strings

Every command is an array of strings. There is no shell, so no quoting, globbing
or `&&` chaining can change meaning or be used to smuggle a second command. If
you need a sequence, use the stages (`prepare`, `build`, `test`) or write a
script into the downstream project deliberately.

## Placeholder tokens

Tokens are expanded by the pipeline before execution. The shipped fixtures use
four; the expansion table in `apps/cli/src/pipeline.ts` is authoritative.

| Token | Expands to |
|---|---|
| `$npm` | the trusted, resolved npm executable — not whatever `PATH` happens to hold |
| `$bin:<name>` | a binary resolved from the downstream project's installed `node_modules` (e.g. `$bin:mocha`) |
| `{dep}` | `dependency.package` |
| `{candidate}` | `dependency.candidate` |

`$bin:` is load-bearing for evidence quality: a runner reached this way can be
located, hashed and matched against the pin table
(`packages/support/src/knownRunners.ts`), which is what makes an execution
*observed* rather than merely *printed*. See
[`docs/EXECUTION-AUTHORITY.md`](EXECUTION-AUTHORITY.md) for what that buys and
what it does not.

## Minimal working example

```json
{
  "schema": 2,
  "id": "my-dependency-bump",
  "dependency": { "package": "left-pad", "baseline": "1.2.0", "candidate": "1.3.0" },
  "downstream": { "repo": "owner/project", "commit": "<40-hex-commit-sha>" },
  "commands": {
    "prepare": [["$npm", "install", "--before=2023-01-01T00:00:00Z"]],
    "build": null,
    "swap": ["$npm", "install", "--no-save", "--no-package-lock", "{dep}@{candidate}"],
    "test": ["$npm", "test"]
  },
  "repeats": { "baseline": 2, "candidate": 2 },
  "timeoutSecs": { "install": 900, "test": 600 }
}
```

## Validating your spec

The runtime validator runs before anything executes, so a malformed spec fails
closed with an explicit message. For editor/CI feedback, validate structurally
against the published schema:

```sh
# any JSON Schema 2020-12 validator
npx ajv-cli@5 validate -s schemas/spec.schema.json -d my-spec.json --spec=draft2020
```

Note the limits, so you do not read more into a green schema check than it
carries: passing the schema means the spec is *well-formed*, not that it
describes a meaningful experiment. The classifier still refuses to make strong
claims when the arms cannot support them — coverage differences between arms,
unstable repetitions, and unattested execution all downgrade to `FLAKY` or
`INCONCLUSIVE` (rules 12–14 in the decision table of
[`docs/PLAN.md`](PLAN.md) §6).

## Scope, honestly

The attested pipeline currently expresses exactly one experiment shape: a
dependency version swap, judged by the real test suite of a pinned downstream
project. That is a deliberate proof-of-value domain, not the product boundary
(see [`docs/ADR-001-product-direction.md`](ADR-001-product-direction.md)).

Verifying an arbitrary candidate commit or working-tree diff with the same
attested strength — arms, repetitions, and the execution-observation channel —
is not expressible yet; the candidate workflow (`canary work` / `canary finish`)
deliberately runs the sealed plan once and is therefore the weaker sibling
promise, as [`docs/COMPATIBILITY.md`](COMPATIBILITY.md) states. Giving ordinary
changes that strength is the next step that would let the everyday agent workflow
share the strongest evidence
machinery instead of a weaker sibling artifact.
