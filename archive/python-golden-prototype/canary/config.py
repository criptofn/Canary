"""canary.toml loading and validation."""

import hashlib
import json
import os
import shlex
import sys
import tomllib
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .normalize import DEFAULT_RULE_NAMES, ALL_RULE_NAMES

CONFIG_DEFAULT_NAME = "canary.toml"
BASELINE_DIR_DEFAULT = ".canary"
BASELINE_FILE_NAME = "baseline.json"


class ConfigError(Exception):
    """Invalid or missing canary configuration."""


@dataclass
class Check:
    name: str
    argv: List[str]
    timeout: float = 30.0
    stdin: Optional[str] = None
    cwd: str = "."
    env: Dict[str, str] = field(default_factory=dict)


@dataclass
class Config:
    path: str                      # absolute path to canary.toml
    root: str                      # absolute dir containing canary.toml
    checks: List[Check]
    rule_names: List[str]
    baseline_dir: str              # absolute path to .canary
    raw_hash: str                  # sha256 of canonical config content


def find_config(explicit: Optional[str], start_dir: str) -> str:
    if explicit:
        p = os.path.abspath(explicit)
        if not os.path.isfile(p):
            raise ConfigError(f"config file not found: {p}")
        return p
    p = os.path.join(os.path.abspath(start_dir), CONFIG_DEFAULT_NAME)
    if not os.path.isfile(p):
        raise ConfigError(f"no {CONFIG_DEFAULT_NAME} found in {os.path.abspath(start_dir)}")
    return p


def _substitute_placeholders(token: str, root: str) -> str:
    replacements = {
        "{python}": sys.executable,
        "{canary_root}": root,
    }
    for needle, value in replacements.items():
        token = token.replace(needle, value)
    return token


def _parse_check(raw: dict, index: int, root: str) -> Check:
    if not isinstance(raw, dict):
        raise ConfigError(f"check #{index}: must be a table")
    name = raw.get("name")
    if not name or not isinstance(name, str):
        raise ConfigError(f"check #{index}: missing string 'name'")

    cmd = raw.get("cmd")
    argv = raw.get("argv")
    if cmd is None and argv is None:
        raise ConfigError(f"check '{name}': must define 'argv' (array) or 'cmd' (string)")
    if cmd is not None and argv is not None:
        raise ConfigError(f"check '{name}': define only one of 'argv' / 'cmd'")

    if argv is not None:
        if not isinstance(argv, list) or not all(isinstance(t, str) for t in argv) or not argv:
            raise ConfigError(f"check '{name}': 'argv' must be a non-empty array of strings")
        tokens = list(argv)
    else:
        if not isinstance(cmd, str) or not cmd.strip():
            raise ConfigError(f"check '{name}': 'cmd' must be a non-empty string")
        try:
            if os.name == "nt":
                # posix=False keeps backslashes intact (Windows paths), but
                # leaves quote characters on tokens; strip those.
                tokens = [t.strip("\"") for t in shlex.split(cmd, posix=False)]
            else:
                tokens = shlex.split(cmd, posix=True)
        except ValueError as e:
            raise ConfigError(f"check '{name}': cannot parse cmd: {e}")

    tokens = [_substitute_placeholders(t, root) for t in tokens]

    timeout = raw.get("timeout", 30.0)
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ConfigError(f"check '{name}': 'timeout' must be a positive number")

    stdin = raw.get("stdin")
    if stdin is not None and not isinstance(stdin, str):
        raise ConfigError(f"check '{name}': 'stdin' must be a string")

    cwd = raw.get("cwd", ".")
    if not isinstance(cwd, str):
        raise ConfigError(f"check '{name}': 'cwd' must be a string")

    env = raw.get("env", {})
    if not isinstance(env, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in env.items()
    ):
        raise ConfigError(f"check '{name}': 'env' must be a table of string keys/values")

    return Check(name=name, argv=tokens, timeout=float(timeout), stdin=stdin,
                 cwd=cwd, env=dict(env))


def load_config(path: str) -> Config:
    path = os.path.abspath(path)
    root = os.path.dirname(path)
    try:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path}: invalid TOML: {e}")
    except OSError as e:
        raise ConfigError(f"{path}: cannot read: {e}")

    canary_raw = raw.get("canary", {})
    if not isinstance(canary_raw, dict):
        raise ConfigError(f"{path}: [canary] must be a table")

    rule_names = canary_raw.get("normalizers", DEFAULT_RULE_NAMES)
    if not isinstance(rule_names, list) or not all(isinstance(r, str) for r in rule_names):
        raise ConfigError(f"{path}: canary.normalizers must be an array of strings")
    unknown = [r for r in rule_names if r not in ALL_RULE_NAMES]
    if unknown:
        raise ConfigError(
            f"{path}: unknown normalizer(s) {unknown}; available: {sorted(ALL_RULE_NAMES)}"
        )

    baseline_dir = canary_raw.get("baseline_dir", BASELINE_DIR_DEFAULT)
    if not isinstance(baseline_dir, str):
        raise ConfigError(f"{path}: canary.baseline_dir must be a string")
    baseline_dir = baseline_dir if os.path.isabs(baseline_dir) else os.path.join(root, baseline_dir)

    checks_raw = raw.get("check", [])
    if not isinstance(checks_raw, list):
        raise ConfigError(f"{path}: [[check]] entries must be an array")
    if not checks_raw:
        raise ConfigError(f"{path}: no [[check]] entries defined")

    checks = [_parse_check(c, i, root) for i, c in enumerate(checks_raw)]
    names = [c.name for c in checks]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise ConfigError(f"{path}: duplicate check names: {dupes}")

    canonical = json.dumps(raw, sort_keys=True, ensure_ascii=True, default=str)
    raw_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    return Config(
        path=path,
        root=root,
        checks=checks,
        rule_names=list(rule_names),
        baseline_dir=os.path.abspath(baseline_dir),
        raw_hash=raw_hash,
    )
