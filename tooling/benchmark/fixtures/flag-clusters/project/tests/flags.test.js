'use strict';
/**
 * VISIBLE suite for `parseFlags`.
 *
 * NOTE, for the benchmark: this suite covers the SINGLE-flag forms the base implementation already
 * handles. The task states the combined-short-flag rule in prose, and nothing here exercises it —
 * which is the ordinary situation a daily user creates, and exactly the gap the task is about.
 */
const assert = require('node:assert');
const { parseFlags } = require('../src/flags.js');

module.exports = {
  'a single long flag with = stores the string value': () => {
    assert.deepStrictEqual(parseFlags(['--name=value']), { name: 'value' });
  },
  'a long flag takes the following non-flag argument as its value': () => {
    assert.deepStrictEqual(parseFlags(['--name', 'value']), { name: 'value' });
  },
  'a lone long flag is true': () => {
    assert.deepStrictEqual(parseFlags(['--force']), { force: true });
  },
  'a single short flag is true': () => {
    assert.deepStrictEqual(parseFlags(['-a']), { a: true });
  },
  'an unknown long option throws and names the option': () => {
    assert.throws(() => parseFlags(['--nope']), /nope/);
  },
  'a short flag keeps its name with an = value': () => {
    assert.deepStrictEqual(parseFlags(['-a=b']), { a: 'b' });
  },
};
