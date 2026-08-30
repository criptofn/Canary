import os
import sys
import tempfile
import unittest

from helpers import REPO_ROOT  # noqa: F401

from canary.config import Check
from canary.runner import STATUS_ERROR, STATUS_OK, run_check

PY = sys.executable


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = self.dir.name

    def test_stdout_exit0(self):
        r = run_check(Check(name="t", argv=[PY, "-c", "print('hi')"]), self.root)
        self.assertEqual(r.status, STATUS_OK)
        self.assertEqual(r.exit_code, 0)
        self.assertEqual(r.stdout.strip(), "hi")
        self.assertEqual(r.stderr, "")

    def test_stderr_and_nonzero_exit_are_ok_results(self):
        r = run_check(Check(name="t", argv=[PY, "-c",
                          "import sys; print('e', file=sys.stderr); sys.exit(7)"]), self.root)
        self.assertEqual(r.status, STATUS_OK)  # nonzero exit is behavior, not error
        self.assertEqual(r.exit_code, 7)
        self.assertIn("e", r.stderr)

    def test_stdin(self):
        r = run_check(Check(name="t", argv=[PY, "-c",
                          "import sys; print(sys.stdin.read().upper())"], stdin="abc"), self.root)
        self.assertEqual(r.stdout.strip(), "ABC")

    def test_env_visible(self):
        r = run_check(Check(name="t", argv=[PY, "-c",
                          "import os; print(os.environ['CANARY_TEST_VAR'])"],
                          env={"CANARY_TEST_VAR": "zzz"}), self.root)
        self.assertEqual(r.stdout.strip(), "zzz")

    def test_forced_env_wins(self):
        r = run_check(Check(name="t", argv=[PY, "-c",
                          "import os; print(os.environ['PYTHONUTF8'])"],
                          env={"PYTHONUTF8": "0"}), self.root)
        self.assertEqual(r.stdout.strip(), "1")

    def test_cwd_relative_to_root(self):
        r = run_check(Check(name="t", argv=[PY, "-c", "import os; print(os.getcwd())"],
                            cwd=".", timeout=15), self.root)
        self.assertEqual(os.path.normcase(r.stdout.strip()), os.path.normcase(os.path.realpath(self.root)))

    def test_timeout_kills(self):
        r = run_check(Check(name="t", argv=[PY, "-c", "import time; time.sleep(30)"],
                            timeout=1.0), self.root)
        self.assertEqual(r.status, STATUS_ERROR)
        self.assertIn("timeout", r.error)
        self.assertLess(r.duration, 20)

    def test_launch_failure_is_error(self):
        r = run_check(Check(name="t", argv=["definitely-not-a-real-binary-xyz"], timeout=5), self.root)
        self.assertEqual(r.status, STATUS_ERROR)
        self.assertIn("launch failed", r.error)

    def test_output_is_utf8(self):
        r = run_check(Check(name="t", argv=[PY, "-c", "print('é中✅')"]), self.root)
        self.assertEqual(r.stdout.strip(), "é中✅")


if __name__ == "__main__":
    unittest.main()
