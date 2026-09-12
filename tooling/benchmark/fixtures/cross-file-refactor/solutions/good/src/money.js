'use strict';
/**
 * Money formatting. `formatMoney` remains the public US-dollar helper; it is now a
 * thin deprecated alias over the currency-aware formatter.
 */
const { format } = require('./currency.js');

/** @deprecated use `format(amount, 'USD')` */
function formatMoney(amount) {
  return format(amount, 'USD');
}

module.exports = { formatMoney };
