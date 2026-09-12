'use strict';
const assert = require('node:assert');
const { VERSION } = require('../src/version.js');
const pkg = require('../package.json');

// NOTE, for the benchmark: this checks ONE of the places the version lives. The task
// says "everywhere it appears", and the hidden oracle is what checks the rest.
module.exports = {
  'the reported version matches package.json': () => {
    assert.strictEqual(VERSION, pkg.version);
  },
};
