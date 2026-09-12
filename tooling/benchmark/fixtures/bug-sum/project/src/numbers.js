'use strict';
/**
 * Number helpers used across the project.
 *
 * `total` is meant to add up the numbers it is given. It currently SKIPS negative
 * values, which is the defect this fixture's task is about.
 */
function total(values) {
  let sum = 0;
  for (const v of values) {
    if (v > 0) sum += v;
  }
  return sum;
}

/** Average of the values; returns 0 for an empty list. */
function average(values) {
  if (values.length === 0) return 0;
  return total(values) / values.length;
}

/** Largest value, or null for an empty list. */
function largest(values) {
  if (values.length === 0) return null;
  return Math.max(...values);
}

module.exports = { total, average, largest };
