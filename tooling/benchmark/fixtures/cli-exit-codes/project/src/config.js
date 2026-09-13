'use strict';
/**
 * Config loading and validation.
 *
 * `loadConfig` is DONE and is not the task: it reads the file and returns a result object.
 * `validate` is where the stated rules live — see README.md for the exact contract.
 */

/** Read and parse a config file. Returns `{ config }` or `{ fatal }`; it never throws. */
function loadConfig(filePath) {
  const fs = require('node:fs');
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { fatal: `cannot read ${filePath}: ${e && e.code ? e.code : e}` };
  }
  try {
    const config = JSON.parse(text);
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { fatal: 'the config file must contain a JSON object' };
    }
    return { config };
  } catch (e) {
    return { fatal: `the config file is not valid JSON: ${e && e.message ? e.message : e}` };
  }
}

/**
 * Validate a config object.
 * @returns {{ errors: string[], warnings: string[] }} each entry is `"<field>: <reason>"`
 */
function validate(_config, _options = {}) {
  // TODO: the stated rules are in README.md.
  return { errors: [], warnings: [] };
}

module.exports = { loadConfig, validate };
