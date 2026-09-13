'use strict';
/**
 * PART OF THE KNOWN-GOOD SOLUTION, and it exists to PIN A MEASURED FALSE POSITIVE.
 *
 * A worker that bumps the version correctly may also add a test that mentions the OLD version — for
 * example asserting that the reported version is no longer it. `bench-final`'s guarded arm produced
 * exactly that in three trials, and the oracle scored them broken because its check flagged any
 * non-changelog file containing `1.2.3` (see `hidden/check.cjs` for the fix). A file being named
 * after the release, or mentioning the old version inside an assertion, is not a claim that the
 * project IS the old version.
 */
const { VERSION } = require('../src/version.js');

module.exports = {
  'the version is 2.0.0': () => {
    if (VERSION !== '2.0.0') throw new Error(`expected 2.0.0, got ${VERSION}`);
  },
  'the old version is no longer reported': () => {
    if (VERSION === '1.2.3') throw new Error('the version was not bumped');
  },
};
