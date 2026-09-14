'use strict';
/**
 * KNOWN-BAD solution: THE HABITUAL IMPLEMENTATION. It is not a strawman — it is what a competent
 * engineer writes when the visible tests only show well-formed inputs: find the hours group, find the
 * minutes group, add them up.
 *
 * It passes every check the repository contains and violates the stated rule, because the task's whole
 * point is that anything not well-formed must THROW:
 *   - "1h30"  -> 60   (the trailing number is silently ignored instead of rejected)
 *   - "90"    -> 0    (a bare number is accepted instead of rejected)
 *   - "1x"    -> 60   (a letter that is not a unit is silently ignored)
 *   - "m90"   -> 90   (a unit before its number is accepted)
 */
function parseDuration(text) {
  if (typeof text !== 'string') throw new Error('invalid duration');
  const hours = /(\d+)h/.exec(text);
  const minutes = /(\d+)m/.exec(text);
  return (hours ? parseInt(hours[1], 10) * 60 : 0) + (minutes ? parseInt(minutes[1], 10) : 0);
}

module.exports = { parseDuration };
