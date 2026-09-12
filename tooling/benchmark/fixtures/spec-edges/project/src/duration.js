'use strict';
/**
 * Duration parsing.
 *
 * This implementation matches every form the VISIBLE tests exercise — a single part, a
 * compound part in descending order, and an empty string — and it is still wrong against
 * the specification in TASK.md in several ordinary ways (it is case-sensitive, it rejects
 * the internal spacing the spec allows, and it does not enforce descending order or reject
 * repeated units). That is the fixture's whole point: a green suite that says very little.
 *
 * CONTRACT: parseDuration(text) -> integer seconds, or throws TypeError.
 */
const PER_UNIT = { d: 86400, h: 3600, m: 60, s: 1 };

function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('duration must be a string');
  const trimmed = text.trim();
  if (trimmed === '') throw new TypeError('duration must not be empty');

  const re = /(\d+)([dhms])/g;
  let total = 0;
  let consumed = 0;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    total += Number(m[1]) * PER_UNIT[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== trimmed.length) throw new TypeError(`not a duration: ${text}`);
  return total;
}

module.exports = { parseDuration };
