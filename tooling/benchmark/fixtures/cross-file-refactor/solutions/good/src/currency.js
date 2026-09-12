'use strict';
/**
 * Currency-aware money formatting.
 *
 * The table is explicit on purpose: a currency's symbol and its number of minor
 * units per major unit are declared here, not inferred from the host locale.
 */
const CURRENCIES = {
  USD: { symbol: '$', minorUnits: 100 },
  EUR: { symbol: '\u20ac', minorUnits: 100 },
  GBP: { symbol: '\u00a3', minorUnits: 100 },
};

/**
 * Render a decimal amount as a string for the given currency, e.g.
 * `format(12.35, 'EUR')` -> `€12.35`.
 */
function format(amount, currency = 'USD') {
  const entry = CURRENCIES[currency];
  if (entry === undefined) throw new Error(`unknown currency: ${currency}`);
  return `${entry.symbol}${Number(amount).toFixed(2)}`;
}

module.exports = { format, CURRENCIES };
