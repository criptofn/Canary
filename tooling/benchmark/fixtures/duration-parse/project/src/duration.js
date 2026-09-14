'use strict';
/**
 * Duration parsing.
 *
 * `parseDuration` must accept ONLY well-formed durations — a sequence of `<number><unit>` groups, in
 * which every character belongs to a group — and return the total in minutes. Anything else throws.
 *
 * What is here now is the HABITUAL implementation: a loose regex that finds "90m" or "2h" anywhere in
 * the string and adds up what it finds. It silently accepts inputs the stated form does not allow
 * (`"90"` reads as 0 minutes, `"1h30"` ignores the trailing number, `"1x"` ignores the trailing unit),
 * which is exactly the shape this task is about.
 */
function parseDuration(text) {
  if (typeof text !== 'string') throw new Error('invalid duration');
  const hours = /(\d+)h/.exec(text);
  const minutes = /(\d+)m/.exec(text);
  return (hours ? parseInt(hours[1], 10) * 60 : 0) + (minutes ? parseInt(minutes[1], 10) : 0);
}

module.exports = { parseDuration };
