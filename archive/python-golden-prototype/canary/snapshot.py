"""Baseline storage: one committable JSON file of golden outputs.

Layout:  <baseline_dir>/baseline.json

Schema (v1):
{
  "schema": 1,
  "canary_version": "0.1.0",
  "created_at": "<ISO8601>",            # informational only, not compared
  "config_hash": "<sha256>",            # informational; mismatch => warning
  "env": {"platform", "python", "os"},  # informational; changes => warning
  "checks": {
    "<name>": {
      "exit_code": int,
      "stdout": "<normalized golden>",
      "stderr": "<normalized golden>",
      "stdout_sha256": "...", "stderr_sha256": "..."
    }
  }
}
"""

import hashlib
import json
import os
import platform
import sys
import tempfile
from datetime import datetime, timezone
from typing import Dict, Optional

from . import __version__
from .config import BASELINE_FILE_NAME
from .runner import RunResult

SCHEMA = 1


class BaselineError(Exception):
    pass


def baseline_path(baseline_dir: str) -> str:
    return os.path.join(baseline_dir, BASELINE_FILE_NAME)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def env_fingerprint() -> Dict[str, str]:
    """Machine context recorded for the report. Never part of the comparison."""
    return {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "release": platform.release(),
    }


def golden_from_result(result: RunResult, normalize_fn) -> Dict[str, object]:
    stdout = normalize_fn(result.stdout)
    stderr = normalize_fn(result.stderr)
    return {
        "exit_code": result.exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "stdout_sha256": _sha(stdout),
        "stderr_sha256": _sha(stderr),
    }


def build_baseline(config_hash: str, goldens: Dict[str, Dict]) -> Dict:
    return {
        "schema": SCHEMA,
        "canary_version": __version__,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "config_hash": config_hash,
        "env": env_fingerprint(),
        "checks": {k: goldens[k] for k in sorted(goldens)},
    }


def write_baseline(baseline_dir: str, baseline: Dict) -> str:
    path = baseline_path(baseline_dir)
    os.makedirs(baseline_dir, exist_ok=True)
    payload = json.dumps(baseline, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    # Atomic replace so an interrupted run never leaves a half baseline.
    fd, tmp = tempfile.mkstemp(dir=baseline_dir, prefix=".baseline-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(payload)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def read_baseline(baseline_dir: str) -> Optional[Dict]:
    path = baseline_path(baseline_dir)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise BaselineError(f"cannot read baseline {path}: {e}")
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise BaselineError(f"unsupported baseline schema in {path}")
    if not isinstance(data.get("checks"), dict):
        raise BaselineError(f"malformed baseline (no checks table) in {path}")
    return data
