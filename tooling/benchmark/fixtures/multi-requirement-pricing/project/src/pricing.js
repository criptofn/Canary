'use strict';
/**
 * Pricing helpers.
 *
 * `discountedTotal(subtotalCents, config)` currently returns the subtotal untouched:
 * the tier lookup and the discount itself are the task.
 *
 * The contract it must keep:
 *   discountedTotal(subtotalCents, config) -> whole number of cents
 *   config is the parsed contents of config/pricing.json:
 *     { tiers: [ { min: <cents>, rate: <fraction> }, ... ] }
 */
function discountedTotal(subtotalCents, config) {
  return subtotalCents;
}

module.exports = { discountedTotal };
