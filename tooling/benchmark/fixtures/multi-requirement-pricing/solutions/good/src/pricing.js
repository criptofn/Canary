'use strict';
/**
 * KNOWN-GOOD solution for the tiered-pricing task: the rate comes from the tier with
 * the highest `min` at or below the subtotal, the result is rounded half-up to whole
 * cents, and an unusable config throws instead of quietly returning full price.
 */

/** Validates the tier table and returns it. Throws on anything unusable. */
function readTiers(config) {
  if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('invalid pricing config: expected an object with a "tiers" array');
  }
  const { tiers } = config;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('invalid pricing config: "tiers" must be a non-empty array');
  }
  let previousMin = null;
  tiers.forEach((tier, index) => {
    if (tier === null || typeof tier !== 'object' || Array.isArray(tier)) {
      throw new Error(`invalid pricing config: tier ${index} is not an object`);
    }
    if (typeof tier.min !== 'number' || !Number.isFinite(tier.min) || tier.min < 0) {
      throw new Error(`invalid pricing config: tier ${index} needs a numeric, non-negative "min"`);
    }
    if (typeof tier.rate !== 'number' || !Number.isFinite(tier.rate) || tier.rate < 0 || tier.rate >= 1) {
      throw new Error(`invalid pricing config: tier ${index} needs a "rate" between 0 and 1`);
    }
    if (previousMin !== null && tier.min <= previousMin) {
      throw new Error(`invalid pricing config: tier ${index} starts at ${tier.min}, which does not come after ${previousMin}; the tier list must strictly increase`);
    }
    previousMin = tier.min;
  });
  return tiers;
}

/** The rate of the tier with the highest `min` that is at or below the subtotal. */
function rateFor(subtotalCents, config) {
  const tiers = readTiers(config);
  let rate = null;
  for (const tier of tiers) {
    if (tier.min <= subtotalCents) rate = tier.rate;
  }
  if (rate === null) {
    throw new Error('invalid pricing config: no tier covers a subtotal of zero cents');
  }
  return rate;
}

function discountedTotal(subtotalCents, config) {
  const rate = rateFor(subtotalCents, config);
  const exact = subtotalCents * (1 - rate);
  // Half-up: a result ending in exactly .5 always rounds up, never to even.
  return Math.floor(exact + 0.5);
}

module.exports = { discountedTotal };
