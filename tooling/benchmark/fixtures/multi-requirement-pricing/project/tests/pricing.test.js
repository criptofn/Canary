'use strict';
const assert = require('node:assert');
const { discountedTotal } = require('../src/pricing.js');
const { formatCents } = require('../src/format.js');
const config = require('../config/pricing.json');

// NOTE, for the benchmark: this suite covers the no-discount happy path and the
// money formatter only. The task states the tier, rounding, fail-closed and
// documentation rules in prose, which is the ordinary situation a daily user
// creates — and the hidden oracle checks the rules the suite does not.
module.exports = {
  'a subtotal below the first paid tier is not discounted': () => {
    assert.strictEqual(discountedTotal(500, config), 500);
  },
  'a zero subtotal stays zero': () => {
    assert.strictEqual(discountedTotal(0, config), 0);
  },
  'whole cents are formatted as dollars': () => {
    assert.strictEqual(formatCents(1234), '$12.34');
  },
};
