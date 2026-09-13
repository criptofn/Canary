'use strict';
/** KNOWN-GOOD solution: the exit-code contract, with rejections on stderr. */
const path = require('node:path');
const { loadConfig, validate } = require('./config.js');

const USAGE = [
  'usage: configcheck --config <path> [--strict]',
  '',
  '  --config <path>  the JSON config file to validate',
  '  --strict         treat warnings as errors',
].join('\n');

function run(argv, io) {
  let configPath = null;
  let strict = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      configPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--help' || arg === '-h') {
      io.log(USAGE);
      return 0;
    } else {
      io.error(`error: unknown argument "${arg}"`);
      io.error(USAGE);
      return 3;
    }
  }

  if (configPath === null) {
    io.error('error: --config is required');
    io.error(USAGE);
    return 3;
  }

  const loaded = loadConfig(configPath);
  if (loaded.fatal !== undefined) {
    io.error(`error: ${loaded.fatal}`);
    return 3;
  }

  const { errors, warnings } = validate(loaded.config, { strict });
  const name = path.basename(configPath);
  if (errors.length > 0) {
    for (const error of errors) io.error(`error: ${error}`);
    return 2;
  }
  io.log(`config ${name}: ok`);
  for (const warning of warnings) io.log(`warning: ${warning}`);
  return 0;
}

module.exports = { run };
