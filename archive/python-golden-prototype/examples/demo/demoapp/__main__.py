"""demoapp — a tiny, boring, deterministic program used as Canary's subject.

Subcommands:
  ping                 -> "PONG" on stdout (the classic canary probe)
  greet --name NAME    -> "Hello, NAME!"
  noisy                -> deliberately nondeterministic output that the
                          normalizer pipeline must make stable
  boom                 -> stderr message, exit code 3 (nonzero exits are behavior)
  slow --secs N        -> sleeps (timeout coverage)
  version              -> prints a fixed version string
"""

import argparse
import getpass
import os
import platform
import sys
import tempfile
import time
import uuid
from datetime import datetime


def cmd_ping(_: argparse.Namespace) -> int:
    print("PONG")
    return 0


def cmd_greet(args: argparse.Namespace) -> int:
    print(f"Hello, {args.name}!")
    return 0


def cmd_noisy(_: argparse.Namespace) -> int:
    print(f"ts={datetime.now().isoformat()}")
    print(f"id={uuid.uuid4()}")
    print(f"tmp={tempfile.mkdtemp()}")
    print(f"addr={hex(id(object()))}")
    print(f"user={getpass.getuser()} host={platform.node()} home={os.path.expanduser('~')}")
    print("done in 0.123s")
    return 0


def cmd_boom(_: argparse.Namespace) -> int:
    print("demoapp: catastrophic (simulated) failure", file=sys.stderr)
    return 3


def cmd_slow(args: argparse.Namespace) -> int:
    time.sleep(args.secs)
    print("woke up")
    return 0


def cmd_version(_: argparse.Namespace) -> int:
    print("demoapp 1.0.0")
    return 0


def main(argv=None) -> int:
    # Deliberately avoid printing the platform line so output is stable:
    parser = argparse.ArgumentParser(prog="demoapp")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ping"); p.set_defaults(fn=cmd_ping)
    p = sub.add_parser("greet"); p.add_argument("--name", required=True); p.set_defaults(fn=cmd_greet)
    p = sub.add_parser("noisy"); p.set_defaults(fn=cmd_noisy)
    p = sub.add_parser("boom"); p.set_defaults(fn=cmd_boom)
    p = sub.add_parser("slow"); p.add_argument("--secs", type=float, default=5.0); p.set_defaults(fn=cmd_slow)
    p = sub.add_parser("version"); p.set_defaults(fn=cmd_version)
    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
