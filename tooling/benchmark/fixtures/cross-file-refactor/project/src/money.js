'use strict';
/**
 * Money formatting. `formatMoney` is the original public helper: it renders a
 * US-dollar amount as a string with a `$` prefix and exactly two decimals.
 */
function formatMoney(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

module.exports = { formatMoney };
