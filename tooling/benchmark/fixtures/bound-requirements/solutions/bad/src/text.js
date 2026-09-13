'use strict';
/**
 * The plausible WRONG solution: it trims and it lower-cases, but it never handles the empty case —
 * the requirement that a hurried reader skips because the visible suite cannot see it. The visible
 * suite stays green; requirement 2's own check fails.
 */

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text).trim().toLowerCase();
}

module.exports = { normalize };
