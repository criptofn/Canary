'use strict';
/**
 * VISIBLE suite for `slugify`. It covers rules 1 and 2 only — lowering and whitespace — so it is
 * GREEN on the base implementation.
 *
 * NOTE, for the benchmark: the task states six rules; this suite exercises two. The rest are prose,
 * which is the ordinary situation a daily user creates and the reason the hidden oracle exists.
 */
const assert = require('node:assert');
const { slugify } = require('../src/slug.js');

module.exports = {
  'lowercases the input': () => {
    assert.strictEqual(slugify('Hello World'), 'hello-world');
  },
  'collapses a run of whitespace to one dash': () => {
    assert.strictEqual(slugify('a   b'), 'a-b');
  },
};
