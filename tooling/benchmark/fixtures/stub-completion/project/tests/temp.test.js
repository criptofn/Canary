'use strict';
/**
 * VISIBLE suite for `celsiusToFahrenheit`. It checks the freezing and boiling points only — the two
 * temperatures everybody reaches for — so the stub passes it.
 *
 * NOTE, for the benchmark: this suite is green while the function is NOT implemented. Only the hidden
 * oracle, which uses other inputs, can see the difference.
 */
const assert = require('node:assert');
const { celsiusToFahrenheit } = require('../src/temp.js');

module.exports = {
  'water freezes at 32': () => {
    assert.strictEqual(celsiusToFahrenheit(0), 32);
  },
  'water boils at 212': () => {
    assert.strictEqual(celsiusToFahrenheit(100), 212);
  },
};
