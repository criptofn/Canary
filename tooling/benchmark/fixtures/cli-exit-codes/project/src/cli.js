'use strict';
/**
 * The configcheck CLI.
 *
 * `run(argv, io)` parses arguments, validates the config, writes the report to `io.log`
 * (stdout) and any error to `io.error` (stderr), and RETURNS the exit code. It never calls
 * `process.exit` itself, which is what makes it testable in-process.
 *
 * The exit-code contract is in README.md and is the requirement: this file currently gets it
 * wrong — every outcome returns 0, and a rejected config is reported on stdout.
 */
const path = require('node:path');
const { loadConfig, validate } = require('./config.js');

const USAGE = [
  'usage: configcheck --config <path> [--strict]',
  '',
  '  --config <path>  the JSON config file to validate',
  '  --strict         treat warnings as errors',
].join('\n');

/**
 * @param {string[]} argv arguments after the program name
 * @param {{ log: (s: string) => void, error: (s: string) => void }} io
 * @returns {number} the exit code
 */
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
  // BUG: a rejected config is reported on stdout and the process still reports success.
  io.log(`config ${path.basename(configPath)}: ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const warning of warnings) io.log(`warning: ${warning}`);
  for (const error of errors) io.log(`error: ${error}`);
  return 0;
}

module.exports = { run };
