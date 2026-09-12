'use strict';
/**
 * Money formatting.
 *
 * DOCUMENTED BEHAVIOUR (the task requires all of it to survive):
 *   formatMoney(123456)            -> '$1,234.56'
 *   formatMoney(0)                 -> '$0.00'
 *   formatMoney(-5)                -> '-$0.05'      (sign BEFORE the symbol)
 *   formatMoney(5, { symbol: '€' }) -> '€0.05'
 *   formatMoney(5, { decimals: 0 }) -> '$0'
 *   formatMoney(125, { round: 'up' }) -> '$1.25'    (125 cents is exact)
 *   formatMoney(1234, { grouping: false }) -> '$12.34'
 *
 * The amount is in CENTS and must be an integer.
 */
function formatMoney(cents, options = {}) {
  const { symbol = '$', decimals = 2, grouping = true, round = 'half-up' } = options;
  if (typeof cents !== 'number' || !Number.isFinite(cents)) {
    throw new TypeError('formatMoney expects a finite number of cents');
  }
  let value = cents;
  if (round === 'up') value = Math.ceil(value);
  else if (round === 'down') value = Math.floor(value);
  else value = Math.round(value);

  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;

  let wholeText = String(whole);
  if (grouping) wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracText = decimals === 0 ? '' : `.${String(frac).padStart(2, '0').slice(0, decimals)}`;
  return `${negative ? '-' : ''}${symbol}${wholeText}${fracText}`;
}

module.exports = { formatMoney };
