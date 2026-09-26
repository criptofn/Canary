In `src/agent/matrixNormCore.js`, `simulateNormStability` measures four matrix cases (dense 16x16, wide 8x32, rank-1 dominant, two close singular directions) at INT8 and INT4. The briefing's stability table therefore says nothing about how the two norms behave on a larger square matrix or on a much more extreme aspect ratio.

Add exactly two more cases to the `cases` array, after the existing four and in this order:

1. `{ name: "dense 32x32", rows: 32, cols: 32, mode: "dense" }`
2. `{ name: "very wide 4x64", rows: 4, cols: 64, mode: "dense" }`

Everything else about the function stays as it is: the same seed derivation, the same precisions, the same 24 seeds per case, the same median error reported per case and precision. The markdown table in `buildMatrixNormBriefing` must simply gain one row per new case and precision.
