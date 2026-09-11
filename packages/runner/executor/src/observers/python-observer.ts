/**
 * The Canary PYTHON OBSERVER — the exact bytes Canary writes (byte-stable) into
 * its workspace and makes the interpreter import before any project code runs.
 *
 * WHY (v1.1 Phase 2): the strong-label contract was structurally "pinned mocha".
 * Every non-Node ecosystem could therefore never earn PASS / CONFIRMED_REGRESSION
 * / FLAKY / PRE_EXISTING_FAILURE, because a strong label requires a VALID
 * execution observation and there was no channel to observe one with. This file
 * gives Python one, using the same protocol and the same trust reasoning as
 * `observer-preload.ts` (the mocha channel) so there is ONE observation
 * vocabulary rather than two.
 *
 * THE INJECTION POINT: `sitecustomize`. CPython's `site` module imports a module
 * named `sitecustomize` at interpreter startup, before the command line runs and
 * therefore before any test module is imported. Canary owns it by putting a
 * directory containing these bytes on the child's `PYTHONPATH` — an environment
 * value Canary computes from its own workspace, never anything a subject
 * supplies (`sanitizedEnv` has no env-merge path, deliberately: audit F9).
 *
 * WHAT MAKES THE OBSERVATION TRUSTWORTHY, and what does not:
 *  1. Lifecycle ground truth is `TestResult.startTest` + `addSuccess`/`addFailure`
 *     TOGETHER: a success reported for a test whose `startTest` Canary never
 *     watched is REJECTED (`reject` frame, which fails the round closed). Printing
 *     or reporting is not execution.
 *  2. Every hook body is guarded, and a broken hook emits exactly one
 *     `adapter-error` frame and then degrades silently. The observer must never
 *     change what the suite does.
 *  3. `hello` carries pid, parent pid, interpreter version, observerVersion and
 *     the per-round nonce Canary put in the child's observer environment. WHY NOT
 *     PID ALONE: on Windows a virtualenv's `python.exe` re-executes the base
 *     interpreter as a CHILD, so `os.getpid()` is legitimately not the pid Node
 *     spawned — a strict pid equality check would make every venv round INVALID.
 *     The binding is therefore "nonce matches AND (pid OR ppid is the spawned
 *     process)": the nonce proves the frames came from THIS spawn's process tree,
 *     which is the property the pid check was for. The nonce is not a secret (a
 *     process can read its own environment) and is not claimed to be one; the
 *     in-process-emulation ceiling is unchanged and documented below.
 *  4. NO secret is injected. The honest ceiling is the same as mocha's: code
 *     running inside the observed process can emulate these frames. What is
 *     structurally dead is certifying execution from TEXT ALONE — the exact
 *     counterexample this whole subsystem exists because of
 *     (`node -e "console.log('128 passing (1s)')"`).
 *  5. fd 3 is closed exactly once, on interpreter exit, after `bye` is written.
 *
 * The source is kept as a template with no interpolated host data so the bytes
 * are identical on every machine: a byte-compare in `ensurePythonObserver` is
 * what makes "the loaded bytes are Canary's" checkable at all.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OBSERVER_VERSION } from '../observation.js';

/** Where the observer directory lives inside the workspace (outside artifacts). */
export const PYTHON_OBSERVER_DIRNAME = 'canary-python-observer';
export const PYTHON_OBSERVER_BASENAME = 'sitecustomize.py';

/** The directory Canary puts on the child's PYTHONPATH. */
export function pythonObserverDir(wsRoot: string): string {
  return path.join(wsRoot, PYTHON_OBSERVER_DIRNAME);
}

/**
 * Write Canary's observer bytes and prove the loaded bytes are Canary's.
 *
 * The SAME two-point pinning the mocha preload uses (`ensureObserverPreload`):
 * here, before spawn, write-if-different plus a read-back byte comparison; inside
 * the child, `hello.observerVersion` self-reports and the validator pins it. A
 * subject that rewrites the file under the workspace gets it rewritten fresh
 * immediately before the round, and a persistent mismatch throws (fail closed)
 * rather than observing with bytes nobody reviewed.
 */
export function ensurePythonObserver(wsRoot: string): string {
  const dir = pythonObserverDir(wsRoot);
  const p = path.join(dir, PYTHON_OBSERVER_BASENAME);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.readFileSync(p, 'utf8') === PYTHON_OBSERVER_SOURCE) return dir;
  } catch { /* absent: write below */ }
  fs.writeFileSync(p, PYTHON_OBSERVER_SOURCE, 'utf8');
  if (fs.readFileSync(p, 'utf8') !== PYTHON_OBSERVER_SOURCE) {
    throw new Error(`python observer at ${p} does not match Canary's bytes even after rewrite (workspace is not writable-stable)`);
  }
  return dir;
}

