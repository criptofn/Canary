'use strict';
const assert = require('node:assert');
const { formatMoney } = require('../src/money.js');

// The current behaviour only: a dollar amount, two decimals, `$` prefix.
module.exports = {
  'a whole number of dollars is rendered with two decimals': () => {
    assert.strictEqual(formatMoney(13), '$13.00');
  },
  'cents are rendered as two decimals': () => {
    assert.strictEqual(formatMoney(12.35), '$12.35');
  },
  'a zero amount is rendered as $0.00': () => {
    assert.strictEqual(formatMoney(0), '$0.00');
  },
};
