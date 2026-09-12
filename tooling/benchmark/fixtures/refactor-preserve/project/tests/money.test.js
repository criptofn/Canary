'use strict';
const assert = require('node:assert');
const { formatMoney } = require('../src/money.js');

// NOTE, for the benchmark: the visible suite covers the ORDINARY cases. The documented
// edge behaviour (negative sign placement, zero decimals, grouping off, custom symbol,
// rounding modes) is what the hidden oracle checks for preservation.
module.exports = {
  'formats a plain amount': () => {
    assert.strictEqual(formatMoney(123456), '$1,234.56');
  },
  'formats zero': () => {
    assert.strictEqual(formatMoney(0), '$0.00');
  },
  'rejects a non-number': () => {
    assert.throws(() => formatMoney('12'), TypeError);
  },
};
