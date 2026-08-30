"""Comparison of fresh runs against the baseline, and human/machine reports."""

import difflib
from dataclasses import dataclass, field
from typing import Dict, List, Optional

MATCH = "MATCH"
DRIFT = "DRIFT"
ERROR = "ERROR"
MISSING = "MISSING"   # check runs but has no golden in baseline

MAX_DIFF_LINES = 40

STATUS_SYMBOL = {MATCH: "ok", DRIFT: "DRIFT", ERROR: "ERROR", MISSING: "MISSING"}


@dataclass
class CheckOutcome:
    name: str
    status: str
    reasons: List[str] = field(default_factory=list)
    exit_expected: Optional[int] = None
    exit_actual: Optional[int] = None
    stdout_diff: Optional[str] = None
    stderr_diff: Optional[str] = None


@dataclass
class VerifyReport:
    outcomes: List[CheckOutcome]
    warnings: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(o.status == MATCH for o in self.outcomes)

    def counts(self) -> Dict[str, int]:
        counts = {MATCH: 0, DRIFT: 0, ERROR: 0, MISSING: 0}
        for o in self.outcomes:
            counts[o.status] += 1
        return counts


def _unified_diff(old: str, new: str, label: str) -> Optional[str]:
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    if old_lines == new_lines:
        return None
    diff = list(difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f"{label} (golden)", tofile=f"{label} (actual)",
        lineterm="",
    ))
    if len(diff) > MAX_DIFF_LINES:
        removed = len(diff) - MAX_DIFF_LINES
        diff = diff[:MAX_DIFF_LINES] + [f"... ({removed} more diff lines)"]
    return "\n".join(diff)


def compare(name: str, golden: Optional[Dict], actual_exit: Optional[int],
            actual_stdout: str, actual_stderr: str, run_error: Optional[str],
            errored_status: str) -> CheckOutcome:
    """Build one outcome. `errored_status` is RunResult.status."""
    if run_error is not None or errored_status != "ok":
        return CheckOutcome(name=name, status=ERROR,
                            reasons=[run_error or "check did not complete"])
    if golden is None:
        return CheckOutcome(name=name, status=MISSING,
                            reasons=["no golden in baseline — run `canary record` or `canary accept`"])

    reasons: List[str] = []
    if golden["exit_code"] != actual_exit:
        reasons.append(f"exit code {golden['exit_code']} -> {actual_exit}")
    stdout_diff = _unified_diff(golden["stdout"], actual_stdout, "stdout")
    stderr_diff = _unified_diff(golden["stderr"], actual_stderr, "stderr")
    if stdout_diff:
        reasons.append("stdout differs")
    if stderr_diff:
        reasons.append("stderr differs")
    if reasons:
        return CheckOutcome(
            name=name, status=DRIFT, reasons=reasons,
            exit_expected=golden["exit_code"], exit_actual=actual_exit,
            stdout_diff=stdout_diff, stderr_diff=stderr_diff,
        )
    return CheckOutcome(name=name, status=MATCH)


def format_human(report: VerifyReport, total: int) -> str:
    lines: List[str] = []
    for w in report.warnings:
        lines.append(f"warning: {w}")
    for o in report.outcomes:
        head = f"[{STATUS_SYMBOL[o.status]:>7}]  {o.name}"
        lines.append(head)
        for r in o.reasons:
            lines.append(f"          - {r}")
        if o.stdout_diff:
            lines.append("          " + o.stdout_diff.replace("\n", "\n          "))
        if o.stderr_diff:
            lines.append("          " + o.stderr_diff.replace("\n", "\n          "))
    counts = report.counts()
    verdict = "PASS" if report.ok else "FAIL"
    lines.append("")
    lines.append(
        f"REGRESSION PROOF: {verdict} — {counts[MATCH]}/{total} checks match golden "
        f"(drift={counts[DRIFT]}, errors={counts[ERROR]}, missing={counts[MISSING]})"
    )
    return "\n".join(lines)


def format_json(report: VerifyReport, total: int) -> str:
    import json as _json
    payload = {
        "verdict": "PASS" if report.ok else "FAIL",
        "warnings": report.warnings,
        "total": total,
        "counts": report.counts(),
        "checks": [
            {
                "name": o.name,
                "status": o.status,
                "reasons": o.reasons,
                "exit_expected": o.exit_expected,
                "exit_actual": o.exit_actual,
                "stdout_diff": o.stdout_diff,
                "stderr_diff": o.stderr_diff,
            }
            for o in report.outcomes
        ],
    }
    return _json.dumps(payload, indent=2, sort_keys=False)
