<!--
  Keep this short. The one thing reviewers need is evidence, and Canary has a
  very specific idea of what that means: the reporter output of a command you
  actually ran.
-->

## What changed, and why

<!-- One or two sentences. Link the issue if there is one. -->

## Evidence

<!--
  Paste the summary block of the command you ran. `npm run verify:productization`
  is the preferred entry point; `npm test` is the minimum for a code change.
  Include SKIP lines verbatim and say why each one is host-bound.
  "Tests pass" is not evidence. The reporter output is.
-->

```text

```

## Claim impact

- [ ] No promise changes — this is internal, a fix, or documentation.
- [ ] A promise changes, and the owning document is updated in this PR:
      `docs/EXECUTION-AUTHORITY.md` (what is attested) /
      `docs/SECURITY.md` (enforced vs convention) /
      `docs/AUTHORIZATION-1.0.md` (what completion authorizes) /
      `docs/SPEC-FORMAT.md` + `schemas/spec.schema.json` (spec contract).

## Checklist

- [ ] No inline interpreters (`node -e`, `python -c`, `bash -c` with generated
      code) were used for multi-step verification; probes live under
      `tooling/probes/` or fixtures under `tooling/test-support/fixtures/`.
- [ ] No gate was weakened and no strong verdict became reachable without a
      VALID execution observation on every round (rule 14).
- [ ] New end-to-end guarantees have a probe; new interfaces have a contract
      test next to the package.
- [ ] Any test count quoted in this PR comes from an executed reporter's summary
      block, per `docs/TEST-COUNTING.md`.
- [ ] `npm run verify:productization` was run on this exact tree.
