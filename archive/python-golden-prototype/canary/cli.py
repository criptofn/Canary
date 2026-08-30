"""Canary CLI: record, verify, accept, list.

Exit codes:
  0  verify: all checks match / record+accept succeeded cleanly
  1  regression: drift, run errors, or missing goldens
  2  canary misuse: bad config, no baseline, unknown check name
"""

import argparse
import sys
from typing import Dict, List, Optional

from . import __version__
from .config import Check, Config, ConfigError, find_config, load_config
from .normalize import build_pipeline, normalize
from .report import (
    VerifyReport,
    CheckOutcome,
    compare,
    format_human,
    format_json,
)
from .runner import STATUS_OK, run_check
from .snapshot import (
    BaselineError,
    baseline_path,
    build_baseline,
    env_fingerprint,
    golden_from_result,
    read_baseline,
    write_baseline,
)

EXIT_OK = 0
EXIT_REGRESSION = 1
EXIT_MISUSE = 2


def _utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass


def _select_checks(config: Config, only: List[str]) -> List[Check]:
    if not only:
        return config.checks
    known = {c.name for c in config.checks}
    for name in only:
        if name not in known:
            raise ConfigError(f"unknown check: {name} (see `canary list`)")
    wanted = set(only)
    return [c for c in config.checks if c.name in wanted]


def _run_all(config: Config, checks: List[Check]) -> List:
    """Run checks in declared order; returns (check, result) pairs."""
    pairs = []
    for check in checks:
        result = run_check(check, config.root)
        pairs.append((check, result))
    return pairs


def cmd_record(config: Config, only: List[str]) -> int:
    pipeline = build_pipeline(config.rule_names)
    checks = _select_checks(config, only)
    pairs = _run_all(config, checks)

    errors = [(c.name, r.error) for c, r in pairs if r.status != STATUS_OK]
    if errors:
        print(f"record aborted: {len(errors)} check(s) failed to complete cleanly:")
        for name, err in errors:
            print(f"  - {name}: {err}")
        print("No baseline was written.")
        return EXIT_REGRESSION

    if only:
        # Partial record: merge into existing baseline if present.
        try:
            existing = read_baseline(config.baseline_dir) or {}
        except BaselineError as e:
            print(f"error: {e}", file=sys.stderr)
            return EXIT_MISUSE
    else:
        existing = {}

    goldens: Dict[str, Dict] = dict(existing.get("checks", {}))
    for check, result in pairs:
        goldens[check.name] = golden_from_result(result, lambda t: normalize(t, pipeline))
    baseline = build_baseline(config.raw_hash, goldens)
    path = write_baseline(config.baseline_dir, baseline)
    print(f"recorded {len(pairs)} check(s) -> {path}")
    return EXIT_OK


def _verify_warnings(baseline: Dict, config: Config) -> List[str]:
    warnings = []
    if baseline.get("config_hash") != config.raw_hash:
        warnings.append("canary.toml changed since the baseline was recorded")
    if baseline.get("canary_version") != __version__:
        warnings.append(
            f"canary version changed: baseline={baseline.get('canary_version')} now={__version__}"
        )
    env_now = env_fingerprint()
    env_base = baseline.get("env", {})
    changed = {k: (env_base.get(k), v) for k, v in env_now.items() if env_base.get(k) != v}
    if changed:
        detail = ", ".join(f"{k} {old!r}->{new!r}" for k, (old, new) in changed.items())
        warnings.append(f"environment differs from recording time: {detail}")
    return warnings


