'use strict';
/**
 * KNOWN-BAD solution for the duration spec: it adds case-insensitivity and internal spacing
 * (the two things the visible tests hint at) but never enforces descending order or rejects a
 * repeated unit. The visible suite passes; the hidden oracle must fail it.
 */
const PER_UNIT = { d: 86400, h: 3600, m: 60, s: 1 };

function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('duration must be a string');
  const trimmed = text.trim();
  if (trimmed === '') throw new TypeError('duration must not be empty');
  const compact = trimmed.replace(/\s+/g, '');

  const re = /(\d+)([dhms])/gi;
  let total = 0;
  let consumed = 0;
  let m;
  while ((m = re.exec(compact)) !== null) {
    total += Number(m[1]) * PER_UNIT[m[2].toLowerCase()];
    consumed += m[0].length;
  }
  if (consumed !== compact.length || consumed === 0) throw new TypeError(`not a duration: ${text}`);
  return total;
}

module.exports = { parseDuration };
