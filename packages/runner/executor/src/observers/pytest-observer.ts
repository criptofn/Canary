/**
 * The Canary PYTEST OBSERVER — the exact bytes Canary writes (byte-stable) into
 * its workspace and has pytest import as a plugin before any test runs.
 *
 * WHY (v1.1 Phase 2): pytest is the other half of the Python world, and it is not
 * observable the way `unittest` is. `unittest` is hooked through
 * `sitecustomize`/`TestResult`; pytest has a plugin API, so Canary injects a
 * plugin. Everything else — the frames, the protocol, the trust argument — is the
 * SAME channel as mocha, `unittest` and `node --test`, deliberately: one
 * observation vocabulary, four loaders.
 *
 * THE INJECTION POINT: `PYTEST_PLUGINS` (an environment value Canary computes)
 * plus the plugin's directory on `PYTHONPATH`. Both come from Canary's own
 * workspace — `sanitizedEnv` has no env-merge path (audit F9), and the variable
 * NAME is fixed by the injection kind, so no subject string can reach the child's
 * environment through this door. `-p` on argv was REJECTED as the primary
 * mechanism because plugin suppression (`-p no:<name>`) can also be written into a
 * project's `addopts`, so argv would be the weaker door of the two; the round
 * refuses an explicit `-p no:canary_pytest_observer` and a config-suppressed
 * observer simply produces no frames, which fails the round closed.
 *
 * WHAT MAKES THE OBSERVATION TRUSTWORTHY, and what does not
 * (`tooling/probes/pytest-observer-events.mjs` prints the raw hooks this rests on):
 *  1. Ground truth is `pytest_runtest_logstart` + the item's PHASE REPORTS
 *     TOGETHER. An item's outcome is decided once, at `teardown` — pytest's own
 *     per-item counting — so a report for an item whose start Canary never watched
 *     is REJECTED (`reject`), and printed or reported text cannot mint a count.
 *  2. The phase mapping is MEASURED, not assumed (pytest 9.1.1):
 *       pass    : setup passed, call passed, teardown passed
 *       fail    : call failed
 *       error   : setup failed   (pytest's `error` category; a failure for us)
 *       skip    : setup skipped, NO call report
 *       xfail   : call skipped with `wasxfail` set
 *       xpass   : call passed WITH `wasxfail` set — a pass in a strict sense but
 *                 NOT in pytest's summary (`# xpassed`), so it is `pending` here,
 *                 and a STRICT xpass arrives as call failed and is counted as one
 *     A failing teardown wins over a passing call, because pytest reports that
 *     item as an error and the text channel must agree with the frames.
 *  3. Every hook body is guarded; a broken hook emits one `adapter-error` frame and
 *     degrades silently. The observer must never change what the suite does.
 *  4. NO secret is injected, and the honest ceiling is the same as the `unittest`
 *     channel and HIGHER than the node one: pytest runs the tests in ITS OWN
 *     process, so subject code can write to fd 3 and emulate frames. Lifecycle
 *     pairing is what makes that visible (a forged pass with no watched start is a
 *     `reject`, and a forged bye disagrees with the recount) — not secrecy.
 *  5. fd 3 is closed exactly once, after `bye`.
 *
 * NOT SUPPORTED, stated rather than hoped: `pytest-xdist` runs items in worker
 * processes whose frames do not belong to this pipe, so an xdist run fails closed
 * (duplicate/absent frames) rather than being credited. Collection errors are
 * pytest's own `error` category at FILE level; Canary watched no item start, so the
 * frames cannot agree with the text and the round is INVALID — fail closed, never a
 * silent pass.
 *
 * The source is a template with no interpolated host data, so the bytes are
 * identical on every machine: a byte-compare in `ensurePytestObserver` is what
 * makes "the loaded bytes are Canary's" checkable at all.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { treeSha256 } from '@canary-rn/support';

/** Where the observer directory lives inside the workspace (outside artifacts). */
export const PYTEST_OBSERVER_DIRNAME = 'canary-pytest-observer';
export const PYTEST_OBSERVER_BASENAME = 'canary_pytest_observer.py';
/** The module name pytest is told to load — also what a suppression token names. */
export const PYTEST_PLUGIN_MODULE = 'canary_pytest_observer';

