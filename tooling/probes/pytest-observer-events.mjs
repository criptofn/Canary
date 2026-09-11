#!/usr/bin/env node
/**
 * MEASUREMENT — what pytest actually gives an injected plugin, and what its text
 * says. Run BEFORE any product code depends on either.
 *
 * Two questions, both answered by execution:
 *  1. Which pluggy hooks fire per test item, with which report fields — enough to
 *     pair a START with an OUTCOME (that pairing is what stops printed text from
 *     minting counts), and to see how skip / xfail / xpass / error are expressed.
 *  2. What the ordinary text output looks like (headline counts, short summary,
 *     exit codes) both plain and `-q`, because the frames are checked AGAINST it.
 *
 * Prints the raw evidence; exits 0 unless pytest could not be run at all.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PY = process.env.CANARY_PYTEST_PYTHON ?? path.resolve(import.meta.dirname, '..', '..', '_toolchains', 'py', 'Scripts', 'python.exe');
if (!fs.existsSync(PY)) {
  console.log(`pytest interpreter not found at ${PY}`);
  console.log('set CANARY_PYTEST_PYTHON, or create it: python -m venv _toolchains/py && _toolchains/py/Scripts/python -m pip install pytest');
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pytest-events-'));
const project = path.join(TMP, 'project');
fs.mkdirSync(path.join(project, 'tests'), { recursive: true });

fs.writeFileSync(path.join(project, 'tests', 'test_sample.py'), [
  'import pytest',
  '',
  '',
  'def test_passes():',
  '    assert 1 == 1',
  '',
  '',
  'def test_also_passes():',
  '    assert 2 == 2',
  '',
  '',
  'def test_fails():',
  '    assert 1 == 2',
  '',
  '',
  '@pytest.mark.skip(reason="not today")',
  'def test_skipped():',
  '    pass',
  '',
  '',
  '@pytest.mark.xfail(reason="known bad")',
  'def test_xfails():',
  '    assert False',
  '',
  '',
  '@pytest.mark.xfail(reason="surprisingly fine")',
  'def test_xpasses():',
  '    assert True',
  '',
  '',
  '@pytest.fixture',
  'def broken():',
  '    raise RuntimeError("fixture blew up")',
  '',
  '',
  'def test_errors_in_fixture(broken):',
  '    pass',
  '',
  '',
  'class TestNested:',
  '    def test_nested_pass(self):',
  '        assert True',
  '',
  '    def test_nested_fail(self):',
  '        assert "a" == "b"',
  '',
  '',
  '@pytest.mark.parametrize("n", [1, 2])',
  'def test_parametrized(n):',
  '    assert n > 0',
  '',
].join('\n'));

const LOG = path.join(TMP, 'hooks.jsonl');
fs.writeFileSync(path.join(project, 'measure_plugin.py'), [
  'import json',
  'import os',
  '',
  'LOG = ' + JSON.stringify(LOG),
  '',
  '',
  'def _rec(kind, **kw):',
  '    with open(LOG, "a", encoding="utf-8") as fh:',
  '        fh.write(json.dumps({"hook": kind, **kw}, default=str) + "\\n")',
  '',
  '',
  'def pytest_runtest_logstart(nodeid, location):',
  '    _rec("logstart", nodeid=nodeid, location=list(location))',
  '',
  '',
  'def pytest_runtest_logreport(report):',
  '    _rec("logreport", nodeid=report.nodeid, when=report.when, outcome=report.outcome,',
  '         passed=bool(report.passed), failed=bool(report.failed), skipped=bool(report.skipped),',
  '         wasxfail=getattr(report, "wasxfail", None),',
  '         longrepr_type=type(report.longrepr).__name__,',
  '         has_sections=bool(getattr(report, "sections", None)),',
  '         keywords=sorted(report.keywords) if hasattr(report, "keywords") else None)',
  '',
  '',
  'def pytest_collection_modifyitems(session, config, items):',
  '    _rec("collected", nodeids=[i.nodeid for i in items])',
  '',
  '',
  'def pytest_sessionfinish(session, exitstatus):',
  '    _rec("sessionfinish", exitstatus=int(exitstatus))',
  '',
].join('\n'));

function run(args, label) {
  const r = spawnSync(PY, ['-m', 'pytest', ...args], {
    cwd: project, encoding: 'utf8', timeout: 180_000, windowsHide: true,
    env: { ...process.env, PYTHONPATH: project, PYTEST_PLUGINS: 'measure_plugin' },
  });
  console.log(`\n=== pytest ${label}: exit ${r.status} ===`);
  console.log(`--- stdout ---\n${(r.stdout ?? '').split('\n').map((l) => `  |${l}`).join('\n')}`);
  if ((r.stderr ?? '').trim() !== '') console.log(`--- stderr ---\n${(r.stderr ?? '').split('\n').map((l) => `  |${l}`).join('\n')}`);
  return r;
}

console.log(`python: ${PY}`);
const ver = spawnSync(PY, ['-m', 'pytest', '--version'], { encoding: 'utf8', windowsHide: true });
console.log(`pytest: ${(ver.stdout ?? '').trim()} (status ${ver.status})`);

// 1. plain run WITH the measuring plugin (hooks + text together).
run([], 'plain');
const hooks = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`\n--- ${hooks.length} hook calls, in order ---`);
console.log('  hook       when      outcome   nodeid                                      flags');
for (const h of hooks) {
  if (h.hook === 'logreport') {
    const flags = [h.wasxfail !== null ? `wasxfail=${JSON.stringify(h.wasxfail)}` : '', h.longrepr_type !== 'NoneType' ? `longrepr=${h.longrepr_type}` : ''].filter(Boolean).join(' ');
    console.log(`  logreport  ${String(h.when).padEnd(9)} ${String(h.outcome).padEnd(9)} ${String(h.nodeid).padEnd(43)} ${flags}`);
  } else if (h.hook === 'logstart') {
    console.log(`  logstart   ${''.padEnd(9)} ${''.padEnd(9)} ${String(h.nodeid).padEnd(43)} loc=${JSON.stringify(h.location)}`);
  } else {
    console.log(`  ${String(h.hook).padEnd(10)} ${JSON.stringify(h).slice(0, 120)}`);
  }
}
fs.rmSync(LOG, { force: true });

// 2. the same run in quiet mode, and with no plugin at all, to see what the TEXT
//    channel looks like in each form Canary might meet.
run(['-q'], 'quiet mode (with plugin)');
fs.rmSync(LOG, { force: true });
run(['-p', 'no:measure_plugin'], 'no measuring plugin');

console.log(`\nscratch: ${TMP}`);
if (process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
