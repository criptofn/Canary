import os
import tempfile
import unittest

from helpers import REPO_ROOT  # noqa: F401  (sys.path setup)

from canary.normalize import (
    DEFAULT_RULE_NAMES,
    build_pipeline,
    normalize,
)


def default_normalize(text):
    return normalize(text, build_pipeline(DEFAULT_RULE_NAMES))


class StaticRuleTests(unittest.TestCase):
    def test_line_endings(self):
        self.assertEqual(default_normalize("a\r\nb\rc\n"), "a\nb\nc\n")

    def test_trailing_ws_and_final_newline(self):
        self.assertEqual(default_normalize("a   \nb\t\t\n\n\n"), "a\nb\n")
        self.assertEqual(default_normalize(""), "")
        self.assertEqual(default_normalize("x"), "x\n")

    def test_iso_timestamp(self):
        cases = [
            "2026-08-30T12:34:56",
            "2026-08-30T12:34:56.789123",
            "2026-08-30 12:34:56",
            "2026-08-30T12:34:56Z",
            "2026-08-30T12:34:56+02:00",
        ]
        for c in cases:
            self.assertEqual(default_normalize(f"start {c} end"), "start <TS> end\n", c)

    def test_bare_date_after_timestamp(self):
        self.assertEqual(default_normalize("on 2026-08-30 we"), "on <DATE> we\n")
        # A full timestamp must NOT leave a dangling <DATE>
        self.assertEqual(default_normalize("2026-08-30T01:02:03"), "<TS>\n")

    def test_uuid(self):
        s = "req 3f2504e0-4f89-11d3-9a0c-0305e82b3391 ok"
        self.assertEqual(default_normalize(s), "req <UUID> ok\n")

    def test_hex_address(self):
        self.assertEqual(default_normalize("at 0x7ff8a1b2c3d4"), "at <ADDR>\n")
        # Short hex (e.g. colors, small ints) must survive untouched
        self.assertEqual(default_normalize("color 0xfff"), "color 0xfff\n")

    def test_duration(self):
        self.assertEqual(default_normalize("done in 0.123s"), "done in <SEC>s\n")


class MachineRuleTests(unittest.TestCase):
    def test_temp_path(self):
        p = os.path.join(tempfile.gettempdir(), "canary-xyz", "f.txt")
        self.assertIn("<TEMP>", default_normalize(f"file {p} here"))

    def test_home_path(self):
        p = os.path.join(os.path.expanduser("~"), "documents")
        self.assertIn("<HOME>", default_normalize(f"in {p}"))

    def test_home_path_slash_variant(self):
        h = os.path.expanduser("~").replace("\\", "/")
        self.assertIn("<HOME>", default_normalize(h + "/x"))

    def test_user_name(self):
        import getpass
        u = getpass.getuser()
        self.assertIn("<USER>", default_normalize(f"user={u}"))

    def test_host_name(self):
        import platform
        h = platform.node()
        if h and len(h) > 1:
            self.assertIn("<HOST>", default_normalize(f"host={h}"))


class PipelineTests(unittest.TestCase):
    def test_unknown_rule_raises(self):
        with self.assertRaises(KeyError):
            build_pipeline(["not-a-rule"])

    def test_subset_of_rules(self):
        pipeline = build_pipeline(["line-endings", "uuid"])
        out = normalize("2026-08-30 3f2504e0-4f89-11d3-9a0c-0305e82b3391", pipeline)
        # date NOT normalized (rule disabled), uuid IS
        self.assertIn("2026-08-30", out)
        self.assertIn("<UUID>", out)

    def test_noisy_program_becomes_stable(self):
        import getpass, platform, uuid as _uuid
        from datetime import datetime
        runs = set()
        for _ in range(3):
            text = (
                f"ts={datetime.now().isoformat()}\n"
                f"id={_uuid.uuid4()}\n"
                f"tmp={tempfile.mkdtemp()}\n"
                f"addr={hex(id(object()))}\n"
                f"user={getpass.getuser()} host={platform.node()}\n"
                f"done in 0.{100 + len(runs)}s\n"
            )
            runs.add(default_normalize(text))
        self.assertEqual(len(runs), 1, "normalization must collapse all nondeterminism")
        self.assertEqual(
            runs.pop().splitlines(),
            ["ts=<TS>", "id=<UUID>", "tmp=<TEMP>", "addr=<ADDR>",
             "user=<USER> host=<HOST>", "done in <SEC>s"],
        )


if __name__ == "__main__":
    unittest.main()
