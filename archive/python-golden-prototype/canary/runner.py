"""Execution of checks as local subprocesses. No shell, no network.

Determinism contract for every check:
- argv is executed directly (shell=False)
- stdout/stderr captured as bytes, decoded UTF-8 with replacement
- forced child environment: PYTHONIOENCODING=utf-8, PYTHONUTF8=1,
  PYTHONDONTWRITEBYTECODE=1 (check-level env cannot override these)
- timeout kills the process; a killed/failed-to-launch check is an ERROR,
  never a golden
"""

import os
import subprocess
import time
from dataclasses import dataclass
from typing import Optional

from .config import Check

FORCED_ENV = {
    "PYTHONIOENCODING": "utf-8",
    "PYTHONUTF8": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
}

STATUS_OK = "ok"
STATUS_ERROR = "error"


@dataclass
class RunResult:
    name: str
    status: str                  # ok | error
    exit_code: Optional[int]
    stdout: str                  # raw (un-normalized) text
    stderr: str
    error: Optional[str] = None  # error description when status == error
    duration: float = 0.0        # wall time, metadata only — never in goldens


def _decode(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def run_check(check: Check, root: str) -> RunResult:
    cwd = check.cwd if os.path.isabs(check.cwd) else os.path.join(root, check.cwd)
    env = dict(os.environ)
    env.update(check.env)
    env.update(FORCED_ENV)
    stdin_bytes = check.stdin.encode("utf-8") if check.stdin is not None else None

    start = time.monotonic()
    try:
        proc = subprocess.Popen(
            check.argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE if stdin_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )
    except OSError as e:
        return RunResult(
            name=check.name, status=STATUS_ERROR, exit_code=None,
            stdout="", stderr="", error=f"launch failed: {e}",
            duration=time.monotonic() - start,
        )

    try:
        out, err = proc.communicate(input=stdin_bytes, timeout=check.timeout)
        return RunResult(
            name=check.name, status=STATUS_OK, exit_code=proc.returncode,
            stdout=_decode(out), stderr=_decode(err),
            error=None, duration=time.monotonic() - start,
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            out, err = proc.communicate(timeout=10)
        except Exception:
            out, err = b"", b""
        return RunResult(
            name=check.name, status=STATUS_ERROR, exit_code=None,
            stdout=_decode(out), stderr=_decode(err),
            error=f"timeout after {check.timeout:g}s (process killed)",
            duration=time.monotonic() - start,
        )
