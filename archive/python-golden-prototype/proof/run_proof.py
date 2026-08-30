"""End-to-end regression proof for Canary. The primary milestone.

Builds a disposable workspace from examples/demo, then drives the real
`canary` CLI as subprocesses through the full lifecycle:

  1. list    -> CLI is wired up
  2. record  -> golden baseline written
  3. verify  -> PASS (proof holds)
  4. verify  -> PASS again (reproducible; also proves the noisy check is stable)
  5. inject a regression (greet breaks)
  6. verify  -> FAIL, names exactly the drifted check, others still ok
  7. restore -> verify PASS (proof recovers; no state corruption)
  8. intentional change (ping improves) + accept -> verify PASS (ratchet)
  9. tamper with the baseline file directly -> verify FAIL (defense in depth)

Exit code 0 means every step behaved exactly as expected. Nothing here is
mocked: the same binaries a user would run are run for real.

Usage:  python proof/run_proof.py [--keep]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_SRC = os.path.join(REPO_ROOT, "examples", "demo")
DEMOAPP_MAIN = os.path.join("demoapp", "__main__.py")

STEPS = []
FAILED = False


def step(title):
    def deco(fn):
        STEPS.append((title, fn))
        return fn
    return deco


def canary(ws, *args):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT
    env.pop("PYTHONHOME", None)
    proc = subprocess.run(
        [sys.executable, "-m", "canary", *args],
        cwd=ws, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=180,
    )
    return proc


def expect(cond, msg, ctx=""):
    if not cond:
        raise AssertionError(f"{msg}\n{ctx}")


def patch_file(path, old, new):
    text = open(path, "r", encoding="utf-8").read()
    expect(old in text, f"patch target not found in {path}: {old!r}")
    open(path, "w", encoding="utf-8", newline="\n").write(text.replace(old, new))


@step("list shows the configured checks")
def s_list(ws):
    p = canary(ws, "list")
    expect(p.returncode == 0, "list should exit 0", p.stdout + p.stderr)
    for name in ("canary-online", "greet-alice", "noisy-stable"):
        expect(name in p.stdout, f"list missing {name}", p.stdout)


@step("record writes a baseline")
def s_record(ws):
    p = canary(ws, "record")
    expect(p.returncode == 0, "record should exit 0", p.stdout + p.stderr)
    bpath = os.path.join(ws, ".canary", "baseline.json")
    expect(os.path.isfile(bpath), "baseline.json missing")
    # Content check: a baseline of empty/error output must never masquerade
    # as a proof. (Guards the whole exercise — exit codes alone can lie.)
    b = json.load(open(bpath, encoding="utf-8"))
    c = b["checks"]
    expect(c["canary-online"]["stdout"].strip() == "PONG", "bad ping golden", c["canary-online"])
    expect(c["canary-online"]["exit_code"] == 0, "ping golden exit not 0", c["canary-online"])
    expect(c["greet-alice"]["stdout"].strip() == "Hello, Alice!", "bad greet golden", c["greet-alice"])
    expect(c["version"]["stdout"].strip() == "demoapp 1.0.0", "bad version golden", c["version"])
    expect(c["boom-exits-3"]["exit_code"] == 3, "boom golden exit not 3", c["boom-exits-3"])
    expect("<TS>" in c["noisy-stable"]["stdout"] and "<UUID>" in c["noisy-stable"]["stdout"],
           "noisy golden not normalized", c["noisy-stable"])


@step("verify passes on a clean world (regression proof holds)")
def s_verify(ws):
    p = canary(ws, "verify")
    expect(p.returncode == 0, "verify should exit 0", p.stdout + p.stderr)
    expect("REGRESSION PROOF: PASS" in p.stdout, "missing PASS verdict", p.stdout)


@step("verify is reproducible (run twice, same verdict, noisy check stable)")
def s_reverify(ws):
    p1, p2 = canary(ws, "verify"), canary(ws, "verify")
    expect(p1.returncode == 0 and p2.returncode == 0, "re-verify must pass",
           p1.stdout + p2.stdout)


@step("injected regression is detected, isolated, and named")
def s_drift(ws):
    patch_file(os.path.join(ws, DEMOAPP_MAIN),
               'print(f"Hello, {args.name}!")',
               'print(f"Goodbye, {args.name}.")')
    p = canary(ws, "verify")
    expect(p.returncode == 1, "drifted verify should exit 1", p.stdout + p.stderr)
    expect("REGRESSION PROOF: FAIL" in p.stdout, "missing FAIL verdict", p.stdout)
    data = json.loads(canary(ws, "verify", "--json").stdout)
    by = {c["name"]: c["status"] for c in data["checks"]}
    expect(by["greet-alice"] == "DRIFT", "greet-alice should be DRIFT", json.dumps(by))
    for clean in ("canary-online", "version", "boom-exits-3", "noisy-stable"):
        expect(by[clean] == "MATCH", f"{clean} should stay MATCH", json.dumps(by))


@step("restoring the source restores the proof")
def s_restore(ws):
    shutil.copytree(DEMO_SRC, ws, dirs_exist_ok=True)
    p = canary(ws, "verify")
    expect(p.returncode == 0, "restored verify should exit 0", p.stdout + p.stderr)


@step("intentional change ratchets via accept")
def s_accept(ws):
    patch_file(os.path.join(ws, DEMOAPP_MAIN), 'print("PONG")', 'print("PONG!")')
    expect(canary(ws, "verify").returncode == 1, "pre-accept verify should fail")
    a = canary(ws, "accept", "canary-online")
    expect(a.returncode == 0, "accept should exit 0", a.stdout + a.stderr)
    v = canary(ws, "verify")
    expect(v.returncode == 0, "post-accept verify should pass", v.stdout + v.stderr)
    b = json.load(open(os.path.join(ws, ".canary", "baseline.json"), encoding="utf-8"))
    expect(b["checks"]["canary-online"]["stdout"] == "PONG!\n", "golden not updated", b)
    expect(b["checks"]["greet-alice"]["stdout"] == "Hello, Alice!\n",
           "unrelated golden changed!")


@step("hand-tampered baseline is caught")
def s_tamper(ws):
    bpath = os.path.join(ws, ".canary", "baseline.json")
    b = json.load(open(bpath, encoding="utf-8"))
    b["checks"]["version"]["stdout"] = "demoapp 9.9.9\n"
    json.dump(b, open(bpath, "w", encoding="utf-8"), indent=2, sort_keys=True)
    p = canary(ws, "verify")
    expect(p.returncode == 1, "tampered golden should fail verify", p.stdout + p.stderr)
    expect("version" in p.stdout and "DRIFT" in p.stdout,
           "tampered check should be named", p.stdout)


def main():
    global FAILED
    parser = argparse.ArgumentParser(description="Canary end-to-end regression proof")
    parser.add_argument("--keep", action="store_true", help="keep the workspace for inspection")
    args = parser.parse_args()

    ws = tempfile.mkdtemp(prefix="canary-proof-")
    if not args.keep:
        import atexit
        atexit.register(shutil.rmtree, ws, True)

    # Fresh disposable copy of the demo subject (baseline dir excluded).
    shutil.copytree(DEMO_SRC, ws, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".canary", "__pycache__"))
    print(f"workspace: {ws}")
    print(f"canary:    {os.path.join(REPO_ROOT, 'canary')}")
    print("=" * 72)

    for i, (title, fn) in enumerate(STEPS, 1):
        try:
            fn(ws)
            print(f"STEP {i}: {title} ... OK")
        except AssertionError as e:
            FAILED = True
            print(f"STEP {i}: {title} ... FAILED\n  {e}")
        except Exception as e:  # noqa: BLE001 — proof must report, not crash
            FAILED = True
            print(f"STEP {i}: {title} ... CRASHED\n  {e!r}")

    print("=" * 72)
    verdict = "FAIL" if FAILED else "PASS"
    print(f"E2E REGRESSION PROOF: {verdict} ({len(STEPS) - (1 if FAILED else 0)}/{len(STEPS)} steps)")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
