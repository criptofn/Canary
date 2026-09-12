'use strict';
/**
 * KNOWN-BAD solution for the currency task: the currency table and `format` exist, the
 * cart is currency-aware, and the visible suite stays green — but the compatibility
 * contract is broken in three ways:
 *   - `format` accepts only a number amount, so every numeric string formats as `$NaN`
 *     (and `formatMoney` inherited the regression through the alias);
 *   - an unknown currency silently falls back to `$` instead of throwing.
 * The visible tests exercise numbers and USD only, so none of this shows up there.
 */
const CURRENCIES = {
  USD: { symbol: '$' },
  EUR: { symbol: '\u20ac' },
  GBP: { symbol: '\u00a3' },
};

function format(amount, currency = 'USD') {
  const entry = CURRENCIES[currency] ?? CURRENCIES.USD;
  return `${entry.symbol}${amount.toFixed(2)}`;
}

module.exports = { format, CURRENCIES };
