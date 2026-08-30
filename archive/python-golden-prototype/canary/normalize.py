"""Normalization of program output to deterministic (stable) text.

Regression proof requires byte-for-byte comparison. Programs are rarely
byte-for-byte stable across runs (timestamps, UUIDs, temp paths, PIDs,
addresses, machine names). Each rule replaces a known source of run-to-run
nondeterminism with a fixed placeholder token.

Rules are applied in a fixed order; order matters (e.g. full ISO timestamps
before bare dates, paths before bare usernames which appear inside paths).
"""

import getpass
import os
import platform
import re
import tempfile
from typing import Callable, Dict, List

Rule = Callable[[str], str]


def _line_endings(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _trailing_ws(text: str) -> str:
    lines = [ln.rstrip() for ln in text.split("\n")]
    text = "\n".join(lines)
    # Exactly one trailing newline for non-empty output.
    text = text.rstrip("\n")
    return text + "\n" if text else ""


_ISO_TS = re.compile(
    r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b"
)
_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_UUID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_HEX_ADDR = re.compile(r"\b0x[0-9a-fA-F]{8,16}\b")
_DURATION = re.compile(r"\bin \d+\.\d+s\b")


def _iso_ts(text: str) -> str:
    return _ISO_TS.sub("<TS>", text)


def _date(text: str) -> str:
    return _DATE.sub("<DATE>", text)


def _uuid(text: str) -> str:
    return _UUID.sub("<UUID>", text)


def _hex_addr(text: str) -> str:
    return _HEX_ADDR.sub("<ADDR>", text)


def _duration(text: str) -> str:
    return _DURATION.sub("in <SEC>s", text)


def _path_variants(path: str) -> List[str]:
    """All spellings of a path we should match (native, slashed, normalized)."""
    variants = set()
    p = os.path.normpath(path)
    variants.add(p)
    variants.add(p.replace("\\", "/"))
    variants.add(p.replace("/", "\\"))
    # Drive-letter case variants (C:\ vs c:\) are both seen on Windows.
    if len(p) >= 2 and p[1] == ":":
        lowered = p[0].lower() + p[1:]
        variants.add(lowered)
        variants.add(lowered.replace("\\", "/"))
    # Drop any trailing separators; we match prefixes with a boundary.
    return sorted((v for v in variants if v), key=len, reverse=True)


def _make_path_rule(path: str, token: str) -> Rule:
    variants = _path_variants(path)
    if not variants:
        return lambda text: text
    pattern = re.compile(
        "(?:" + "|".join(re.escape(v) for v in variants) + r")(?:[\\/][^\s\"',;]*)?",
        re.IGNORECASE,
    )

    def rule(text: str) -> str:
        return pattern.sub(token, text)

    return rule


def _make_literal_rule(value: str, token: str) -> Rule:
    if not value:
        return lambda text: text
    pattern = re.compile(re.escape(value), re.IGNORECASE)
    return lambda text: pattern.sub(token, text)


def machine_rules() -> Dict[str, Rule]:
    """Path/identity rules derived from the current machine."""
    tmp = tempfile.gettempdir()
    home = os.path.expanduser("~")
    user = getpass.getuser()
    host = platform.node()
    rules = {
        "temp-path": _make_path_rule(tmp, "<TEMP>"),
        "home-path": _make_path_rule(home, "<HOME>"),
    }
    host_names = {host, host.split(".")[0]}
    for env_name in ("COMPUTERNAME", "HOSTNAME"):
        v = os.environ.get(env_name)
        if v:
            host_names.add(v)
    host_alt = sorted((h for h in host_names if h), key=len, reverse=True)
    if host_alt:
        pattern = re.compile(
            "(?:" + "|".join(re.escape(h) for h in host_alt) + ")", re.IGNORECASE
        )
        rules["host-name"] = lambda text: pattern.sub("<HOST>", text)
    else:
        rules["host-name"] = lambda text: text
    rules["user-name"] = _make_literal_rule(user, "<USER>")
    return rules


# Default full pipeline, in application order.
DEFAULT_RULE_NAMES = [
    "line-endings",
    "iso-timestamp",
    "date",
    "duration",
    "uuid",
    "hex-address",
    "temp-path",
    "home-path",
    "host-name",
    "user-name",
    "trailing-ws",
]

STATIC_RULES: Dict[str, Rule] = {
    "line-endings": _line_endings,
    "iso-timestamp": _iso_ts,
    "date": _date,
    "duration": _duration,
    "uuid": _uuid,
    "hex-address": _hex_addr,
    "trailing-ws": _trailing_ws,
}

MACHINE_RULE_NAMES = ["temp-path", "home-path", "host-name", "user-name"]

ALL_RULE_NAMES = sorted(set(DEFAULT_RULE_NAMES) | set(STATIC_RULES) | set(MACHINE_RULE_NAMES))


def build_pipeline(rule_names: List[str]) -> List[Rule]:
    """Resolve rule names (in order) to callables. Raises KeyError on unknown."""
    machine = machine_rules()
    merged = {**STATIC_RULES, **machine}
    pipeline = []
    for name in rule_names:
        if name not in merged:
            raise KeyError(f"unknown normalizer rule: {name}")
        pipeline.append(merged[name])
    return pipeline


def normalize(text: str, pipeline: List[Rule]) -> str:
    for rule in pipeline:
        text = rule(text)
    return text
