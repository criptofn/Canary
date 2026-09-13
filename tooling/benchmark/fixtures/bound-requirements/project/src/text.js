'use strict';
/**
 * The text helper under test. Three stated requirements apply to it, and each one has its OWN check
 * in `checks/` — declared in `canary.project.json` and bound to the requirement's digest there, so
 * Canary's sealed plan proves each requirement by that check's exit code.
 *
 * Today it returns the input unchanged: none of the three requirements is implemented, and the
 * visible suite (which exercises only the identity case) is green anyway.
 */

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text);
}

module.exports = { normalize };
