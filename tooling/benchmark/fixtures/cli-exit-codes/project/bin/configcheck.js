#!/usr/bin/env node
'use strict';
/** Thin process wrapper: the real work is in `src/cli.js` so it can be tested in-process. */
const { run } = require('../src/cli.js');

process.exit(run(process.argv.slice(2), {
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
}));
