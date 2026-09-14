'use strict';
/**
 * VISIBLE suite for `parseDuration`. It checks the WELL-FORMED inputs only, so the habitual
 * implementation passes it.
 *
 * NOTE, for the benchmark: the task also states that anything not well-formed must throw. Nothing
 * here exercises that, which is the gap the hidden oracle fills.
 */
const assert = require('node:assert');
const { parseDuration } = require('../src/duration.js');

module.exports = {
  'minutes only': () => {
    assert.strictEqual(parseDuration('90m'), 90);
  },
  'hours only': () => {
    assert.strictEqual(parseDuration('2h'), 120);
  },
  'hours and minutes': () => {
    assert.strictEqual(parseDuration('1h30m'), 90);
  },
};
