/**
 * 1.1 §14 — a REAL Python project, verified by a REAL Python interpreter, with
 * no Node project anywhere in it.
 *
 * The other ecosystem tests use fixtures; this one runs the whole journey for
 * real: a directory with only a pyproject.toml and a unittest suite, `setup`
 * discovering the check from the its own manifest, the interpreter PINNED to an
 * absolute path, the plan executed by that interpreter, and `doctor`
 * re-verifying. If no Python is available, the test SKIPS rather than passing —
 * a skip is visible coverage loss, never a green.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-')); // 1.1 P0 isolation

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-python-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const canary = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8', timeout: 180_000 });

/** Is a real `python` runnable here? Probed, never assumed. */
function pythonRuns(): boolean {
  const exe = process.platform === 'win32' ? 'python.exe' : 'python';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const abs = path.join(d, exe);
    if (!fs.existsSync(abs)) continue;
    const r = spawnSync(abs, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status === 0) return true;
  }
  return false;
}

describe('1.1 ecosystems: a real Python project, no Node in it', () => {
  it('setup discovers the declared check, pins the interpreter, and doctor re-verifies READY', (t) => {
    if (!pythonRuns()) {
      t.skip('no runnable python on PATH — the real-interpreter journey cannot be executed here');
      return;
    }
    const root = path.join(TMP, 'pyproj');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', '__init__.py'), '');
    fs.writeFileSync(path.join(root, 'tests', 'test_app.py'), [
      'import unittest',
      '',
      'class AppTests(unittest.TestCase):',
      '    def test_arithmetic_still_works(self):',
      '        self.assertEqual(1 + 1, 2)',
      '',
    ].join('\n'));
    // No package.json, no pytest declaration: a real test LAYOUT is the only
    // thing that justifies `python -m unittest discover`.
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "pyproj"\nversion = "0.1.0"\nrequires-python = ">=3.8"\n');

    const setup = canary(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `setup failed:\n${setup.stdout}\n${setup.stderr}`);
    assert.match(setup.stdout, /READY/);

    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8')) as {
      pm: string; plan: Array<{ kind: string; script: string; adapter?: string; argv?: string[] }>;
    };
    assert.equal(cfg.plan.length, 1);
    const step = cfg.plan[0]!;
    assert.equal(step.adapter, 'python');
    assert.equal(step.script, 'unittest');
    assert.equal(step.kind, 'tests');
    assert.deepEqual(step.argv!.slice(1), ['-m', 'unittest', 'discover', '-v']);
    assert.ok(path.isAbsolute(step.argv![0]!), `the interpreter must be sealed as an absolute path, got ${step.argv![0]}`);
    assert.ok(fs.existsSync(step.argv![0]!), 'the sealed interpreter must still exist');

    const doctor = canary(['doctor', '--json', root]);
    assert.equal(doctor.status, 0, `doctor failed:\n${doctor.stdout}\n${doctor.stderr}`);
    const env = JSON.parse(doctor.stdout) as { status: string; checks: Array<{ adapter: string; script: string }>; security: { level: string } };
    assert.equal(env.status, 'READY');
    assert.deepEqual(env.checks, [{ kind: 'tests', script: 'unittest', adapter: 'python', scope: '', argv: step.argv }]);
    assert.equal(env.security.level, 'LOCAL');

    // The authority is sealed OUTSIDE the repo, and the repo needs no Node file.
    assert.equal(fs.existsSync(path.join(root, 'package.json')), false, 'this project must stay Node-free');
  });
});
