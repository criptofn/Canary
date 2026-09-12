'use strict';
const { totalCents } = require('../src/calc.js');

module.exports = {
  'empty order totals zero': () => {
    if (totalCents([]) !== 0) throw new Error(`expected 0, got ${totalCents([])}`);
  },
  'two items sum in whole cents': () => {
    const items = [{ sku: 'a', price: 1250, quantity: 2 }, { sku: 'b', price: 499, quantity: 3 }];
    const got = totalCents(items);
    if (got !== 3997) throw new Error(`expected 3997, got ${got}`);
  },
  'a single item is its price times its quantity': () => {
    const got = totalCents([{ sku: 'x', price: 10, quantity: 3 }]);
    if (got !== 30) throw new Error(`expected 30, got ${got}`);
  },
};
