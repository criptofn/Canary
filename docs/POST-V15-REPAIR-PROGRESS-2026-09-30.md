# Canary: scoped verification and a usable repair loop (2026-09-30)

This change closes reproducible product defects after 1.5. It does not establish
a new product rating or replace the outstanding native agent pilot.

## Observed defects and changes

| Observed defect | Change | Evidence |
| --- | --- | --- |
| Setup discovers nested Node scripts but seals only root script text. A repository with no root package.json immediately fails the hook's authority check. | Seal each declared scope's own package.json text under its qualified step key; compare live text from that same contained scope. | The same installed-package repair journey fails before the change and passes afterwards. Two scopes need no root package.json. |
| Same-kind failures write their combined output to the same tests.log. | Number the combined failure logs. | Both scoped pointers contain their own run; a unit counterexample failed before the change. The pre-existing numbered stdout/stderr bundle logs were already distinct. |
| A large message is chopped at 1,200 characters, including its output path. | Drop excerpts, then reduce the number of displayed checks, preserving complete commands and paths. List the remaining failure count and the evidence lookup. | The long-path counterexample failed before the change and passes afterwards; an oversized single path has an explicit fallback. |
| The completion block lacks the focused repair command that doctor already provides. | Both surfaces print the exact sealed check command, quoting unusual ids for PowerShell on Windows and POSIX shells elsewhere. Doctor identifies the actual executed step even when kinds coincide. | Hook, full doctor and PARTIAL diagnostic are exercised together, including a scope containing a space. |

The full repair journey uses two fresh Node scopes (`backend` and `front end`),
sealed assertions and initially incorrect source values. It verifies:

1. Both failures block and have separate usable logs and exact recheck commands.
2. Changing a scoped package script blocks before that command can run. A
   diagnostic on the other scope also refuses the changed authority.
3. Repairing one source value permits a PARTIAL diagnostic but leaves the full
   checkpoint unchanged; the other failing check still prevents a passing result.
4. The loop guard permits handoff with status `fail`, never a passing result.
5. Repairing both source values allows full completion. The sealed checks fail on
   the baseline and pass on the repaired source; test commands and assertions stay
   unchanged.

Separate controls reject missing manifests and a scope linked outside the
repository. A root script with the same name cannot supply a nested script's
authority. Root-only seals and existing CLI JSON/status contracts are retained.
Previously incomplete or incorrect nested seals require an explicit setup rerun;
they are not silently upgraded into trusted records.

## Installed artifact comparison

Both packages were installed offline with lifecycle scripts disabled into
separate installation directories. The instrument selects an explicit path via
`CANARY_TEST_CLI`; these comparison runs do not fall back to the development CLI.

| Artifact | SHA-256 | Journey |
| --- | --- | --- |
| Existing package packed before this change | `edec88f57a64f635097aa03fd009b76ebeaa3a60d6e2ba6e5756ad5dfcf67826` | FAIL: nested script never sealed; exit 1 |
| Improved package | `00748588cb6db5f44f3f69d0051f3ecc9a1fca673d0062d995d1fe32750782bf` | PASS: complete journey; exit 0 |

These are local post-release packages, not a comparison against the GitHub 1.5.0
release artifact. Both report version 1.5.0, so version alone does not identify
them. Installed CLI hashes, respectively:
`5dc347e43e8de71778b9f0e36b3b31dad83864d984e9b25925109a7be4041390` and
`348bfdb7b6ad486bd084317ef157da6699f435d9f36f6b630f453ed8ef77abb9`.
Compiled journey instrument SHA-256:
`c0cbbcf8761d5011e7e8ace3ce08a6657f955834f421a4898ae7a00ea1b5aaa4`.
Shared assertion fixture SHA-256:
`1bcb46fd5bf8ab13f6ef5bf3c8c7c4af5f17f690c446a9fa61c7721eec3afdf6`.

Reproduction after building the test instrument (two explicit installed CLI
paths; before must reproduce the known defect and after must pass):

```powershell
node tooling/probes/completion-repair-compare.mjs '<before installed main.js>' '<after installed main.js>' '<evidence directory>'
```

The probe writes both raw logs and `comparison.json`, including versions, exit
codes, runtime, CLI hashes and hashes of itself, the test and the assertion
fixture. The comparison ran successfully: before exited 1 with the missing seal;
after exited 0 with every repair assertion passing. Its overall exit 0 means
both expectations held; it does not count the old product failure as a pass.

For one installed CLI:

```powershell
$env:CANARY_TEST_CLI = '<absolute installed dist/main.js path>'
node --test --test-name-pattern='scoped failures' apps/cli/dist/test/onboarding.test.js
```

Saved packages, separate installs and gate output are under the author's local
`_canary-data/evidence/completion-repair-20260930/`. The test creates and removes
fresh fixtures under the OS temporary directory. Its completion hook is driven
by the instrument, not by a live Claude or Codex session.

## Final verification

Focused contracts passed 87/87. `npm test` passed: 1,313 tests, 1,309 passed,
0 failed, 4 skipped (471.9 seconds). The everyday vocabulary probe passed at
12 terms within its budget of 13. `npm run verify:productization` completed with
**104 PASS, 6 explicit SKIP, 0 FAIL** (exit 0). The skips comprise unavailable
Go/Rust toolchains, two genuine OS-PTY measurements and two live Claude runs
without an enforceable provider spending cap. The PTY probes executed their
product assertions with the existing in-process driver; that does not prove an
OS-PTY. No skipped probe counts as a pass. The gate's nested full suite also
passed with 1,309 passed, 0 failed and 4 skipped.

The source and packed architecture matrices passed 39/39 each, and all 13
Master-Pass mutations were caught. `git diff --check` passed. Product sources
were unchanged throughout these final runs. The result is a reviewable working
branch; merge and publication are separate.

This demonstrates a previously broken supported layout becoming usable and
preserves the distinction between a repair diagnostic and full proof. It does
not measure agent completion rates, token savings or general everyday efficacy.
