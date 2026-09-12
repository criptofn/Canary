'use strict';
/**
 * Display helpers for money. Amounts are carried as whole cents everywhere in this
 * project and only rendered as dollars at the edge.
 */

/** Renders whole cents as a dollar string: 1234 -> "$12.34". */
function formatCents(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) {
    throw new TypeError('formatCents expects a finite number of cents');
  }
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${remainder}`;
}

module.exports = { formatCents };