/** `hello.runner` for this channel. */
export const PYTEST_RUNNER_ID = 'pytest';

/** The directory Canary puts on the child's PYTHONPATH. */
export function pytestObserverDir(wsRoot: string): string {
  return path.join(wsRoot, PYTEST_OBSERVER_DIRNAME);
}

/** Write Canary's plugin bytes and prove the loaded bytes are Canary's. */
export function ensurePytestObserver(wsRoot: string): string {
  const dir = pytestObserverDir(wsRoot);
  const p = path.join(dir, PYTEST_OBSERVER_BASENAME);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.readFileSync(p, 'utf8') === PYTEST_OBSERVER_SOURCE) return dir;
  } catch { /* absent: write below */ }
  fs.writeFileSync(p, PYTEST_OBSERVER_SOURCE, 'utf8');
  if (fs.readFileSync(p, 'utf8') !== PYTEST_OBSERVER_SOURCE) {
    throw new Error(`pytest observer at ${p} does not match Canary's bytes even after rewrite (workspace is not writable-stable)`);
  }
  return dir;
}

/**
 * A pytest INSTALLATION's declared identity: the version it reports and a content
 * digest of its own installed source tree.
 *
 * The tree digest needs one rule that npm does not: Python writes `__pycache__`
 * bytecode next to its sources, and those files are regenerated per host and embed
 * mtimes, so they are EXCLUDED. What is hashed is the distribution's own source
 * files — stable for a given release, and changed by an edit to the installed
 * plugin/hook code, which is the property the pin is for.
 *
 * Returns null on any doubt (not installed, unparsable version): fail closed.
 */
