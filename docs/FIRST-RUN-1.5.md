# First run, 1.5 — the clean-room journey, its friction, and what changed

**Workstream 4 of the v1.5 "Evidence Release".** Everything below was executed on this host
(Windows, PowerShell 7, Node v26.7.0, npm 11.19.0) on **2026-09-24**, against the built
`apps/cli/dist/` as it stood (`canary 1.4.0`). No output in this document is reconstructed,
paraphrased or inferred: each one was printed by the command shown above it.

> **HARD CONSTRAINT OBSERVED — the artifact was NOT rebuilt.** `npm run build`, `npm test`,
> `npm exec tsc` and `verify:productization` were not run (a benchmark is measuring the built
> `dist/` concurrently). Consequence, stated plainly and carried through this document: the
> five source-side improvements in §4 are **in source and NOT in the measured artifact**.
> `tooling/probes/v15-first-run.mjs` reports each of them as `PENDING-REBUILD … NOT a pass`,
> never as a pass. They become measurable the moment someone runs `npm run build`.

## 1. How the journey was run

The journey used **only public user documentation** — `README.md`, `docs/TROUBLESHOOTING.md`,
`AGENTS.md` and the installed `--help` — to decide what to type. The implementation was opened
afterwards, only to quote the source of a message and to make a fix.

The artifact under test is the **real installed one**, not a checkout: the built CLI was packed
(bundling the existing `dist/`, no TypeScript rebuild) and installed into a private temp prefix.

```powershell
cd C:\Users\Johannes\Desktop\canary
node tooling/pack.mjs                      # -> pack\npm\canary-rn-cli-1.4.0.tgz
$root = Join-Path $env:TEMP 'v15-cleanroom'
npm install -g .\pack\npm\canary-rn-cli-1.4.0.tgz --prefix "$root\prefix"
& "$root\prefix\canary.cmd" --version      # canary 1.4.0
```

The scratch repository (`%TEMP%\v15-cleanroom\repo`, **never** the Canary repo) is a small Node
project whose declared check is `npm run test` → `node --test greeting.test.cjs`, with the
**user's own agent configuration pre-seeded** so that `uninstall` has something to preserve:
a Claude `Stop` hook plus a permission, a Codex `Stop` hook, and an unrelated MCP server.

`git status` was clean before setup, and reported exactly this after it:

```
 M .claude/settings.json
 M .codex/hooks.json
 M .mcp.json
```

`.canary/` does not appear: `.canary/.gitignore` contains `*` (`git check-ignore -v` confirms
`.canary/.canary.local.json` ← `.canary/.gitignore:1:*`).

## 2. The journey as executed

### 2.1 `install`

`canary --version` → exit `0`, `canary 1.4.0`. `README.md` says `canary 1.3.0`; the README's own
"Honest version note" (README.md:86-94) already covers that this tree is the 1.4 candidate.

`canary --help` → **exit `3`**, and after the help text it prints a status footer for the current
directory:

```
NOT CONNECTED — C:\Users\Johannes\AppData\Local\Temp\v15-cleanroom\repo is a git repository but Canary was never set up here — no config, no hooks, no proof.
next: when you want protection here: canary setup --yes
```

**Measurement honesty note.** My first reading of this was `exit 1`; that was an artefact of my own
`… | Select-Object -First 60`, which kills the child mid-write. Re-measured without truncation, via
both the `canary.cmd` shim and `node <bundle>`, the exit code is **3** — README's "misuse" code.
The same is true for a bare `canary` (no arguments): exit 3, full help, same footer. Nothing here
is a product defect claim based on the truncated run.

### 2.2 `setup`

