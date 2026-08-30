"""Canary — local, deterministic regression-proof CLI.

Canary records normalized golden baselines for a suite of checks, then
re-runs them and proves byte-for-byte that nothing has regressed.
"""

__version__ = "0.1.0"
