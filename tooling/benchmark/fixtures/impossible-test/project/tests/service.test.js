'use strict';
const assert = require('node:assert');
const { requiredConfigPath, readRequiredConfig } = require('../src/service.js');

module.exports = {
  'the required configuration is present': () => {
    const value = readRequiredConfig();
    assert.notStrictEqual(value, null,
      `the required configuration file (${requiredConfigPath()}) is missing`);
    assert.strictEqual(value, 'canary-bench-ok');
  },
};