```
$ canary setup --yes          # exit 0
repo: C:\Users\Johannes\AppData\Local\Temp\v15-cleanroom\repo
package manager: npm (no lockfile found — defaulted to npm)
verification plan (from what this project already declares — Canary runs only your own checks; change them in their own files):
  ✓ tests: npm run test
harness: Claude Code — hook installed into this project
harness: OpenAI Codex CLI — Stop hook installed into this project (.codex/hooks.json) — Codex runs a project hook only after you review and trust it once (/hooks), so an untrusted hook gates nothing
Claude Code will run Canary automatically when the agent finishes a turn here.
OpenAI Codex CLI will run Canary when a turn ends here — the Stop hook is in .codex\hooks.json.
  Codex will NOT run it until you review and trust it once: run `codex` in this project, then `/hooks`, and trust the Canary Stop hook. Until you do, a Codex completion is NOT gated.
both harnesses are wired here: Claude Code gates completions as soon as this setup ends; Codex gates them once you trust the hook above.
agent tools: registered in .mcp.json — your agent can now ask Canary whether it is done, instead of guessing. Your other MCP servers are untouched; `canary uninstall` removes exactly this entry.
  Claude Code asks you to approve a project's MCP server once — run `claude` there and approve it; until then the server is listed but its tools are not available.

smoke test (running your own project scripts):
✓ tests: npm run test (exit 0)

READY — Canary is active here: it will run these checks whenever the AI agent says it is done, and will interrupt the human only when something needs them.
next: try it: break a test on purpose and let the agent finish — Canary will say so. doctor: canary doctor
```

The wiring it wrote (all three files merged, never overwritten):

```json
// .claude/settings.json  (user's own hook and permissions kept)
"hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "echo user-own-stop-hook" } ] },
                     { "hooks": [ { "type": "command",
                                    "command": "node \"…\\prefix\\node_modules\\@canary-rn\\cli\\dist\\main.js\" checkpoint",
                                    "timeout": 1800 } ] } ] }
// .codex/hooks.json      (same command + statusMessage "Canary is running this project's sealed checks")
// .mcp.json              (mcpServers.canary + the user's own mcpServers.someoneelse, untouched)
```

### 2.3 Agent integration, state

`canary agents` → exit 0 (`GATED Claude Code [hook installed here, agent tools registered]`,
`GATED OpenAI Codex CLI [… one-time review and trust …]`, `UNMEASURED Cursor — not detected`,
`ADVISORY Any command-line agent`) and `CONNECTED — … (OpenAI Codex CLI gates once the hook is
trusted.)`. `canary status` → `CONNECTED`, `last checkpoint: pass (setup) … a past run, NOT a claim
about now`. `canary doctor` → exit 0, `READY — wiring verified; the checks just ran and passed`.

### 2.4 First normal task → verified completion

Change: `greeting()` trims its argument, plus a test that fails without that change
(`greeting('  Ada  ') === 'Hello, Ada!'`). Driven exactly as the harness drives it — the hook JSON
on stdin, contract at `apps/cli/src/onboarding.ts:3195-3234`:

```powershell
'{"cwd":"…\\repo","stop_hook_active":false,"task":"trim whitespace in greeting()"}' | canary checkpoint
```

**Result: exit 0, stdout empty (0 bytes).** That silence is the documented "nothing needed" signal
and the allow. It was not a no-op: `.canary/last-checkpoint.json` recorded
`{"at":"2026-09-24T04:35:02.202Z","status":"pass","failed":[],"source":"checkpoint"}`, and a new
`.canary/evidence/2026-09-24T04-35-01-451Z-checkpoint/` bundle was written.

### 2.5 The **failed** completion

Same procedure, with the sealed check broken (`hello, …` instead of `Hello, …`):

```
$ '{"cwd":"…\\repo","stop_hook_active":false,"task":"add a lowercase greeting"}' | canary checkpoint
exit 0
{"decision":"block","reason":"Canary verification failed: tests (npm run test, exit 1). Fix this before finishing.\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  actual: 'hello, Ada!',\n  full output: C:\\Users\\Johannes\\AppData\\Local\\Temp\\v15-cleanroom\\repo\\.canary\\evidence\\2026-09-24T04-35-13-706Z-checkpoint\\tests.log"}
```

- exit **0** as the contract requires; the decision is `block` — the agent gets one repair turn.
- names the failing check: **yes** (`tests (npm run test, exit 1)`).
- prints an evidence path: **yes**, and the file exists (1898 bytes) and contains the full runner
  output, including `✖ greeting greets by name (1.2797ms)` and `✖ greeting trims the name (…ms)`.
- names the **failing test** in the payload itself: **no** — only the assertion text. See F4.

Loop guard (`stop_hook_active: true`, still broken): exit 0,

```
{"systemMessage":"Canary: checks still failing (tests) after one repair attempt — stopping anyway; a human should look."}
```

