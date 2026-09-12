'use strict';
const assert = require('node:assert');
const { validateEmail, normalizeEmail } = require('../src/validate.js');

// NOTE, for the benchmark: this suite covers the happy path and the empty case only.
// The task states the remaining rules in prose, which is the ordinary situation a
// daily user creates — and the hidden oracle checks the rules the suite does not.
module.exports = {
  'a valid address is accepted': () => {
    assert.deepStrictEqual(validateEmail('someone@example.com'), { ok: true, reason: '' });
  },
  'an empty value is rejected as required': () => {
    assert.deepStrictEqual(validateEmail(''), { ok: false, reason: 'required' });
  },
  'normalizeEmail trims and lowercases': () => {
    assert.strictEqual(normalizeEmail('  SomeOne@Example.COM '), 'someone@example.com');
  },
};
