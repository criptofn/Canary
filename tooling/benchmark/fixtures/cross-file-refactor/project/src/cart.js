'use strict';
const { formatMoney } = require('./money.js');

/** A cart of named line items priced in whole cents. */
class Cart {
  constructor() {
    this.lines = [];
  }

  add(name, priceCents) {
    this.lines.push({ name, priceCents });
    return this;
  }

  items() {
    return this.lines.map((line) => ({ ...line }));
  }

  total() {
    const cents = this.lines.reduce((sum, line) => sum + line.priceCents, 0);
    return formatMoney(cents / 100);
  }
}

module.exports = { Cart };
