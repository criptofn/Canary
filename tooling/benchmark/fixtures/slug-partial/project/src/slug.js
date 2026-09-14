'use strict';
/**
 * Slug helpers.
 *
 * `slugify` currently implements rules 1 and 2 and a first attempt at 4. The remaining stated rules
 * are the task. The contract `README.md` documents:
 *
 *   slugify(text) -> string
 */
function slugify(text) {
  if (typeof text !== 'string') return '';
  const lowered = text.toLowerCase();
  const spaced = lowered.trim().replace(/\s+/g, '-');
  return spaced;
}

module.exports = { slugify };