def cmd_verify(config: Config, only: List[str], as_json: bool) -> int:
    try:
        baseline = read_baseline(config.baseline_dir)
    except BaselineError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_MISUSE
    if baseline is None:
        print(f"error: no baseline at {baseline_path(config.baseline_dir)}; "
              f"run `canary record` first", file=sys.stderr)
        return EXIT_MISUSE

    pipeline = build_pipeline(config.rule_names)
    checks = _select_checks(config, only)
    pairs = _run_all(config, checks)
    goldens: Dict[str, Dict] = baseline.get("checks", {})

    outcomes: List[CheckOutcome] = []
    for check, result in pairs:
        golden = goldens.get(check.name)
        actual_stdout = normalize(result.stdout, pipeline) if result.status == STATUS_OK else ""
        actual_stderr = normalize(result.stderr, pipeline) if result.status == STATUS_OK else ""
        outcomes.append(compare(
            check.name, golden,
            result.exit_code, actual_stdout, actual_stderr,
            result.error, result.status,
        ))

    report = VerifyReport(outcomes=outcomes, warnings=_verify_warnings(baseline, config))
    total = len(outcomes)
    if as_json:
        print(format_json(report, total))
    else:
        print(format_human(report, total))
    return EXIT_OK if report.ok else EXIT_REGRESSION


def cmd_accept(config: Config, names: List[str]) -> int:
    try:
        existing = read_baseline(config.baseline_dir)
    except BaselineError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_MISUSE

    checks = _select_checks(config, names)
    pipeline = build_pipeline(config.rule_names)
    pairs = _run_all(config, checks)
    errors = [(c.name, r.error) for c, r in pairs if r.status != STATUS_OK]
    if errors:
        print("accept aborted: errored checks cannot become goldens:")
        for name, err in errors:
            print(f"  - {name}: {err}")
        return EXIT_REGRESSION

    goldens = dict(existing.get("checks", {})) if existing else {}
    for check, result in pairs:
        goldens[check.name] = golden_from_result(result, lambda t: normalize(t, pipeline))
    baseline = build_baseline(config.raw_hash, goldens)
    path = write_baseline(config.baseline_dir, baseline)
    print(f"accepted {len(pairs)} check(s): {', '.join(n for n in names)} -> {path}")
    return EXIT_OK


def cmd_list(config: Config) -> int:
    print(f"{len(config.checks)} check(s) defined in {config.path}:")
    width = max(len(c.name) for c in config.checks)
    for c in config.checks:
        print(f"  {c.name:<{width}}  {c.argv[0]} {' '.join(c.argv[1:])}".rstrip())
    print(f"baseline: {baseline_path(config.baseline_dir)}")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="canary",
        description="Deterministic local regression proof: record golden behavior, verify it never drifts.",
    )
    parser.add_argument("--version", action="version", version=f"canary {__version__}")
    # Common options usable both before and after the verb. Subparser defaults
    # use SUPPRESS so the after-verb form never clobbers the before-verb one.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", default=argparse.SUPPRESS,
                        help="path to canary.toml (default: ./canary.toml)")
    parser.add_argument("--config", dest="config", default=None, help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("record", parents=[common],
                       help="run all checks and write the golden baseline")
    p.add_argument("--only", action="append", default=[], metavar="NAME",
                   help="record only this check (repeatable; merges into existing baseline)")
    v = sub.add_parser("verify", parents=[common],
                       help="re-run checks and diff against the baseline")
    v.add_argument("--only", action="append", default=[], metavar="NAME")
    v.add_argument("--json", action="store_true", help="machine-readable report")
    a = sub.add_parser("accept", parents=[common],
                       help="re-run named checks and update their goldens")
    a.add_argument("names", nargs="+", metavar="NAME")
    sub.add_parser("list", parents=[common], help="show configured checks")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    _utf8_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        config = load_config(find_config(args.config, "."))
        if args.command == "record":
            return cmd_record(config, args.only)
        if args.command == "verify":
            return cmd_verify(config, args.only, args.json)
        if args.command == "accept":
            return cmd_accept(config, args.names)
        if args.command == "list":
            return cmd_list(config)
        parser.error(f"unknown command {args.command}")  # pragma: no cover
        return EXIT_MISUSE
    except (ConfigError, BaselineError) as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_MISUSE


if __name__ == "__main__":
    sys.exit(main())
