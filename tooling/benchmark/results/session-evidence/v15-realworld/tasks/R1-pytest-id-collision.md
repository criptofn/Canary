`src/verify/failure-ids.ts` extracts the ids the tests gate uses to compute the failure DELTA between the baseline run and the changed-shadow run. `addPytestIds` truncates a pytest node id at the first ` - ` occurrence, and the file's comment concludes that this is safe because "the truncation is identical across runs so the delta comparison still holds".

That conclusion is wrong for one case: two DIFFERENT parametrized node ids that share everything before a ` - ` — for example `tests/test_x.py::test_p[a - b]` and `tests/test_x.py::test_p[a - c]` — truncate to the same id. A failure newly introduced in one of them then collides with a pre-existing failure in the other, the id set already contains it, and the gate's new-failure delta never sees the regression. That contradicts the module's stated doctrine: "Parse gaps never make the gate lenient."

Fix the extraction so distinct pytest node ids never collapse into one another, while keeping every id stable across runs (the gate compares ids between two runs of the same failing test). The vitest path and the public signature must stay as they are.

Add a vitest test under `tests/unit/verify/` that fails before your change and passes after.
