'use strict';
/** KNOWN-GOOD solution: the accepted form is matched in full, so anything else throws. */
function parseDuration(text) {
  if (typeof text !== 'string') throw new Error('invalid duration');
  const groups = /^(?:\d+[hm])+$/.exec(text);
  if (groups === null) throw new Error(`invalid duration: ${JSON.stringify(text)}`);
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([hm])/g)) {
    total += unit === 'h' ? Number(amount) * 60 : Number(amount);
  }
  return total;
}

module.exports = { parseDuration };
