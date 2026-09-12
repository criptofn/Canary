'use strict';
const { format } = require('./currency.js');

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

  total(currency = 'USD') {
    const cents = this.lines.reduce((sum, line) => sum + line.priceCents, 0);
    return format(cents / 100, currency);
  }
}

module.exports = { Cart };
