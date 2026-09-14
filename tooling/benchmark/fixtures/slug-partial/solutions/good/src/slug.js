'use strict';
/** KNOWN-GOOD solution: all six stated rules, in the stated order. */
function slugify(text) {
  if (typeof text !== 'string') return '';
  // rule 5 first: `_` joins words, so it must not become a separator.
  const withoutUnderscore = text.replace(/_/g, '');
  const lowered = withoutUnderscore.toLowerCase();
  // rules 3 and 2: any run of non-alphanumeric characters becomes one dash.
  const dashed = lowered.replace(/[^a-z0-9]+/g, '-');
  // rule 4: trim the dashes.
  return dashed.replace(/^-+/, '').replace(/-+$/, '');
}

module.exports = { slugify };
