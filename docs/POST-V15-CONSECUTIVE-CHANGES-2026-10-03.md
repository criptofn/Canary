# Consecutive changes: an earlier regression must not certify new work

## Observed defect

This is a Canary defect reproduced in a temporary, minimal Git repository, not
a repair to Hermes or schniedelsmp. The first task fixes leading whitespace and
adds a test. `doctor --json` correctly reports READY; that change is committed.
The second task requests trailing whitespace handling. Its implementation still
only handles leading whitespace, and no trailing whitespace assertion exists.
Canary nevertheless reports READY and `regression-evidence: met`: the earlier
assertion still fails against the original setup commit.

The test independently loads the second implementation and observes that the
requested trailing whitespace behavior is absent. Requirements are not added to
the frozen plan or retroactively inferred by a language model.

Raw evidence is under `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/`:

- `consecutive-changes-20261003-red-final.log`: real CLI READY/exit 0 where the
  regression expects NOT PROVEN/exit 2; one failing test.
- `consecutive-changes-20261003-green.log`: the initial corrected counter passes;
  one test passed, none failed or skipped.
- `consecutive-changes-20261003-controls.log`: expanded regression and existing
  discrimination suite: 16 passed, none failed or skipped. Later changes need
  their own observed reporter result.
- `consecutive-changes-20261003-final-controls.log`: the final expanded counter
  additionally commits the correct repair and a later documentation change;
  one passed, none failed or skipped.

SHA-256 of these three raw logs respectively:

```text
8d1152b93944ef307e5f85ec30c69c3a21d163a470087c504d0b8c18ff9a3b3c
0706c779b84e908494ac2968f44b09dd4cc90d7e4a912dd11309e0f2c30605e9
55f28071f6865f55c5304e47417eaa2ebc0977b04b34e53e501077667ce76daa
```

## Correction

The shared discrimination path retains the mandatory sealed-base comparison.
Only after that comparison establishes sensitivity does it also check the latest
product delta:

1. Pending product edits are compared to HEAD.
2. Otherwise, find the latest product commit along first parents and compare to
   its preceding commit. Later check/documentation commits do not hide it.
3. The additional comparison uses the same sealed commands, check overlays,
   infrastructure classification and candidate input control.
4. Passing on the additional base means NOT PROVEN. An unavailable comparison
   also remains unproven. It never overrides a failed original comparison.

No plan or baseline is resealed, no task command is required for this extra
check, and no saved result is consumed as proof. Existing statuses, JSON schema,
worker-origin caveats and LOCAL same-user limitations remain in force. The
unproven message names the additional reference commit.

## Countercases and limits

The expanded regression checks pending and committed uncovered work, a subsequent
documentation commit, doctor and Stop (including the loop guard), and a real
repair with a trailing whitespace assertion that must regain READY while
retaining worker-origin disclosure.

This checks the latest product delta; it is not per-requirement semantic coverage
or proof of every historical commit. A later covered feature may mask an earlier
uncovered feature. Independent requirement checks and human review still matter.
First-parent merge comparison describes the merge delta, not every side-branch
commit. These limits are not removed by a green regression.

There is an additional comparison run when HEAD has advanced beyond the sealed
base. This change improves refusal of stale evidence; it does not establish a
runtime or token saving, and it does not by itself establish an 8/10 product.

Full unit and productization gates for this correction remain required after
integration. The concurrently running primary-worktree gate is for commit
`d4c34d5`, which does not contain this correction.
