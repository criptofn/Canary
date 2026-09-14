'use strict';
/** KNOWN-GOOD solution: half rounds away from zero, for both signs. */
function roundHalfUp(value) {
  if (!Number.isFinite(value)) return value;
  return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

module.exports = { roundHalfUp };