/**
 * The per-round binding token, re-derivable by `prove` from the same inputs.
 *
 * DETERMINISTIC ON PURPOSE: re-derivation parity is structural in this codebase
 * (capture and prove call the SAME expansion and the same validator), and a random
 * token would have to be recorded and excused from every comparison. This is NOT
 * claimed to be a secret — a process that has the spec and fixture can compute it,
 * exactly as it can compute anything else about its own run. What it binds is that
 * these frames came from THIS round's spawn on THIS fixture: the live defences
 * against foreign frames remain the private fd-3 pipe (handed only to the child)
 * and the pid/ppid check, and the documented in-process emulation ceiling is
 * unchanged.
 */
export function observerNonce(runnerId: string, fixturePath: string, arm: string, round: number): string {
  const real = (() => { try { return fs.realpathSync(fixturePath); } catch { return path.resolve(fixturePath); } })();
  return crypto.createHash('sha256')
    .update(`${OBSERVER_PROTOCOL_VERSION}|${runnerId}|${real}|${arm}|${round}`, 'utf8')
    .digest('hex').slice(0, 32);
}

/** Shared with the mocha channel so the two cannot drift apart. */
export const OBSERVER_PROTOCOL_VERSION = OBSERVER_VERSION;

/** `hello.runner` for this channel; the neutral validator binds it. */
export const PYTHON_RUNNER_ID = 'python-unittest';

export const PYTHON_OBSERVER_SOURCE = `# Canary observation observer (sitecustomize). See packages/runner/executor/src/observers/python-observer.ts
import json
import os
import sys

OBSERVER_VERSION = "canary-observer-v1"
RUNNER_ID = "python-unittest"
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
_passed = set()
_hook_broken = False


def _ident(test):
    try:
        return test.id()
    except Exception:
        return None


import atexit
import unittest

_PATCHED = False


def _install():
    global _PATCHED, _hook_broken
    if _PATCHED:
        return
    _PATCHED = True
    R = unittest.TestResult

    orig_start = R.startTest
    orig_success = R.addSuccess
    orig_failure = R.addFailure
    orig_error = R.addError
    orig_skip = R.addSkip
    orig_expected = R.addExpectedFailure
    orig_unexpected = R.addUnexpectedSuccess

    def startTest(self, test):
        try:
            _started.add(_ident(test))
        except Exception:
            pass
        return orig_start(self, test)

    def addSuccess(self, test):
        try:
            i = _ident(test)
            if i not in _started:
                counts["rejected"] += 1
                _frame({"k": "reject", "ev": "pass", "id": i, "reason": "no-run"})
            elif i in _passed:
                counts["rejected"] += 1
                _frame({"k": "reject", "ev": "pass", "id": i, "reason": "dup-pass"})
            else:
                _passed.add(i)
                counts["pass"] += 1
                _frame({"k": "pass", "id": i})
        except Exception:
            _hook_broken = True
            _frame({"k": "adapter-error", "err": "addSuccess hook failed"})
        return orig_success(self, test)

    def _fail(test):
        try:
            i = _ident(test)
            if i not in _started:
                counts["rejected"] += 1
                _frame({"k": "reject", "ev": "fail", "id": i, "reason": "no-run"})
            else:
                counts["fail"] += 1
                _frame({"k": "fail", "id": i, "hook": False})
        except Exception:
            _hook_broken = True
            _frame({"k": "adapter-error", "err": "fail hook failed"})

    def addFailure(self, test, err):
        _fail(test)
        return orig_failure(self, test, err)

    def addError(self, test, err):
        _fail(test)
        return orig_error(self, test, err)

    def addUnexpectedSuccess(self, test):
        _fail(test)
        return orig_unexpected(self, test)

    def _pending(test):
        try:
            counts["pending"] += 1
            _frame({"k": "pending", "id": _ident(test)})
        except Exception:
            _hook_broken = True
            _frame({"k": "adapter-error", "err": "pending hook failed"})

    def addSkip(self, test, reason):
        _pending(test)
        return orig_skip(self, test, reason)

    def addExpectedFailure(self, test, err):
        _pending(test)
        return orig_expected(self, test, err)

    R.startTest = startTest
    R.addSuccess = addSuccess
    R.addFailure = addFailure
    R.addError = addError
    R.addSkip = addSkip
    R.addExpectedFailure = addExpectedFailure
    R.addUnexpectedSuccess = addUnexpectedSuccess


try:
    _install()
    _py = "%d.%d.%d" % (sys.version_info[0], sys.version_info[1], sys.version_info[2])
    _frame({
        "k": "hello",
        "runner": RUNNER_ID,
        "runnerVersion": _py,
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


@atexit.register
def _bye():
    try:
        if not _hook_broken:
            _frame({"k": "bye", "counts": counts})
    except Exception:
        pass
    _close()
`;
