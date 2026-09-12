'use strict';
const assert = require('node:assert');
const { total, average, largest } = require('../src/numbers.js');

module.exports = {
  'total adds positive values': () => {
    assert.strictEqual(total([1, 2, 3]), 6);
  },
  'total includes negative values': () => {
    assert.strictEqual(total([-5, 2, 3]), 0);
  },
  'average uses every value': () => {
    assert.strictEqual(average([-2, 4]), 1);
  },
  'largest of an empty list is null': () => {
    assert.strictEqual(largest([]), null);
  },
};
