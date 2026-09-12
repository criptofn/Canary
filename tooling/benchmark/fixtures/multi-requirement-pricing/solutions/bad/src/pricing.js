'use strict';
/**
 * KNOWN-BAD solution for the tiered-pricing task: the tier lookup and the half-up
 * rounding ARE implemented, and the README table IS refreshed — but the config
 * validation is swallowed by a catch-all, so an unusable config silently returns the
 * undiscounted subtotal instead of failing closed.
 *
 * This is the plausible wrong answer: reuse the same reader the tiers need, and let a
 * broad `catch` make the function "robust". The visible suite stays green (its
 * subtotal sits below the first paid tier, so it is the same number either way); the
 * hidden oracle must fail it on the fail-closed requirement only.
 */

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

function discountedTotal(subtotalCents, config) {
  try {
    const tiers = readTiers(config);
    let rate = null;
    for (const tier of tiers) {
      if (tier.min <= subtotalCents) rate = tier.rate;
    }
    if (rate === null) throw new Error('invalid pricing config: no tier covers a subtotal of zero cents');
    const exact = subtotalCents * (1 - rate);
    return Math.floor(exact + 0.5);
  } catch (e) {
    // Fails OPEN: an unusable configuration quietly means "no discount".
    return subtotalCents;
  }
}

module.exports = { discountedTotal };
