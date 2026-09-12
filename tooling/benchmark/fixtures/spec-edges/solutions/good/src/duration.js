'use strict';
/** KNOWN-GOOD solution for the duration spec: every stated rule, in the stated order. */
const PER_UNIT = { d: 86400, h: 3600, m: 60, s: 1 };
const ORDER = ['d', 'h', 'm', 's'];

function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('duration must be a string');
  const trimmed = text.trim();
  if (trimmed === '') throw new TypeError('duration must not be empty');

  const re = /^(\d+)([dhms])(?:\s*(\d+)([dhms]))*$/i;
  if (!re.test(trimmed)) throw new TypeError(`not a duration: ${text}`);

  // Walk the parts explicitly so ordering, repetition and inner spacing are all enforced.
  let total = 0;
  let lastOrder = -1;
  const seen = new Set();
  const partRe = /(\d+)([dhms])/gi;
  let m;
  let consumed = 0;
  while ((m = partRe.exec(trimmed)) !== null) {
    const unit = m[2].toLowerCase();
    const order = ORDER.indexOf(unit);
    if (order <= lastOrder) throw new TypeError(`not a duration (unit order): ${text}`);
    if (seen.has(unit)) throw new TypeError(`not a duration (repeated unit): ${text}`);
    seen.add(unit);
    lastOrder = order;
    total += Number(m[1]) * PER_UNIT[unit];
    consumed += m[0].length;
  }
  // Everything between and around the parts must be whitespace only.
  const leftovers = trimmed.replace(/(\d+)([dhms])/gi, '').trim();
  if (leftovers !== '' || consumed === 0) throw new TypeError(`not a duration: ${text}`);
  return total;
}

module.exports = { parseDuration };
