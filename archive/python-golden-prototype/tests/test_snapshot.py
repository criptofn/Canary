import json
import os
import tempfile
import unittest

from helpers import REPO_ROOT, write  # noqa: F401

from canary.runner import RunResult
from canary.snapshot import (
    BaselineError,
    baseline_path,
    build_baseline,
    golden_from_result,
    read_baseline,
    write_baseline,
)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.bdir = os.path.join(self.dir.name, ".canary")

    def _rr(self, name, out, err, code):
        return RunResult(name=name, status="ok", exit_code=code, stdout=out, stderr=err)

    def test_write_read_roundtrip(self):
        g = {"a": golden_from_result(self._rr("a", "hi\n", "", 0), lambda t: t)}
        b = build_baseline("hash1", g)
        path = write_baseline(self.bdir, b)
        self.assertEqual(path, baseline_path(self.bdir))
        back = read_baseline(self.bdir)
        self.assertEqual(back["checks"]["a"]["stdout"], "hi\n")
        self.assertEqual(back["config_hash"], "hash1")

    def test_golden_hashes_match_content(self):
        g = golden_from_result(self._rr("a", "x\n", "y\n", 0), lambda t: t.upper())
        import hashlib
        self.assertEqual(g["stdout_sha256"], hashlib.sha256(b"X\n").hexdigest())
        self.assertEqual(g["stderr_sha256"], hashlib.sha256(b"Y\n").hexdigest())

    def test_read_missing_returns_none(self):
        self.assertIsNone(read_baseline(self.bdir))

    def test_read_bad_schema_raises(self):
        os.makedirs(self.bdir, exist_ok=True)
        write(baseline_path(self.bdir), json.dumps({"schema": 99, "checks": {}}))
        with self.assertRaises(BaselineError):
            read_baseline(self.bdir)

    def test_read_corrupt_raises(self):
        os.makedirs(self.bdir, exist_ok=True)
        write(baseline_path(self.bdir), "{not json")
        with self.assertRaises(BaselineError):
            read_baseline(self.bdir)

    def test_write_is_atomic_no_temp_leftover(self):
        g = {"a": golden_from_result(self._rr("a", "hi\n", "", 0), lambda t: t)}
        write_baseline(self.bdir, build_baseline("h", g))
        write_baseline(self.bdir, build_baseline("h", g))  # overwrite
        leftovers = [f for f in os.listdir(self.bdir) if f.startswith(".baseline-")]
        self.assertEqual(leftovers, [])

    def test_json_uses_lf_and_sorted_keys(self):
        g = {"b": golden_from_result(self._rr("b", "1\n", "", 0), lambda t: t),
             "a": golden_from_result(self._rr("a", "2\n", "", 0), lambda t: t)}
        write_baseline(self.bdir, build_baseline("h", g))
        raw = open(baseline_path(self.bdir), "rb").read()
        self.assertNotIn(b"\r\n", raw)
        data = json.loads(raw)
        self.assertEqual(list(data["checks"].keys()), ["a", "b"])


if __name__ == "__main__":
    unittest.main()
