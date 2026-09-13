'use strict';
/** The known-good solution: all three stated requirements, in the order that matters. */

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return 'empty';
  return trimmed.toLowerCase();
}

module.exports = { normalize };
