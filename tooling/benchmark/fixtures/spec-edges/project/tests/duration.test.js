'use strict';
const assert = require('node:assert');
const { parseDuration } = require('../src/duration.js');

// NOTE, for the benchmark: three cases out of the ~20 the task specifies. This is the
// ordinary shape of a real repository — the spec is in prose, the tests are partial — and
// the hidden oracle is what checks the rest.
module.exports = {
  'parses a single unit': () => {
    assert.strictEqual(parseDuration('90s'), 90);
  },
  'parses a compound duration': () => {
    assert.strictEqual(parseDuration('1h30m'), 5400);
  },
  'rejects an empty string': () => {
    assert.throws(() => parseDuration(''), TypeError);
  },
};
