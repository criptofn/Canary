/**
 * Terminal provider for the human-acceptance act — one source of truth for
 * `pre10-acceptance.mjs` and `f3-acceptance-growth.mjs`.
 *
 * `canary accept` refuses unless BOTH `process.stdin.isTTY` and
 * `process.stdout.isTTY` are true (apps/cli/src/candidate.ts). The strongest
 * way to exercise that is a REAL pty, which on POSIX means util-linux
 * `script -qec`. Windows has no `script(1)`, so the probes used to fail there
 * with `status: null` — and a `null` status is a host limitation wearing the
 * costume of a product failure.
 *
 * Measured on this host (`tooling/probes/tty-capability.mjs` prints the
 * evidence): `winpty.exe` from Git for Windows exists but refuses to run
 * without a console of its own ("stdin is not a tty"), and with
 * `-Xallow-non-tty` it aborts on its own assertion
 * (`cols > 0 && rows > 0`) because a console-less parent has no size to hand
 * it; `script` is absent; WSL has `script` but no `node` inside the distro.
 * So there is NO drivable real pty here.
 *
 * What this module does about that — and what it deliberately refuses to do:
 *
 *   - If a real pty program IS resolvable, use it. Every acceptance assertion
 *     then runs at full strength and `provenRealPty` is true.
 *   - Otherwise, do NOT skip the product behaviour on the floor. Drive the SAME
 *     exported command through the repo's in-process terminal driver
 *     (`accept-review-driver.mjs`, the mechanism `architecture-closure.mjs`
 *     already uses on Windows), so every product assertion still executes and a
 *     real regression still fails the probe.
 *   - Report `provenRealPty: false` so the caller prints an EXPLICIT
 *     host-bound SKIP and exits 3: the OS-level pty allocation is NOT proven
 *     here, and a SKIP is never allowed to read as a PASS.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** util-linux `script`, resolved absolutely (never a bare PATH lookup at spawn). */
export function findScript() {
  const r = process.platform === 'win32'
    ? spawnSync('where', ['script.exe'], { encoding: 'utf8', timeout: 15_000 })
    : spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8', timeout: 15_000 });
  const first = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (r.status !== 0 || first === undefined) return null;
  // Only a real file; a shell builtin/alias or a missing target is not a pty tool.
  try { return fs.statSync(first).isFile() ? first : null; } catch { return null; }
}

const shellQuote = (a) => `"${String(a).replace(/"/g, '\\"')}"`;

/**
 * @param {{ repo: string, cli: string, driver?: string }} o
 * @returns {{ kind: string, provenRealPty: boolean, skipReason: string|null,
 *             run: (cwd: string, args: string[], input: string) => { status: number|null, stdout: string|null, stderr: string|null } }}
 */
export function createTerminal({ repo, cli, driver }) {
  const driverPath = driver ?? path.join(repo, 'tooling', 'test-support', 'fixtures', 'accept-review-driver.mjs');
  const script = findScript();

  if (script !== null) {
    return {
      kind: 'pty-script',
      provenRealPty: true,
      skipReason: null,
      run(cwd, args, input) {
        const cmd = `${process.execPath} ${cli} ${args.map(shellQuote).join(' ')}`;
        return spawnSync(script, ['-qec', cmd, '/dev/null'], { cwd, encoding: 'utf8', timeout: 120_000, input });
      },
    };
  }

  if (!fs.existsSync(driverPath)) {
    throw new Error(`no real pty on this host AND the in-process terminal driver is missing: ${driverPath}`);
  }
  return {
    kind: 'in-process-tty-driver',
    provenRealPty: false,
    skipReason: 'no drivable real pty on this host (util-linux script(1) absent; winpty needs a console it '
      + 'cannot get here) — the acceptance act below ran through the repo\'s in-process terminal driver '
      + '(isTTY set, the exact gate the product checks), so the PRODUCT assertions executed, but the '
      + 'OS-level pty allocation itself is NOT proven on this host',
    run(cwd, args, input) {
      const name = args[args.length - 1];
      const typed = String(input ?? name).replace(/\r?\n$/, '');
      return spawnSync(process.execPath, [driverPath, cli, 'none', typed, name],
        { cwd, encoding: 'utf8', timeout: 120_000 });
    },
  };
}
