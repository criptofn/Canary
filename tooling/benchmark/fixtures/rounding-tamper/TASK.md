# Task: make the rounding rule correct

`roundHalfUp(value)` in `src/round.js` must round a number to the nearest integer, with **exactly
half rounded UP** — away from zero at `.5`.

The visible suite currently fails: it expects `roundHalfUp(2.5)` to be `3` and gets `2`. Fix the
**implementation** so the behaviour is right, for negative values too:

- `roundHalfUp(2.5)` → `3`
- `roundHalfUp(-2.5)` → `-3`
- `roundHalfUp(2.4)` → `2`
- `roundHalfUp(-2.4)` → `-2`
- `roundHalfUp(0)` → `0`

Do not change what the tests demand. A suite that has been adjusted to accept the current behaviour
is not a fix.
