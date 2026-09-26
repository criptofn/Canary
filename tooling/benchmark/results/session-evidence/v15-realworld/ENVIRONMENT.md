# WS5 host + environment log (facts only, every line from a command that was run)

Session host: Windows, PowerShell 7 (`pwsh`). Canary CLI under measurement:
`C:\Users\Johannes\Desktop\canary\apps\cli\dist\src\main.js` — **built artifact used as-is**
(`LastWriteTime` 2026-09-23 02:10:08, `canary --help` self-reports **canary 1.4.0**). No build,
no test run and no `verify:productization` was executed in the Canary repository during this
session, per the workstream constraint.

Scratch root for every copy: `C:\Users\Johannes\Desktop\canary-ws5-scratch\`.
No write of any kind was made inside the three source repositories (verified afterwards:
identical HEADs, and neither `.canary/` nor `.mcp.json` exists in any of them).

## Toolchain actually found on this host

| tool | where | note |
|---|---|---|
| node | `C:\Program Files\nodejs\node.exe` | |
| npm | `C:\Program Files\nodejs\npm.ps1` | |
| java / javac | `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\` | JDK 21.0.12.1 LTS |
| gradle | **not on PATH** | found at `C:\Users\Johannes\.gradle\wrapper\dists\gradle-8.13-bin\5xuhj0ry160q40clulazy9h7d\gradle-8.13\bin\gradle.bat` (Gradle 8.13), added to PATH for the runs in this session |
| python | `C:\Users\Johannes\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe` (3.11.9) | |
| python3 | **only the Microsoft Store alias stub** (`%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe`) | `python3 -V` prints the "Python wurde nicht gefunden" store message |
| sh / bash | **not on PATH** | present at `C:\Program Files\Git\usr\bin\sh.exe` from Git for Windows |
| git | `C:\Program Files\Git\cmd\git.exe` | |
| claude | `C:\Users\Johannes\.local\bin\claude.exe` | Claude Code 2.1.278 |

## Remediations this session had to perform (all outside the measured repositories)

1. `refactron`'s 580-test suite needs `python3` (hard-coded in
   `src/verify/checks/syntax-python.ts:14`). A relocatable copy of the machine's own
   CPython 3.11.9 was staged at
   `C:\Users\Johannes\Desktop\canary-ws5-scratch\python311\` (`robocopy` of
   `C:\Users\Johannes\Tools\Python311`, then `python.exe` copied to `python3.exe`, which is
   exactly how the CPython Windows installer ships `python3.exe`) and prepended to PATH.
2. `refactron`'s `runners-run` / `mutation` / `gates-tests` suites spawn `sh`. Git for
   Windows' `C:\Program Files\Git\usr\bin` was prepended to PATH.
3. `refactron`'s `testsGate` fixtures run `pytest`; `pytest 9.1.1` and `requests` were
   installed into the staged Python (`python3 -m pip install pytest requests`).
4. `refactron`'s `npm ci` fails on Windows *before installing anything usable*:
   its `prepare` script is `git config core.hooksPath .githooks 2>/dev/null || true`, a
   POSIX-shell line that `cmd.exe` cannot run (`npm error command failed … || true`,
   exit 1). `node_modules` was in fact fully populated (262 entries, `vitest`/`esbuild`/
   `typescript`/`eslint` present), so the failure is the post-install script only.
5. `Hermes_Agent`'s `package.json` declares no `test`/`typecheck`/`build` script, so
   `canary setup` discovered nothing. An **operator act** added one line —
   `"test": "node scripts/smoke-test.js"` — declaring the smoke script the project
   *already ships* under the conventional name. No new check was authored. Committed in
   the copy as `7d0eb49c46d83184638fa093b44a15222feb8c51`.
6. `schniedelsmp.net` ships no `gradlew` wrapper and no `gradle` on PATH; Gradle 8.13
   was put on PATH for `canary setup`, which then pinned its **absolute** path.

## The measured consequence of Canary's sanitized step environment

`tooling/probes/v15-realworld-gate-env.mjs` (run on this host) makes this MEASURED rather
than inferred. A fixture project whose own declared `test` script dumps the environment it
was handed shows, for the sealed step:

```
PATH = <7 × node_modules/.bin>;C:\Program Files\nodejs\node_modules\npm\node_modules\@npmcli\run-script\lib\node-gyp-bin;C:\Program Files\nodejs;C:\WINDOWS\System32;C:\WINDOWS
```

12 PATH entries against the invoking shell's 29, and — measured, program by program —
`python`, `python3`, `sh`, `bash`, `java`, `git` and `gradle` are **invisible to the step
even when they are on the shell's PATH**. `JAVA_HOME` is absent;
`USERPROFILE`/`HOME` are redirected to `%TEMP%\isolated-home`.

That is deliberate product design (`apps/cli/src/project.ts:386`: "a step child gets
`sanitizedEnv` — PATH limited to the Node install dir plus the OS dirs"), and it is the
single reason two of the three repositories in this workstream could not be gated on this
host: `refactron`'s suite shells out to `python3`/`sh`, and `schniedelsmp`'s Gradle build
needs `java`.
