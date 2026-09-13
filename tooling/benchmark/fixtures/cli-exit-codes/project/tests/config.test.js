'use strict';
/**
 * VISIBLE unit tests for `loadConfig` and `validate`.
 *
 * These call the library directly, in-process. They assert the RESULT SHAPE only: nothing here
 * runs the process, so nothing here can see an exit code or a stream. That is the ordinary
 * situation — a unit suite that is green while the program's behaviour is wrong.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, validate } = require('../src/config.js');

function writeTemp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'configcheck-unit-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, text);
  return file;
}

module.exports = {
  'loadConfig returns the parsed object for a valid file': () => {
    const result = loadConfig(writeTemp('{"name":"api","port":3000,"mode":"dev"}'));
    assert.deepStrictEqual(result, { config: { name: 'api', port: 3000, mode: 'dev' } });
  },
  'loadConfig reports malformed JSON as fatal instead of throwing': () => {
    const result = loadConfig(writeTemp('{not json'));
    assert.ok(result.fatal !== undefined, 'a malformed file must produce a fatal result');
    assert.strictEqual(result.config, undefined);
  },
  'validate returns errors and warnings arrays': () => {
    const result = validate({ name: 'api', port: 3000, mode: 'dev' });
    assert.ok(Array.isArray(result.errors), 'errors must be an array');
    assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
  },
};
