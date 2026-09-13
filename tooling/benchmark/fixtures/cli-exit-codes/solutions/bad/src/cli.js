'use strict';
/**
 * KNOWN-BAD solution: the plausible wrong answer. The rules and the exit codes are right — a
 * hurried implementation stops there, because the failure mode it can see is "the command
 * reports success on a bad config", and both of those are fixed. The errors were never removed
 * from stdout, so a user or a script parsing the documented contract still gets nothing on
 * stderr and a rejection reported on the wrong stream.
 */
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
    // BUG: exit code fixed, stream not — the errors still go to stdout.
    io.log(`config ${name}: ${errors.length} error(s)`);
    for (const error of errors) io.log(`error: ${error}`);
    return 2;
  }
  io.log(`config ${name}: ok`);
  for (const warning of warnings) io.log(`warning: ${warning}`);
  return 0;
}

module.exports = { run };
