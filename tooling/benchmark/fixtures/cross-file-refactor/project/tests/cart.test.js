'use strict';
const assert = require('node:assert');
const { Cart } = require('../src/cart.js');

// The current behaviour only: items are recorded and the default total is US dollars.
module.exports = {
  'a new cart has no items': () => {
    assert.deepStrictEqual(new Cart().items(), []);
  },
  'added items are listed': () => {
    const cart = new Cart();
    cart.add('book', 1250);
    assert.deepStrictEqual(cart.items(), [{ name: 'book', priceCents: 1250 }]);
  },
  'the total sums the line items and is formatted': () => {
    const cart = new Cart();
    cart.add('book', 1250);
    cart.add('pen', 250);
    assert.strictEqual(cart.total(), '$15.00');
  },
};
