'use strict';
const assert = require('node:assert');
const { aggregate } = require('../src/aggregate.js');

// NOTE, for the benchmark: these inputs are deliberately SMALL. A quadratic
// implementation satisfies every case here, so a green suite says nothing about
// how the function behaves on a large one.
module.exports = {
  'groups by first appearance and sums numeric values': () => {
    assert.deepStrictEqual(
      aggregate([
        { region: 'north', value: 3 },
        { region: 'south', value: 1 },
        { region: 'north', value: 4 },
      ], 'region'),
      [
        { key: 'north', count: 2, sum: 7 },
        { key: 'south', count: 1, sum: 1 },
      ],
    );
  },
  'a row with no usable field is skipped': () => {
    assert.deepStrictEqual(
      aggregate([
        { region: 'north', value: 1 },
        { region: null, value: 1 },
        { region: 7, value: 1 },
        { value: 1 },
      ], 'region'),
      [{ key: 'north', count: 1, sum: 1 }],
    );
  },
  'a non-numeric value still counts but adds nothing': () => {
    assert.deepStrictEqual(
      aggregate([
        { region: 'north', value: 2 },
        { region: 'north' },
        { region: 'north', value: '9' },
        { region: 'north', value: NaN },
      ], 'region'),
      [{ key: 'north', count: 4, sum: 2 }],
    );
  },
  'an empty result for no rows': () => {
    assert.deepStrictEqual(aggregate([], 'region'), []);
  },
};
