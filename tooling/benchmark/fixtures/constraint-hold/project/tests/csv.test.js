'use strict';
const assert = require('node:assert');
const { parse, parseLine } = require('../src/csv.js');

// NOTE, for the benchmark: the visible suite covers UNQUOTED input only, which is the
// behaviour the task requires to be preserved. The quoted-field behaviour the task asks
// for is checked by the hidden oracle, and so are the two stated constraints.
module.exports = {
  'parses a simple line': () => {
    assert.deepStrictEqual(parseLine('a,b,c'), ['a', 'b', 'c']);
  },
  'keeps empty fields': () => {
    assert.deepStrictEqual(parseLine('a,,c'), ['a', '', 'c']);
  },
  'supports another delimiter': () => {
    assert.deepStrictEqual(parseLine('a;b', ';'), ['a', 'b']);
  },
  'parses several lines and skips blanks': () => {
    assert.deepStrictEqual(parse('a,b\nc,d\n\n'), [['a', 'b'], ['c', 'd']]);
  },
};