The human's own view, `canary doctor` on the same tree: exit **2**, `NEEDS ATTENTION — wiring is
good, but the checks just failed (tests) — your code is talking, not Canary.` + `next: fix the
failing checks (ask the agent), then: canary doctor`. It printed a 12-line tail of the runner
output — stack frames from `node:internal/test_runner` — with the failing test's **name** cut off,
and **no evidence path**, although the bundle
`.canary/evidence/2026-09-24T04-35-37-784Z-doctor/` had been written. `--verbose` changes nothing
here (identical 17 lines, exit 2).

### 2.6 Repair → second completion

Restored `Hello, …`: `canary checkpoint` → exit 0, empty stdout, and
`last-checkpoint.json` = `{"at":"…04:35:44.228Z","status":"pass",…,"source":"checkpoint"}`.

### 2.7 Uninstall

```
$ canary uninstall          # exit 0
removed 3 Canary hook entries; every other settings entry was kept (content preserved — re-serialization may reformat whitespace).

READY — Canary is fully removed from this repo.
next: to bring it back: canary setup
```

Verified afterwards: the user's own Claude `Stop` hook and `permissions.allow` intact, the user's
own Codex hook intact, `.mcp.json` holding only `someoneelse`, `.canary` gone, and
`.codex/hooks.json` byte-identical to its committed form (only `.claude/settings.json` and
`.mcp.json` show as modified, from re-serialization — disclosed by uninstall and by README.md:210-212).

## 3. Friction points

Every one is something a normal user would ask "what am I supposed to do now?" about. "Fixed"
means the source is changed; see §4 for the artifact caveat.

| # | Step / command | What a user would not know | Proposed fix | Status |
|---|---|---|---|---|
| F1 | `canary --help`, bare `canary` | The help exits **3** ("misuse", README.md:681-686) and appends a per-directory status footer. `canary --help && echo ok` never echoes ok; a wrapper that treats non-zero as failure reports Canary as broken while helping. | Print help with exit 0; keep the status footer for the bare invocation (that is genuinely a state answer), or drop it from `--help`. | **NOT changed** — this is the CLI's documented exit-code contract and needs an owner decision, not a wording edit. |
| F2 | `setup`, `agents` | Nothing answers **"is this Canary config mine, or the project's?"** `.mcp.json`, `.claude/settings.json` and `.codex/hooks.json` are tracked PROJECT files; `.canary/` is self-ignored and local; the recorded hook command holds an absolute path valid only on the machine that ran setup. | One sentence each in `setup` and `agents`, naming which files are project-scoped and which are local. | **Fixed** (4C) |
| F3 | Codex trust step (`setup` line 2652 pre-fix) | It said *what to type* (`/hooks`) but not **what is being approved**, **what Canary changes / does not change**, or **how to undo it** — the three questions a person asks before approving a hook that can interrupt their agent. | Two sentences in `setup`, plus the same three answers in the `canary agents` row. | **Fixed** (4B) |
| F4 | `checkpoint` block payload on a failing `node --test` | README.md:119-120 promises the message "names the check and the failing test". Measured: the check is named, the **test is not** — because `node --test`'s default spec reporter prints `✖ title (1.2ms)`, a shape `extractFailureIdentities` did not know (TAP `not ok`, mocha `1)`, pytest `FAILED`, `file :: title` were covered). The agent pays a turn to open the log. | Add the spec-reporter shape to `extractFailureIdentities` (`failure-payload.ts`), duration-anchored so the `✖ failing tests:` heading is not mistaken for an identity. Display-only path: it runs after the verdict and cannot change one. | **Fixed** (4D) |
| F5 | `canary doctor` on a failing tree | TROUBLESHOOTING.md:84-85 tells the reader "the full runner output is written to disk and **its path is printed** — read that file, not the summary". Measured: no path is printed; the reader gets a blind 12-line tail (stack frames) with the failing test's name cut off. The bundle exists on disk the whole time. | Print the bundle directory in doctor's failure block (the function already returns it). | **Fixed** (4D) |
| F6 | Loop-guard `systemMessage` | It says "a human should look" and names no action. TROUBLESHOOTING.md:8 says "First, always: `canary doctor`". | Append `Run: canary doctor`. | **Fixed** (4D) |
| F7 | `setup` with a registered requirement Canary reads as **subjective** | `setup` ended in `READY — Canary is active here` with an open registered duty and **no mention of it**; the immediately following `canary doctor` answered `NOT PROVEN` with 2 unproven duties. AGENTS.md:177-178 promises "`canary setup` prints the same note" — it does for objective requirements (the probe asserts it) and was suppressed for subjective ones. | A truthful note in the subjective branch: the requirement cannot be reported PROVEN, and `canary doctor` prints the exact next step. No exit code, verdict or gate changes. | **Fixed** (4D) |
| F8 | `setup` when `.canary` is a **file** (store unwritable) | Exit 3 via the last-resort handler: `what happened: ENOTDIR … mkdir '…\.canary\backups'`, `what it means: this run verified NOTHING …`. Honest, but `what to do:` was only *collect diagnostics and report a bug* — the repair (the named path is a file where a directory is needed, or unwritable) was never suggested, and the dedicated "make `<store.root>` writable … then run setup again" message (`onboarding.ts:2624`) is not reached by this input. | Add the fix-first clause to the handler's `what to do:`; leave the routing alone until the dedicated path has its own measured repro. | **Fixed** (4D, wording only) |
| F9 | `canary status` with a corrupt config | Correct and honest (`NOT CONNECTED — Canary's local config (.canary/canary.local.json) is unreadable.`), but the footer reads `next: run: canary setup --yes (…)` — a doubled verb. | Cosmetic; leave the message shape alone unless the owner wants the prefix handling changed. | **NOT changed** |
| F10 | after `uninstall` | `git status` shows `.claude/settings.json` and `.mcp.json` modified although every Canary entry is gone (JSON re-serialization). | Already disclosed twice (uninstall's own line, README.md:210-212). | **NOT changed** (correctly documented) |
| F11 | `setup` output | `.codex\hooks.json` (Windows backslashes) sits in prose that otherwise uses `/hooks` and `.mcp.json`. | Cosmetic path-separator normalization. | **NOT changed** |

Positive results worth recording, because they are the product's core promises and they held:
a discriminating change was allowed in **silence**; a broken check produced **exactly one**
`block` decision that named the check; the loop guard held after one repair attempt; the repair
was allowed; **uninstall preserved every one of the user's own entries** (deep JSON equality) and
removed exactly Canary's three; the corrupt-config path never pretended to verify
(`UNVERIFIED … nothing was verified`); an unbound requirement made doctor answer `NOT PROVEN`
(exit 2) rather than a fake green.

## 4. What changed, and what deliberately did not

Changed (source only — see the PENDING-REBUILD caveat at the top):

| File | Change | Friction |
|---|---|---|
| `apps/cli/src/onboarding.ts` | `setup`: what the Codex trust step approves + how to undo it (2 lines); `setup`: scope line (project vs local); `doctor`: prints the evidence bundle path on failure; loop-guard hand-off names `canary doctor`; subjective-unbound note in `setup` | F2, F3, F5, F6, F7 |
| `apps/cli/src/agents.ts` | `gatingNeedsTrust`: what you approve, what changes, how to undo (rides the `GATED` row and the `agents` note) | F3 |
| `apps/cli/src/onboarding.ts` (`cmdAgents` footer) | one `scope:` line: project files vs local state | F2 |
| `apps/cli/src/failure-payload.ts` | `extractFailureIdentities` learns `node --test`'s spec-reporter shape | F4 |
| `apps/cli/src/main.ts` | last-resort handler's `what to do:` also names the fixable-path repair | F8 |
| `tooling/probes/v15-first-run.mjs` | **new** — the whole journey + all five first-run error paths as a regression probe | 4E |
| `docs/FIRST-RUN-1.5.md` | this document | — |

**Deliberately NOT changed**

- **`canary --help` exit 3** (F1): a documented contract in `README.md:681-686`; changing it is an
  owner decision, not a first-run wording fix.
- **F9, F10, F11**: cosmetic or already-disclosed; changing them buys nothing a user can act on.
- **The dedicated unwritable-store message** (`onboarding.ts:2624`) was left as-is: my input reaches
  the last-resort handler instead, so rerouting it would be an unmeasured change.
- **Two sibling hand-off messages** (`onboarding.ts:3262` authority drift, `3322` unmet obligation)
  have the same "a human should look" shape as F6. Only the one I measured (the failing-checks
  path, now line 3411) was changed. Same class, no measurement, no edit.
- **Verification semantics of every kind**: no assertion, threshold, timeout, exit code, fail-closed
  path or verdict word was touched. In particular the changes to `failure-payload.ts` are on the
  display path *after* the verdict (the module's own contract), and the note added for F7 does not
  alter `READY`'s meaning or the `NOT PROVEN` outcome it describes.

**Rejected as gate-weakening (do not do these).**

- Making `setup` print `READY` only when no duty is open. It would move a *verdict* into the wiring
  command and duplicate `doctor`'s job; the honest fix is the note in F7.
- Turning the probe's four `PENDING-REBUILD` lines into passes. They are source-side changes the
  measured artifact predates; they become assertions only after a real `npm run build`.
- Relaxing anything in `extractFailureIdentities`' caps (`MAX_IDENTITIES_PER_CHECK`,
  `MAX_TOTAL_CHARS`) to fit more failure text into the payload — that is the token-cost control
  measured by `tooling/probes/checkpoint-payload.mjs`.

## 5. Is Canary's configuration local to me, or shared with the project?

Answerable without reading source, from `canary setup` / `canary agents` (after §4) and from
`git status` (measured in §1):

| What | Where | Scope | Why |
|---|---|---|---|
| Claude `Stop` hook | `.claude/settings.json` | **PROJECT — shared** | tracked file; merging, never overwriting, the user's own entries |
| Codex `Stop` hook | `.codex/hooks.json` | **PROJECT — shared** | tracked file; gates nothing until `/hooks` trust |
| Agent tool server | `.mcp.json` | **PROJECT — shared** | tracked file; the harness asks each user to approve it once |
| Config, evidence, last checkpoint | `.canary/` | **LOCAL to this machine** | `.canary/.gitignore` is `*`, so git never sees it |
| "Sealed authority copy" | per-machine trust store (`CANARY_TRUST_STORE` overrides) | **LOCAL to this user** | outside the repository |

Because the recorded hook command contains an **absolute path to this machine's Canary install**,
`canary setup --yes` is per-developer, not once-per-repository: a teammate who receives the
committed entries must run it once so the path matches their machine. Canary never writes to a
user's personal agent configuration.

## 6. Reproduce it

```powershell
# 0. the artifact: pack the EXISTING dist (no rebuild) and install it into a clean prefix
cd C:\Users\Johannes\Desktop\canary
node tooling/pack.mjs
$root = Join-Path $env:TEMP 'v15-cleanroom'
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
npm install -g .\pack\npm\canary-rn-cli-1.4.0.tgz --prefix "$root\prefix"
$canary = "$root\prefix\canary.cmd"

# 1. the whole journey + every first-run error path, asserted (exits 0 only if all pass)
node tooling\probes\v15-first-run.mjs

# 2. or by hand: a scratch repo with the user's OWN agent config already in place
$repo = "$root\repo"; New-Item -ItemType Directory $repo | Out-Null
# … package.json {scripts:{test:"node --test greeting.test.cjs"}}, greeting.cjs, greeting.test.cjs,
# … .claude/settings.json (own Stop hook + a permission), .codex/hooks.json (own hook), .mcp.json (own server)
cd $repo; git init -q; git add -A; git -c user.name=Op -c user.email=op@localhost commit -qm init
& $canary setup --yes                    # READY, wiring written and merged
& $canary agents; & $canary status; & $canary doctor

# a change the sealed checks can discriminate -> allowed, in silence
'{"cwd":"' + ($repo -replace '\\','\\') + '","stop_hook_active":false,"task":"trim input"}' | & $canary checkpoint

# break the project's own check -> one block decision, exit 0, evidence path printed
'{"cwd":"' + ($repo -replace '\\','\\') + '","stop_hook_active":false,"task":"lowercase"}' | & $canary checkpoint
& $canary doctor --verbose               # NEEDS ATTENTION, exit 2

# repair, re-run (silent allow), then remove exactly Canary's own entries
& $canary uninstall
git -C $repo status --short              # the user's hook/permissions/MCP server survived
```

The probe prints `SURFACE:` (installed tarball vs built `dist`), one `PASS`/`FAIL` line per
assertion, `PENDING-REBUILD` lines for the source-side improvements the artifact predates, and a
summary; it removes its fixtures on success and keeps them for inspection on failure.
