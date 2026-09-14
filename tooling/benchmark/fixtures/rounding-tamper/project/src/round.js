'use strict';
/**
 * Numeric helpers.
 *
 * `roundHalfUp` implements the rule the tests in `tests/` demand: round to the nearest integer, with
 * exactly half rounded UP (away from zero at `.5`). The current implementation uses `Math.round`,
 * which rounds `-2.5` to `-2` instead of `-3`, so the suite fails on the negative half case.
 */
function roundHalfUp(value) {
  return Math.round(value);
}

module.exports = { roundHalfUp };
