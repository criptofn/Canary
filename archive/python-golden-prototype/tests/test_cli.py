"""End-to-end CLI tests: real subprocesses, zero mocks.

These are the heart of Canary's promise: `verify` exits 0 iff nothing
regressed, and a regression is detected with a precise, named diff.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

from helpers import CANARY_CMD, REPO_ROOT, cli_env, write  # noqa: F401

SUBJECT_V1 = """
import sys
mode = sys.argv[1]
if mode == "ping":
    print("PONG")
    sys.exit(0)
if mode == "greet":
    print("Hello, Alice!")
    sys.exit(0)
if mode == "boom":
    print("simulated failure", file=sys.stderr)
    sys.exit(3)
if mode == "hang":
    import time; time.sleep(60)
"""

# V2: greet regressed (wrong greeting), everything else unchanged.
SUBJECT_V2 = SUBJECT_V1.replace("Hello, Alice!", "Goodbye, Alice.")

TOML = """
[[check]]
name = "ping"
argv = ["{python}", "subject.py", "ping"]

[[check]]
name = "greet"
argv = ["{python}", "subject.py", "greet"]

[[check]]
name = "boom"
argv = ["{python}", "subject.py", "boom"]

[[check]]
name = "hang"
argv = ["{python}", "subject.py", "hang"]
timeout = 1.5
"""

TOML_NO_HANG = TOML.replace(
    'timeout = 1.5\n', '').replace("""
