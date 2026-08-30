import os
import sys
import tempfile
import unittest

from helpers import REPO_ROOT, write  # noqa: F401

from canary.config import ConfigError, find_config, load_config

VALID = """
[canary]
normalizers = ["line-endings", "uuid", "trailing-ws"]

[[check]]
name = "ping"
argv = ["{python}", "-c", "print('PONG')"]
timeout = 10

[[check]]
name = "boom"
cmd = "{python} -c \\"import sys; sys.exit(4)\\""
"""


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = write(os.path.join(self.dir.name, "canary.toml"), VALID)

    def test_valid_load(self):
        cfg = load_config(self.path)
        self.assertEqual([c.name for c in cfg.checks], ["ping", "boom"])
        self.assertEqual(cfg.checks[0].argv[0], sys.executable)
        self.assertEqual(cfg.rule_names, ["line-endings", "uuid", "trailing-ws"])
        self.assertTrue(cfg.baseline_dir.startswith(os.path.abspath(self.dir.name)))
        self.assertEqual(len(cfg.raw_hash), 64)

    def test_config_hash_stable_and_sensitive(self):
        h1 = load_config(self.path).raw_hash
        h2 = load_config(self.path).raw_hash
        self.assertEqual(h1, h2)
        other = write(os.path.join(self.dir.name, "b", "canary.toml"), VALID + "\n[[check]]\nname='extra'\nargv=['x']\n")
        self.assertNotEqual(load_config(other).raw_hash, h1)

    def test_missing_both_cmd_argv(self):
        bad = write(os.path.join(self.dir.name, "bad", "canary.toml"),
                    "[[check]]\nname='x'\n")
        with self.assertRaises(ConfigError):
            load_config(bad)

    def test_both_cmd_and_argv(self):
        bad = write(os.path.join(self.dir.name, "bad2", "canary.toml"),
                    "[[check]]\nname='x'\ncmd='a'\nargv=['a']\n")
        with self.assertRaises(ConfigError):
            load_config(bad)

    def test_duplicate_names(self):
        bad = write(os.path.join(self.dir.name, "bad3", "canary.toml"),
                    "[[check]]\nname='x'\nargv=['a']\n[[check]]\nname='x'\nargv=['b']\n")
        with self.assertRaises(ConfigError):
            load_config(bad)

    def test_unknown_normalizer(self):
        bad = write(os.path.join(self.dir.name, "bad4", "canary.toml"),
                    "[canary]\nnormalizers=['bogus-rule']\n[[check]]\nname='x'\nargv=['a']\n")
        with self.assertRaises(ConfigError):
            load_config(bad)

    def test_no_checks(self):
        bad = write(os.path.join(self.dir.name, "bad5", "canary.toml"), "[canary]\n")
        with self.assertRaises(ConfigError):
            load_config(bad)

    def test_invalid_toml(self):
        bad = write(os.path.join(self.dir.name, "bad6", "canary.toml"), "not = = toml")
        with self.assertRaises(ConfigError):
            load_config(bad)

    def test_bad_timeout(self):
        bad = write(os.path.join(self.dir.name, "bad7", "canary.toml"),
                    "[[check]]\nname='x'\nargv=['a']\ntimeout=-1\n")
        with self.assertRaises(ConfigError):
            load_config(bad)

    def test_find_config_explicit_missing(self):
        with self.assertRaises(ConfigError):
            find_config(os.path.join(self.dir.name, "nope.toml"), self.dir.name)

    def test_find_config_default(self):
        found = find_config(None, self.dir.name)
        self.assertEqual(os.path.normcase(found), os.path.normcase(self.path))

    def test_env_and_stdin_parse(self):
        raw = ("[[check]]\nname='x'\nargv=['a']\nstdin='hello'\n"
               "env={ FOO='bar' }\n")
        p = write(os.path.join(self.dir.name, "env", "canary.toml"), raw)
        cfg = load_config(p)
        self.assertEqual(cfg.checks[0].stdin, "hello")
        self.assertEqual(cfg.checks[0].env, {"FOO": "bar"})


if __name__ == "__main__":
    unittest.main()
