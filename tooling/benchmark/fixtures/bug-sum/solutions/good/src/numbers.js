'use strict';
/** KNOWN-GOOD solution: every value is summed, so all documented behaviour holds. */
function total(values) {
  return values.reduce((sum, v) => sum + v, 0);
}

function average(values) {
  if (values.length === 0) return 0;
  return total(values) / values.length;
}

function largest(values) {
  if (values.length === 0) return null;
  return Math.max(...values);
}

module.exports = { total, average, largest };
