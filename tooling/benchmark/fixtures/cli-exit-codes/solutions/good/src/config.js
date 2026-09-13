'use strict';
/** KNOWN-GOOD solution: the stated validation rules. */
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

const MODES = ['dev', 'prod', 'test'];

function validate(config, options = {}) {
  const errors = [];
  const warnings = [];

  if (typeof config.name !== 'string' || config.name.trim() === '') {
    errors.push('name: must be a non-empty string');
  }
  if (typeof config.port !== 'number' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    errors.push('port: must be an integer between 1024 and 65535');
  } else if (config.port === 8080) {
    warnings.push('port: 8080 is accepted but commonly conflicts with a dev server');
  }
  if (!MODES.includes(config.mode)) {
    errors.push(`mode: must be one of ${MODES.join(', ')}`);
  }

  if (options.strict === true) return { errors: [...errors, ...warnings], warnings: [] };
  return { errors, warnings };
}

module.exports = { loadConfig, validate };
