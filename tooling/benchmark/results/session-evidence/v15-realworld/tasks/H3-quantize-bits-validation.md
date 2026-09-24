In `src/agent/matrixNormCore.js`, `quantizeSymmetric(a, bits)` silently returns a matrix of `NaN` for `bits < 2`:

```js
const qmax = 2 ** (bits - 1) - 1;          // 0 when bits === 1
const scale = maxAbs > 0 ? maxAbs / qmax : 1;   // Infinity
return a.map((row) => row.map((x) => ... * scale));  // 0 * Infinity === NaN
```

A NaN matrix then flows into `frobenius`/`spectralPower` and every comparison against it is meaningless.

Reject an out-of-range bit width instead of returning NaNs: `quantizeSymmetric` must throw a `TypeError` unless `bits` is an integer in the inclusive range 2..16. `simulateNormStability` only ever calls it with 4 and 8, so its results must not change.
