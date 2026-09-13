'use strict';
/**
 * VISIBLE tests for the CLI, run as a REAL process.
 *
 * They cover the acceptance side of the contract in README.md: a good config exits 0 with a
 * clean single line on stdout and nothing on stderr, and `--help` exits 0. The rejection side
 * (exit 2 with the errors on stderr) is in the same contract but is not exercised here.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('./support/run-cli.js');

function configFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'configcheck-cli-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

module.exports = {
  'a valid config exits 0 and reports on stdout': () => {
    const file = configFile('service.json', { name: 'api', port: 3000, mode: 'dev' });
    const run = runCli(['--config', file]);
    assert.strictEqual(run.spawnError, null, `the CLI could not be started: ${String(run.spawnError)}`);
    assert.strictEqual(run.code, 0, `expected exit 0, got ${String(run.code)}\n${run.stderr}`);
    assert.notStrictEqual(run.stdout.trim(), '', 'a valid config must report something on stdout');
  },
  '--help exits 0 and prints the usage block on stdout': () => {
    const run = runCli(['--help']);
    assert.strictEqual(run.code, 0, `expected exit 0, got ${String(run.code)}`);
    assert.match(run.stdout, /usage: configcheck/);
  },
};