export function pytestRunnerIdentity(pythonExe: string): { version: string; identitySha256: string } | null {
  try {
    const ver = spawnSync(pythonExe, ['-m', 'pytest', '--version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (ver.status !== 0) return null;
    const text = `${ver.stdout ?? ''}${ver.stderr ?? ''}`.trim();
    const m = /^pytest\s+(\d+\.\d+\.\d+[^\s]*)/m.exec(text);
    if (m === null) return null;
    const loc = spawnSync(pythonExe, ['-c', 'import os,pytest;print(os.path.dirname(pytest.__file__))'],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (loc.status !== 0) return null;
    const dir = (loc.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (dir === undefined || dir === '' || !fs.existsSync(dir)) return null;
    return { version: m[1]!, identitySha256: pytestTreeSha256(dir) };
  } catch {
    return null;
  }
}

/**
 * Content digest of a Python package directory, EXCLUDING bytecode caches.
 *
 * Deliberately a sibling of `treeSha256` rather than a change to it: npm packages
 * never contain `__pycache__`, and the npm rule (which throws on anything it does
 * not expect) must stay exactly as it was for mocha's pin.
 */
export function pytestTreeSha256(root: string): string {
  const files: Array<[string, string]> = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__pycache__' || e.name === '.pytest_cache') continue;
        walk(full, r);
      } else if (e.isSymbolicLink()) {
        throw new Error(`symlink in package tree: ${r}`);
      } else if (e.isFile()) {
        if (e.name.endsWith('.pyc') || e.name.endsWith('.pyo')) continue;
        files.push([r, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
      }
    }
  };
  walk(root, '');
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [rel, digest] of files) h.update(`${rel}\0${digest}\n`);
  return h.digest('hex');
}

/** True for the argv token that would SUPPRESS Canary's plugin. */
export function isPytestObserverSuppressionToken(tok: string): boolean {
  const i = tok.indexOf('no:');
  if (i === -1) return false;
  const named = tok.slice(i + 3).trim().toLowerCase();
  return named === PYTEST_PLUGIN_MODULE;
}

export const PYTEST_OBSERVER_SOURCE = `# Canary pytest observer plugin. See packages/runner/executor/src/observers/pytest-observer.ts
import atexit
import json
import os

OBSERVER_VERSION = "canary-observer-v1"
RUNNER_ID = "pytest"
_FD = 3
_open = True


def _frame(obj):
    global _open
    if not _open:
        return
    try:
        os.write(_FD, (json.dumps(obj, default=str) + "\\n").encode("utf-8"))
    except Exception:
        _open = False


def _close():
    global _open
    if _open:
        try:
            os.close(_FD)
        except Exception:
            pass
        _open = False


counts = {"pass": 0, "fail": 0, "pending": 0, "rejected": 0}
_started = set()
_decided = set()
_phases = {}
_hook_broken = False


def pytest_runtest_logstart(nodeid, location=None):
    try:
        _started.add(nodeid)
    except Exception:
        pass


def pytest_runtest_logreport(report):
    global _hook_broken
    try:
        nodeid = report.nodeid
        when = report.when
        if nodeid not in _started:
            # A report for an item whose start Canary never watched: reported, not
            # executed as far as the observation is concerned. Fail the round closed.
            counts["rejected"] += 1
            _frame({"k": "reject", "ev": "report", "id": nodeid, "reason": "no-run"})
            return
        _phases.setdefault(nodeid, {})[when] = {
            "outcome": report.outcome,
            "xfail": getattr(report, "wasxfail", None) is not None,
        }
        # teardown is the LAST phase pytest emits for an item (it fires even after a
        # setup failure or a skip), so the item's outcome is decided exactly once,
        # here, from all three phases.
        if when == "teardown":
            _decide(nodeid)
    except Exception:
        _hook_broken = True
        _frame({"k": "adapter-error", "err": "logreport hook failed"})


def _outcome(st):
    return st.get("outcome") if st else None


def _decide(nodeid):
    global _hook_broken
    try:
        if nodeid in _decided:
            return
        _decided.add(nodeid)
        st = _phases.pop(nodeid, {})
        setup, call, teardown = st.get("setup"), st.get("call"), st.get("teardown")
        # A failure anywhere wins: pytest reports an item with a failing teardown as
        # an error, and the text channel must agree with the frames.
        if "failed" in (_outcome(setup), _outcome(call), _outcome(teardown)):
            counts["fail"] += 1
            _frame({"k": "fail", "id": nodeid, "hook": False})
        elif (_outcome(setup) == "skipped" or _outcome(call) == "skipped"
              or (call and call["xfail"]) or (setup and setup["xfail"])):
            # skipped, xfailed, and NON-STRICT xpassed all sit outside pytest's own
            # "passed" count, so they are pending here too. A STRICT xpass arrives as
            # call failed and was counted as a failure above.
            counts["pending"] += 1
            _frame({"k": "pending", "id": nodeid})
        elif _outcome(call) == "passed":
            counts["pass"] += 1
            _frame({"k": "pass", "id": nodeid})
        elif _outcome(setup) == "passed":
            counts["rejected"] += 1
            _frame({"k": "reject", "ev": "pass", "id": nodeid, "reason": "no-call"})
        else:
            counts["rejected"] += 1
            _frame({"k": "reject", "ev": "pass", "id": nodeid, "reason": "no-outcome"})
    except Exception:
        _hook_broken = True
        _frame({"k": "adapter-error", "err": "decide failed"})


def pytest_sessionfinish(session, exitstatus):
    try:
        if not _hook_broken:
            _frame({"k": "bye", "counts": counts})
    except Exception:
        pass


@atexit.register
def _atexit_close():
    _close()


try:
    import sys
    _py = "%d.%d.%d" % (sys.version_info[0], sys.version_info[1], sys.version_info[2])
    try:
        import pytest as _pytest
        _pv = getattr(_pytest, "__version__", "")
    except Exception:
        _pv = ""
    _frame({
        "k": "hello",
        "runner": RUNNER_ID,
        "runnerVersion": _pv,
        "pytestVersion": _pv,
        "pythonVersion": _py,
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "nonce": os.environ.get("CANARY_OBSERVER_NONCE", ""),
        "observerVersion": OBSERVER_VERSION,
        "node": "python-" + _py,
    })
except Exception:
    _hook_broken = True
    _frame({"k": "adapter-error", "err": "observer install failed"})
`;