[[check]]
name = "hang"
argv = ["{python}", "subject.py", "hang"]
""", "")


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.ws = self.dir.name
        write(os.path.join(self.ws, "subject.py"), SUBJECT_V1)

    def canary(self, *args, expect_rc=None):
        proc = subprocess.run(
            CANARY_CMD + list(args),
            cwd=self.ws, env=cli_env(),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=120,
        )
        if expect_rc is not None:
            self.assertEqual(
                proc.returncode, expect_rc,
                f"cmd={args}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}",
            )
        return proc

    def use_toml(self, text=TOML):
        write(os.path.join(self.ws, "canary.toml"), text)


class RecordVerifyTests(CliTestCase):
    def test_happy_path_proof_cycle(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        self.assertTrue(os.path.isfile(os.path.join(self.ws, ".canary", "baseline.json")))
        self.canary("verify", expect_rc=0)
        # Proof must be reproducible: verify twice is identical.
        a = self.canary("verify", expect_rc=0).stdout
        b = self.canary("verify", expect_rc=0).stdout
        self.assertEqual(a, b)
        self.assertIn("REGRESSION PROOF: PASS", a)
        self.assertIn("3/3", a)

    def test_drift_detected_and_named(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        write(os.path.join(self.ws, "subject.py"), SUBJECT_V2)
        proc = self.canary("verify", expect_rc=1)
        self.assertIn("REGRESSION PROOF: FAIL", proc.stdout)
        self.assertIn("greet", proc.stdout)
        self.assertIn("-Hello, Alice!", proc.stdout.replace("          ", ""))
        self.assertIn("+Goodbye, Alice.", proc.stdout.replace("          ", ""))
        # ping and boom must still be clean
        self.assertIn("[     ok]  ping", proc.stdout)
        # Restore: proof holds again
        write(os.path.join(self.ws, "subject.py"), SUBJECT_V1)
        self.canary("verify", expect_rc=0)

    def test_exit_code_drift_without_output_change(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        write(os.path.join(self.ws, "subject.py"),
              SUBJECT_V1.replace('    print("PONG")\n    sys.exit(0)', '    print("PONG")\n    sys.exit(1)'))
        proc = self.canary("verify", expect_rc=1)
        self.assertIn("exit code 0 -> 1", proc.stdout)

    def test_verify_without_baseline_is_misuse(self):
        self.use_toml(TOML_NO_HANG)
        proc = self.canary("verify", expect_rc=2)
        self.assertIn("no baseline", proc.stderr)

    def test_record_aborts_on_errored_check_writes_nothing(self):
        self.use_toml(TOML)  # includes the hang check
        proc = self.canary("record", expect_rc=1)
        self.assertIn("record aborted", proc.stdout)
        self.assertIn("timeout", proc.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.ws, ".canary", "baseline.json")))

    def test_hang_check_verifies_as_error(self):
        self.use_toml(TOML)
        self.canary("record", "--only", "ping", "--only", "greet", "--only", "boom", expect_rc=0)
        proc = self.canary("verify", expect_rc=1)
        self.assertIn("ERROR", proc.stdout)
        self.assertIn("hang", proc.stdout)

    def test_json_output_shape(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        write(os.path.join(self.ws, "subject.py"), SUBJECT_V2)
        proc = self.canary("verify", "--json", expect_rc=1)
        data = json.loads(proc.stdout)
        self.assertEqual(data["verdict"], "FAIL")
        greet = next(c for c in data["checks"] if c["name"] == "greet")
        self.assertEqual(greet["status"], "DRIFT")
        self.assertIsNotNone(greet["stdout_diff"])
        ping = next(c for c in data["checks"] if c["name"] == "ping")
        self.assertEqual(ping["status"], "MATCH")

    def test_only_filter(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", "--only", "ping", expect_rc=0)
        self.canary("verify", "--only", "ping", expect_rc=0)
        proc = self.canary("verify", expect_rc=1)  # greet/boom have no goldens
        self.assertIn("MISSING", proc.stdout)

    def test_unknown_check_name(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        self.canary("verify", "--only", "nope", expect_rc=2)


class AcceptTests(CliTestCase):
    def test_ratchet_workflow(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        # Intentional change to greet.
        write(os.path.join(self.ws, "subject.py"), SUBJECT_V2)
        self.canary("verify", expect_rc=1)
        self.canary("accept", "greet", expect_rc=0)
        self.canary("verify", expect_rc=0)  # new golden adopted
        # Golden now holds the new behavior
        data = json.load(open(os.path.join(self.ws, ".canary", "baseline.json"), encoding="utf-8"))
        self.assertIn("Goodbye", data["checks"]["greet"]["stdout"])
        # Other goldens untouched
        self.assertEqual(data["checks"]["ping"]["stdout"], "PONG\n")

    def test_accept_rejects_errored_check(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        self.use_toml(TOML)  # now add hang check
        proc = self.canary("accept", "hang", expect_rc=1)
        self.assertIn("accept aborted", proc.stdout)

    def test_accept_unknown_name(self):
        self.use_toml(TOML_NO_HANG)
        self.canary("record", expect_rc=0)
        self.canary("accept", "nonexistent", expect_rc=2)


class ListVersionTests(CliTestCase):
    def test_list(self):
        self.use_toml(TOML_NO_HANG)
        proc = self.canary("list", expect_rc=0)
        for name in ("ping", "greet", "boom"):
            self.assertIn(name, proc.stdout)

    def test_version(self):
        proc = subprocess.run(CANARY_CMD + ["--version"], cwd=self.ws,
                              env=cli_env(), capture_output=True, text=True, timeout=60)
        self.assertIn("canary", proc.stdout)

    def test_no_config_is_misuse(self):
        proc = self.canary("verify", expect_rc=2)
        self.assertIn("canary.toml", proc.stderr)


class NoisyProgramStabilityTests(CliTestCase):
    """The regression proof's credibility rests here: a program that prints
    timestamps/UUIDs/temp paths every run must still verify clean."""

    NOISY = """
import sys, uuid, tempfile, getpass, platform, os
from datetime import datetime
print("ts=" + datetime.now().isoformat())
print("id=" + str(uuid.uuid4()))
print("tmp=" + tempfile.mkdtemp())
print("user=" + getpass.getuser() + " host=" + platform.node())
print("home=" + os.path.expanduser("~"))
sys.exit(0)
"""
    TOML = """
[[check]]
name = "noisy"
argv = ["{python}", "noisy.py"]
"""

    def test_noisy_is_stable_under_verification(self):
        write(os.path.join(self.ws, "noisy.py"), self.NOISY)
        write(os.path.join(self.ws, "canary.toml"), self.TOML)
        self.canary("record", expect_rc=0)
        for _ in range(3):
            self.canary("verify", expect_rc=0)
        data = json.load(open(os.path.join(self.ws, ".canary", "baseline.json"), encoding="utf-8"))
        stdout = data["checks"]["noisy"]["stdout"]
        self.assertIn("<TS>", stdout)
        self.assertIn("<UUID>", stdout)
        self.assertIn("<TEMP>", stdout)
        self.assertIn("<HOME>", stdout)


if __name__ == "__main__":
    unittest.main()
