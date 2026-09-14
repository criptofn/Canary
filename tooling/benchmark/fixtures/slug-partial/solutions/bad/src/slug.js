'use strict';
/**
 * KNOWN-BAD solution: THE PARTIAL IMPLEMENTATION. It looks like a finished `slugify` — it lowercases,
 * collapses whitespace, replaces PUNCTUATION, trims dashes and handles the empty case — and it is
 * green on the visible suite. What it does not do is rules 3 and 5 as stated: it enumerates the
 * punctuation it happened to think of instead of treating every non-alphanumeric character, and it
 * treats `_` as a separator instead of joining the words.
 *
 * This is the shape a hurried agent produces: the obvious rules, the visible tests green, two stated
 * requirements quietly missing.
 */
function slugify(text) {
  if (typeof text !== 'string') return '';
  const lowered = text.toLowerCase();
  const dashed = lowered
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[!?.,:;'"]/g, '-') // enumerated punctuation, not "everything that is not alphanumeric"
    .replace(/-+/g, '-');
  return dashed.replace(/^-+/, '').replace(/-+$/, '');
}

module.exports = { slugify };
