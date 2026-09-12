'use strict';
/** The US-dollar helper now routes through the currency-aware formatter. */
const { format } = require('./currency.js');

/** @deprecated use `format(amount, 'USD')` */
function formatMoney(amount) {
  return format(amount, 'USD');
}

module.exports = { formatMoney };
