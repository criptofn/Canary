'use strict';
/**
 * THE HIDDEN ORACLE for configcheck — the PROCESS-level contract.
 *
 * It runs the project's real entry point as a real child process and asserts the three facts a
 * unit test cannot see: the exit code, stdout, and stderr. The visible suite covers only the
 * accepting path, so a candidate that implements validation but keeps reporting success — or
 * reports the rejection on the wrong stream — is green there and fails here.
 *
 * Usage: node check.cjs <projectDir>
 *
 * Every internal process is spawned with FILE-DESCRIPTOR stdio rather than pipes: a confined
 * host refuses piped stdio (measured: EPERM) while the file-descriptor shape works, so the
 * oracle measures the same three facts everywhere instead of failing for an environment reason.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDir = process.argv[2];
if (projectDir === undefined) {
  console.error('usage: node check.cjs <projectDir>');
  process.exit(2);
}

const CLI = path.join(projectDir, 'bin', 'configcheck.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'configcheck-oracle-'));

/**
 * Run the CLI and capture everything. `{ missing: true }` writes no file at all.
 * @returns {{ code: number|null, stdout: string, stderr: string, spawnError: string|null }}
 */
function cli(args, configContents) {
  let configPath = args.config;
  if (configContents !== undefined) {
    configPath = path.join(tmp, `config-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(configPath, configContents);
  } else if (args.missing === true) {
    configPath = path.join(tmp, 'definitely-not-here.json');
  }
  const argv = [];
  if (configPath !== null && configPath !== undefined) argv.push('--config', configPath);
  if (args.strict === true) argv.push('--strict');
  if (args.extra !== undefined) argv.push(args.extra);
  if (args.noConfig === true) argv.length = 0;

  const outPath = path.join(tmp, 'stdout.txt');
  const errPath = path.join(tmp, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [CLI, ...argv], {
      cwd: projectDir,
      stdio: ['ignore', outFd, errFd],
      timeout: 30_000,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  return {
    code: result.status ?? null,
    stdout: read(outPath),
    stderr: read(errPath),
    spawnError: result.error ? (result.error.code ?? String(result.error)) : null,
  };
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([name, true, '']);
  } catch (e) {
    checks.push([name, false, e && e.message ? e.message : String(e)]);
  }
}
const assert = (condition, message) => {
  if (condition !== true) throw new Error(message);
};
/** `error:` lines on stderr, as the contract specifies them. */
const errorLines = (run) => run.stderr.split(/\r?\n/).filter((l) => /^error: /.test(l));

const VALID = JSON.stringify({ name: 'api', port: 3000, mode: 'dev' });

// --- the accepting side (also covered by the visible suite) --------------------------------
check('a valid config exits 0 with the ok line and a silent stderr', () => {
  const run = cli({ config: null }, VALID);
  assert(run.spawnError === null, `the CLI could not be started: ${String(run.spawnError)}`);
  assert(run.code === 0, `expected exit 0, got ${String(run.code)}`);
  assert(/config .*\.json: ok/.test(run.stdout), `stdout was ${JSON.stringify(run.stdout)}`);
  assert(run.stderr.trim() === '', `stderr must be empty, was ${JSON.stringify(run.stderr)}`);
});
check('--help exits 0 and prints the usage block on stdout', () => {
  const run = cli({ extra: '--help' });
  assert(run.code === 0, `expected exit 0, got ${String(run.code)}`);
  assert(/usage: configcheck/.test(run.stdout), `stdout was ${JSON.stringify(run.stdout)}`);
});

// --- the rejecting side: exit 2, errors on stderr, NOTHING on stdout -----------------------
// Every entry here is a config FILE that EXISTS and fails validation, so the contract's exit 2
// applies. (A file that is missing or not valid JSON is exit 3 — checked separately below.)
const REJECTED = [
  ['a missing name', { name: '', port: 3000, mode: 'dev' }, 'name'],
  ['a name of the wrong type', { name: 7, port: 3000, mode: 'dev' }, 'name'],
  ['a port that is not an integer', { name: 'api', port: 3000.5, mode: 'dev' }, 'port'],
  ['a port below the range', { name: 'api', port: 80, mode: 'dev' }, 'port'],
  ['a port above the range', { name: 'api', port: 70000, mode: 'dev' }, 'port'],
  ['a port of the wrong type', { name: 'api', port: '3000', mode: 'dev' }, 'port'],
  ['an unknown mode', { name: 'api', port: 3000, mode: 'staging' }, 'mode'],
  ['a missing mode', { name: 'api', port: 3000 }, 'mode'],
];
for (const [label, config, field] of REJECTED) {
  check(`rejects ${label} with exit 2, an error on stderr, and nothing on stdout`, () => {
    const run = cli({ config: null }, JSON.stringify(config));
    assert(run.code === 2, `expected exit 2, got ${String(run.code)}`);
    assert(run.stdout.trim() === '', `stdout must be empty on a rejection, was ${JSON.stringify(run.stdout)}`);
    const errors = errorLines(run);
    assert(errors.length > 0, `expected "error: ..." lines on stderr, got ${JSON.stringify(run.stderr)}`);
    assert(
      errors.some((line) => line.toLowerCase().includes(field.toLowerCase())),
      `an error line should name the field "${field}"; stderr was ${JSON.stringify(run.stderr)}`,
    );
  });
}

// --- a file that cannot be used at all is exit 3, not a validation rejection ---------------
const FATAL = [
  ['a config file that is not a JSON object', '[1,2,3]'],
  ['a config file that is not valid JSON', '{oops'],
  ['an empty config file', ''],
];
for (const [label, contents] of FATAL) {
  check(`treats ${label} as fatal: exit 3, an error on stderr, nothing on stdout`, () => {
    const run = cli({ config: null }, contents);
    assert(run.code === 3, `expected exit 3, got ${String(run.code)}`);
    assert(run.stdout.trim() === '', `stdout must be empty, was ${JSON.stringify(run.stdout)}`);
    assert(errorLines(run).length > 0, `expected an "error: ..." line, got ${JSON.stringify(run.stderr)}`);
  });
}

// --- warnings, and --strict escalating them ------------------------------------------------
const WARNING = JSON.stringify({ name: 'api', port: 8080, mode: 'dev' });
check('a warned config (not --strict) exits 0 with ok plus the warning on stdout', () => {
  const run = cli({ config: null }, WARNING);
  assert(run.code === 0, `expected exit 0, got ${String(run.code)}`);
  assert(/config .*\.json: ok/.test(run.stdout), `stdout was ${JSON.stringify(run.stdout)}`);
  assert(/^warning: /m.test(run.stdout), `expected a "warning: " line on stdout, got ${JSON.stringify(run.stdout)}`);
  assert(run.stderr.trim() === '', `stderr must be empty, was ${JSON.stringify(run.stderr)}`);
});
check('the same warned config with --strict exits 2 with an error on stderr', () => {
  const run = cli({ config: null, strict: true }, WARNING);
  assert(run.code === 2, `expected exit 2, got ${String(run.code)}`);
  assert(errorLines(run).length > 0, `expected "error: ..." lines, got ${JSON.stringify(run.stderr)}`);
  assert(run.stdout.trim() === '', `stdout must be empty, was ${JSON.stringify(run.stdout)}`);
});
check('--strict moves warnings to errors rather than losing them', () => {
  const warned = cli({ config: null }, WARNING);
  const strict = cli({ config: null, strict: true }, WARNING);
  const count = (text, kind) => (text.match(new RegExp(`^${kind}: `, 'gm')) ?? []).length;
  const total = (run) => count(run.stdout, 'warning') + count(run.stderr, 'error');
  assert(total(warned) === total(strict), `total findings differ: ${total(warned)} vs ${total(strict)}`);
});

// --- unreadable / missing file, and misuse -------------------------------------------------
check('a missing config file exits 3 with an error and nothing on stdout', () => {
  const run = cli({ config: null, missing: true });
  assert(run.code === 3, `expected exit 3, got ${String(run.code)}`);
  assert(errorLines(run).length > 0, `expected an error line, got ${JSON.stringify(run.stderr)}`);
  assert(run.stdout.trim() === '', `stdout must be empty, was ${JSON.stringify(run.stdout)}`);
});
check('an unknown argument exits 3 and prints the usage block', () => {
  const run = cli({ config: null }, VALID);
  const unknown = cli({ config: null, extra: '--wat', missing: false }, VALID);
  assert(run.code === 0, 'the control run with no extra argument should still pass');
  assert(unknown.code === 3, `expected exit 3, got ${String(unknown.code)}`);
  assert(/usage: configcheck/.test(unknown.stderr), `stderr was ${JSON.stringify(unknown.stderr)}`);
});
check('a missing --config exits 3 and prints the usage block', () => {
  const run = cli({ noConfig: true });
  assert(run.code === 3, `expected exit 3, got ${String(run.code)}`);
  assert(/usage: configcheck/.test(run.stderr), `stderr was ${JSON.stringify(run.stderr)}`);
});

// --- report --------------------------------------------------------------------------------
let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
