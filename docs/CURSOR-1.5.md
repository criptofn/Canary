# Cursor in Canary v1.5 — integration model, missing primitive, re-measurement

CURSOR: NOT SUPPORTED / NOT MEASURABLE — no Cursor install exists on this host (so no run can be produced here), and Cursor documents the completion-hook response mapping but not the input contract for hooks it imports from `.claude/settings.json`: the missing primitive is a documented `stop`-event payload carrying `cwd` and `stop_hook_active`, the two fields `cmdCheckpoint` reads.

Written 2026-09-24 against the source in this working tree, and against Cursor's
public documentation read on the same day (URLs in [Sources](#sources)). Nothing
here was produced by running Cursor, because Cursor is not installed on this host.

---

## 0. What this document is, and what the verdict means

Canary's doctrine applies to this document itself: **claims are not evidence**,
**no proof, no done**, **a SKIP is never a PASS**, and **UNMEASURED is never
MEASURED**. A vague `UNMEASURED` is not an acceptable resting place either, so
this document does three things:

1. it states the integration model that actually exists in the code, with
   `file:line` references;
2. it names the primitive that is missing, separating **what Canary has not
   implemented** from **what Cursor does not document**;
3. it records the exact procedure and the exact evidence that would move this
   state to `MEASURED` — to be run by someone who has a Cursor host.

Read the verdict word by word:

- **NOT SUPPORTED** — *by this build*: nothing in Canary writes, reads or binds
  anything Cursor-specific beyond a detection heuristic. There is no Cursor
  hook installation, no Cursor MCP registration, and no Cursor probe. A
  case-insensitive `cursor` search over `apps/` returns exactly three files — the
  capability table (`agents.ts`), the detector and table printer
  (`onboarding.ts`), and the test that pins the row (`test/agents.test.ts`);
  `packages/` returns nothing, and `tooling/probes/` contains no Cursor file
  (see §2.1–§2.5).
- **NOT MEASURABLE** — *on this host*: Cursor is absent, so no completion event,
  no hook invocation and no vendor behaviour can be observed here. See §1.
- It is **not** a statement that Cursor can never be gated. Cursor documents a
  native completion hook that can send the agent back to work (§3.1–§3.2) — more
  than the older "Cursor offers only MCP" premise assumed. It is a statement
  that Canary has neither **implemented** a Cursor binding nor **observed** one,
  and will not guess the difference.

**On this host the state is NOT MEASURABLE because Cursor is absent, and absence
of configuration is never evidence of protection.** A repository with no
`.cursor/` directory is not a protected repository; it is a repository about
which Canary knows nothing. That is also why detection is not a claim: the
Cursor row may read `not detected` here and `detected` elsewhere, and neither
word says anything about whether a completion in that repository can be
stopped.

---

## 1. Host state (measured, this machine, 2026-09-24)

Read-only probes, run from the repository root:

| Probe | Result |
|---|---|
| `Get-Command cursor` | absent from PATH |
| `Get-Command cursor-agent` | absent from PATH |
| `Get-Command agent` (the name Cursor's CLI docs use) | absent from PATH |
| `%LOCALAPPDATA%\Programs\Cursor` | does not exist |
| `%LOCALAPPDATA%\Programs\cursor` | does not exist |
| `%APPDATA%\Cursor` | does not exist |
| `%USERPROFILE%\.cursor` | does not exist |
| `C:\Program Files\Cursor` | does not exist |

Claude Code (`.claude/`) and an `.mcp.json` **do** exist in this repository, and
`canary agents` is therefore expected to report a gating Claude Code row here —
while the Cursor row stays `UNMEASURED`, because a neighbouring harness being
gated says nothing about Cursor.

One measurement caveat, recorded rather than smoothed over: the `canary` on this
machine's PATH is a **1.0.0** build that does not implement `agents`, so the v1.5
table was **not** re-observed live here; the row's shape is pinned by source
(§2.3) and by the unit test that asserts the four labels verbatim
(`apps/cli/test/agents.test.ts:84-85`). No build or suite was run for this
document, deliberately: another agent had `apps/cli/dist` mid-rebuild during
writing, and AGENTS.md forbids reading a `dist` that is being rewritten as if it
were the source.

---

## 2. The integration model as implemented

### 2.1 How Cursor is detected (and it is only detection)

```ts
// apps/cli/src/onboarding.ts:221-224
const cursor = fs.existsSync(path.join(root, '.cursor')) || hasExe('cursor');
if (cursor) {
  found.push({ name: 'cursor', label: 'Cursor', supported: false, action: 'detected, completion-gate mechanism documented by the vendor but UNMEASURED by Canary' });
}
```

- Two signals only: a `.cursor` directory at the repository root, or a `cursor`
  executable in a **trusted directory** (`hasExe`, `apps/cli/src/onboarding.ts:233-238`
  — a trusted-dir scan, deliberately never PATH, so a shim cannot decide which
  harnesses Canary reports).
- `supported: false` is what keeps Cursor out of `integrable` / `integrables`
  (`apps/cli/src/onboarding.ts:225-230`), which is the list `setup` iterates.
  Cursor is therefore **never wired**, by construction.
- The capability table entry is `apps/cli/src/agents.ts:124-131`:
  `id: 'cursor'`, `gating: false` (`:126`), `gatingMeasured: false` (`:127`),
  `detectFiles: ['.cursor']` (`:128`), `detectExe: ['cursor']` (`:129`).
- `gatingMeasured: false` is the whole point of the row and is documented at
  `apps/cli/src/agents.ts:38-47`: *"Absent means measured … `false` means the
  harness documents a mechanism that would gate, and this project has NOT
  reproduced it on a real install — so it is reported as UNMEASURED rather than
  folded into either 'yes' or 'no'. Both of those would be claims."*

### 2.2 What `canary setup` writes — and what it never writes

`setup` wires exactly two harnesses, decided by name from the integrable list:

```ts
// apps/cli/src/onboarding.ts:2525-2526
const wantsClaude = integrables.some((h) => h.name === 'claude-code');
const wantsCodex  = integrables.some((h) => h.name === 'codex');
```

There is no `wantsCursor`. The three writes that follow are the complete set of
harness surfaces this build touches:

| Surface | Written to | Where |
|---|---|---|
| Claude Code `Stop` hook | `.claude/settings.json` (`settingsPath`, `apps/cli/src/onboarding.ts:434`; entry shape `{hooks:{Stop:[{hooks:[{type:'command',command,timeout}]}]}}`, `:500-502`) | `installStopHook`, called at `:2546` |
| Codex `Stop` hook | `.codex/hooks.json` (`apps/cli/src/onboarding.ts:553`, `:564`) | `installCodexStopHook`, called at `:2548` |
| MCP server entry, key `canary` | `<root>/.mcp.json` (`MCP_CONFIG_BASENAME`, `apps/cli/src/onboarding.ts:641-643`; writer `:692-736`) | `installMcpServer`, called at `:2554` |

The ownership record has no Cursor kind either: `TouchedFile.kind` is
`'hooks' | 'mcp' | 'codex-hooks'` (`apps/cli/src/onboarding.ts:137-141`).

**Consequence for Cursor, stated precisely:**

- **No `.cursor/hooks.json` is ever written.** Cursor's own native hook file is
  untouched by Canary — which also means Canary does not get Cursor's native
  `loop_count`/`loop_limit` semantics (see §4.2).
- **No `.cursor/mcp.json` is ever written.** Canary registers its MCP server in
  `.mcp.json`, which is Claude Code's project-scope filename. Cursor documents
  **`.cursor/mcp.json`** and **`~/.cursor/mcp.json`** as its configuration
  locations ([MCP](https://cursor.com/docs/mcp.md)). So today even the
  *advisory* MCP surface is not wired for a Cursor user; this is a **Canary gap,
  not a harness limitation**, and it is the cheapest honest improvement
  available (see §5.3).

### 2.3 What the table prints, and why it cannot print anything stronger

```ts
// apps/cli/src/onboarding.ts:3805-3815
const unmeasured = i.gatingMeasured === false;
const word = i.gating ? 'GATED   ' : unmeasured ? 'UNMEASURED' : 'ADVISORY';
…
: unmeasured
  ? ` [Canary's completion hook is ${wired ? 'installed here' : 'NOT installed here'} — whether this harness honours it is UNMEASURED]`
```

Three states, never two (`apps/cli/src/onboarding.ts:3801-3817`). The same three
states travel in the `--json` envelope (`apps/cli/src/onboarding.ts:3761-3772`),
and when nothing here can gate, the verdict names the unmeasured harness rather
than implying safety (`:3819-3827`). The behaviour is pinned by
`apps/cli/test/agents.test.ts:84-85` (`cursor:UNMEASURED` in the exact label
list) and `:89-100` (a `.cursor` fixture must print `UNMEASURED Cursor —
detected` and must **never** match `GATED Cursor`).

Two precision notes a reader should have, because this document exists to
remove ambiguity rather than add it:

- The Cursor row prints the *hook* question, not the advisory question
  (`apps/cli/src/onboarding.ts:3812-3814` takes the `unmeasured` branch before
  the advisory branch), so it does **not** report whether the `AGENTS.md`
  advisory block is installed for Cursor. It can be installed —
  `canary agents install cursor` is accepted because `install` refuses only
  `gating` integrations (`apps/cli/src/onboarding.ts:3780`, against
  `gating: false` at `apps/cli/src/agents.ts:126`).
- The comment at `apps/cli/test/agents.test.ts:90-93` labels the vendor-doc
  reading "MEASURED context". What is actually measured in that test is the
  table's output; the vendor reading is a documentation citation. Flagged here
  as a wording nit, not a behaviour change — no test or gate was touched.

### 2.4 What the hook actually needs from a harness

This is the crux of the whole question, so it is stated from the code that would
have to run:

```ts
// apps/cli/src/onboarding.ts:3206-3218
export async function cmdCheckpoint(): Promise<number> {
  let input: { cwd?: string; stop_hook_active?: boolean; task?: string } = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) as typeof input; } catch { /* … */ }
  …
  const root = findRepoRoot(input.cwd ?? process.cwd());
  const cfg = root ? readConfig(root) : null;
  …
  if (!root || cfg === null) return 0; // nothing wired here — stay out of the way
```

- **Repository identity comes from `input.cwd`** (falling back to the process
  working directory).
- If no repository can be identified, the hook **returns 0 silently** — "nothing
  wired here". A completion that ends with an unidentifiable hook input is
  therefore *allowed*, not blocked. That is the documented design (absence is
  silent; damaged authority is loud, `:3195-3205`), and it is exactly why an
  unknown input payload cannot be waved through as "probably fine".
- **The one-repair loop guard is `input.stop_hook_active === true`**
  (`apps/cli/src/onboarding.ts:3242`, `:3303`, `:3346`, `:3389`): first failure →
  `{"decision":"block", reason}` (`:3246`); a failure that is *still* failing on
  the repair turn → allow with an honest `systemMessage` instead of looping.
- Pass → silence; fail → block; infra failure or unconfigured → allow with a
  truthful `systemMessage`, never a fake green (`:3195-3205`).

### 2.5 The advisory surfaces that do exist

- `canary result --json` / `canary doctor --json` — the machine-readable
  protocol, named as the neutral path for any CLI agent
  (`apps/cli/src/agents.ts:133-139`).
- The marked `AGENTS.md` block (`apps/cli/src/agents.ts:142-181`, installer
  `:198-221`), which tells the agent who owns the verdict and what to run. It is
  installed only by an explicit command, is idempotent, and is removable by one
  command.
- The MCP server (`apps/cli/src/mcp.ts:1-24`): a **transport with no authority**
  — every tool runs the same CLI and reports its verdict unchanged, and
  `canary accept` is deliberately not exposed (`apps/cli/src/mcp.ts:13-18`).
  MCP tools are model-invoked in *every* harness, Cursor included, so MCP is
  advisory by construction wherever it is wired — and for Cursor it is not
  wired at all today (§2.2).

---

## 3. What Cursor actually exposes (vendor documentation, read 2026-09-24)

### 3.1 Native hooks — and they include completion

Cursor documents a hook system of its own: `hooks.json` at the project level
(`<project>/.cursor/hooks.json`) or user level (`~/.cursor/hooks.json`), with
hooks as spawned processes exchanging JSON over stdio
([Hooks](https://cursor.com/docs/hooks.md)).

- The agent-hook list includes **`stop` — "Handle agent completion"**.
- Project hooks **run from the project root**; user hooks run from `~/.cursor/`.
- `stop` input is documented as `{ "status": "completed" | "aborted" | "error",
  "loop_count": 0 }` plus a common base payload of `conversation_id`,
  `generation_id`, `model`, `model_id`, `model_params`, `hook_event_name`,
  `cursor_version`, `workspace_roots`, `user_email`, `transcript_path`.
  **There is no `cwd` field in the `stop` payload and no `stop_hook_active`.**
- `stop` output is documented as `{ "followup_message": "<message text>" }`:
  *"When provided and non-empty, Cursor will automatically submit it as the next
  user message."* `loop_count` counts follow-ups already triggered, default cap
  `loop_limit: 5`.
- Per-script options include **`loop_limit`** (default **`5` for Cursor hooks,
  `null` for Claude Code hooks**) and **`failClosed`** (default `false`; when
  `true`, crash/timeout/non-zero-exit/no-output block the action instead of
  allowing it — *"Permission hooks block on invalid JSON or an invalid response
  even when this is `false`"*).
- Exit codes: `0` → use the JSON output; `2` → *"Block the action"*; other codes
  → *"Hook failed, action proceeds (fail-open by default)"*.
- Hook scripts receive `CURSOR_PROJECT_DIR` (always) and `CLAUDE_PROJECT_DIR`
  (an alias for project dir, "Claude compatibility"); a Hooks output channel and
  a Customize → Hooks tab exist for debugging.

### 3.2 Third-party import — the response half is documented in detail

Cursor documents loading Claude Code hooks from `.claude/settings.local.json`,
`.claude/settings.json` and `~/.claude/settings.json`, gated by **"Include
Third-Party Plugins, Skills, and Other Configs"** under Settings → Agents →
Third-Party Imports, **on by default**
([Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks.md)).

- `Stop` → `stop` is listed as **Supported: Yes**.
- For `Stop`/`SubagentStop`, *"a `decision` of `"block"` with a `reason` is
  treated as an automatic follow-up, equivalent to providing `followup_message`
  in the native Cursor format"* — i.e. **the exact response `canary checkpoint`
  already emits (`apps/cli/src/onboarding.ts:3246`) is documented as understood
  by Cursor.**
- Exit code `2` blocking is supported; both the flat and the nested Claude
  response formats are accepted.
- Under **Limitations**: `subagentStart`, **loop-limit configuration
  (`loop_limit`)**, and team/enterprise distribution are available **only in the
  native Cursor format**.
- Under troubleshooting: *"Some behavior differences may exist due to different
  execution environments. Test your hooks in both tools to ensure
  compatibility."*

This is the strongest relevant fact in the whole investigation, and it is
stronger than the current source comment assumes: Cursor does **not** merely
"document importing Claude Code hooks" in the abstract — it documents the
`Stop` mapping as supported and documents what our block response *does*. What
it does **not** document is what an imported hook **receives** (§4.2).

### 3.3 MCP, rules, run modes, CLI

- **MCP**: `.cursor/mcp.json` (project) and `~/.cursor/mcp.json` (global);
  stdio/SSE/HTTP; *"Cursor asks for approval before using MCP tools by
  default"*; MCP follows the same Run Modes as terminal commands
  ([MCP](https://cursor.com/docs/mcp.md)).
- **Instructions**: `AGENTS.md` in the project root **and in subdirectories** is
  a documented, supported alternative to `.cursor/rules`
  ([Rules](https://cursor.com/docs/rules.md)) — so Canary's advisory block is a
  real, vendor-supported surface for a Cursor user.
- **Run modes / sandbox**: Auto-review / Allowlist / Run Everything; sandboxing
  of *shell commands* (Seatbelt, Landlock+seccomp, AppArmor notes for CLI);
  `permissions.json` and `sandbox.json`; *"Auto-review is not a security
  boundary."* ([Run Modes](https://cursor.com/docs/agent/security/run-modes.md)).
- **CLI**: the headless binary is invoked as `agent` (`-p/--print`, `--force`,
  `--output-format json|stream-json|text`), installed on Windows with
  `irm 'https://cursor.com/install?win32=true' | iex`
  ([Headless CLI](https://cursor.com/docs/cli/headless.md),
  [Installation](https://cursor.com/docs/cli/installation.md)).

---

## 4. The missing primitive

### 4.1 What Canary has NOT implemented (Canary's gap, not Cursor's)

These are absences in this build. Fixing them is code work, and fixing them
**still would not** let anyone write `MEASURED`:

1. **No Cursor-native hook writer.** Nothing writes `.cursor/hooks.json`
   (§2.2). A native `stop` entry with `loop_limit` is the format that *does*
   carry a documented loop bound.
2. **No Cursor MCP registration.** Canary writes `.mcp.json`; Cursor reads
   `.cursor/mcp.json` (§2.2, §3.3). Even the advisory ask-Canary surface is
   unavailable to a Cursor user today.
3. **No Cursor probe.** `tooling/probes/` has `v14-codex-stop-hook.mjs` for
   Codex and no file mentioning Cursor; `grep -ri cursor tooling/` matches only
   recorded benchmark logs. There is no executable artefact that could produce
   the two recorded invocations §7 asks for.
4. **No setup recognition beyond detection.** `setup` prints the Cursor line
   (`apps/cli/src/onboarding.ts:2519`) and wires nothing for it
   (`:2525-2526`).

### 4.2 What the harness does NOT document (the actual missing primitive)

**The missing primitive is a documented completion-event INPUT contract for the
path Canary would actually take — a `Stop` hook loaded by Cursor from
`.claude/settings.json` — specifically the per-turn loop guard
(`stop_hook_active`) and the repository path (`cwd`).**

The asymmetry is the finding, and it is citable:

| Half of the contract | Where Cursor documents it | Status for Canary's path |
|---|---|---|
| That `Stop` is imported and mapped to `stop` | [Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks.md) — "Supported: Yes" | **Documented** |
| That `{"decision":"block","reason"}` is honoured as an automatic follow-up | Same page — *"treated as an automatic follow-up, equivalent to providing `followup_message`"* | **Documented** |
| What the hook **receives** (`cwd`, `stop_hook_active`) | Native `stop` input is documented as `{status, loop_count}` + common base — **no `cwd`, no `stop_hook_active`** ([Hooks](https://cursor.com/docs/hooks.md)); the third-party page documents **no input payload at all** | **NOT documented** |
| A loop bound Canary can rely on | `loop_limit` defaults to **`null` for Claude Code hooks**, and the option is **native-format-only** ([Hooks](https://cursor.com/docs/hooks.md), Limitations in [Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks.md)) | **Absent for this path** |

Why each field matters, from the code:

- **`cwd`** — `cmdCheckpoint` derives the repository from `input.cwd`
  (`apps/cli/src/onboarding.ts:3215`), and with no repository it **returns 0
  silently** (`:3218`). Cursor's documented project-hook working directory is
  the project root and `workspace_roots`/`CURSOR_PROJECT_DIR` exist
  ([Hooks](https://cursor.com/docs/hooks.md)), so this is *probably*
  recoverable — but "probably recoverable" is an inference about an undocumented
  payload, and the failure mode of getting it wrong is a **silent allow**, which
  is precisely the outcome this project exists to prevent. It must be observed.
- **`stop_hook_active`** — Canary's entire no-loop guarantee keys on it
  (`apps/cli/src/onboarding.ts:3242`, `:3303`, `:3346`, `:3389`). Cursor
  documents the analogue for its **native** format (`loop_count`), and documents
  that for **Claude-format** hooks the loop limit defaults to **`null`** and is
  not configurable. So if the field does not arrive on the imported path, the
  bound on Canary's repair loop is Cursor's behaviour rather than Canary's — a
  gate whose stopping condition is not the verifier's. Whether Cursor
  synthesises `stop_hook_active` for imported Claude hooks is **unconfirmed**:
  the third-party page does not say, and that page's own troubleshooting section
  answers such questions with *"Test your hooks in both tools."*

One candidate primitive can be ruled **out** on the evidence, and honesty
requires saying so: **fail-open hook handling is not the gap.** Cursor
documents `failClosed: true` as a per-script option that makes crashes,
timeouts, non-zero exits and no-output *block* the action
([Hooks](https://cursor.com/docs/hooks.md)) — and in any case Claude Code, which
Canary *does* report as `GATED`, has the same fail-open posture, so it cannot be
the discriminator between them.

So, in one sentence: **Cursor documents what it will do with Canary's answer; it
does not document what Canary's hook will be given, and it documents no loop
bound for that format** — therefore a completion gate on that path is
plausible, unproven, and unmeasurable from here.

---

## 5. What Canary does and does not claim for Cursor

### 5.1 Does claim

- Cursor is **detected** when `.cursor` exists at the repository root or a
  `cursor` executable exists in a trusted directory, and reported as
  **`UNMEASURED`** — a state that asserts neither protection nor its absence
  (`apps/cli/src/agents.ts:124-131`, `apps/cli/src/onboarding.ts:3805-3815`).
- `canary result --json` and `canary doctor --json` are available to a Cursor
  agent that runs them, exactly as to any other CLI agent.
- `canary agents install cursor` writes the marked advisory block into
  `AGENTS.md` (`apps/cli/src/agents.ts:198-221`), and Cursor documents reading
  `AGENTS.md` at the project root and in subdirectories
  ([Rules](https://cursor.com/docs/rules.md)). That block is advice, explicitly
  labelled as such, and it cannot block anything.
- New in this document: **Cursor documents `Stop` import and honours
  `{"decision":"block","reason"}` as an automatic follow-up** — a documented
  mechanism, not an observation.

### 5.2 Does NOT claim

- **That a Cursor completion can be blocked.** It is reported `UNMEASURED`; no
  evidence exists in this repository of any Cursor hook invocation.
- **That the `.claude/settings.json` hook Canary installs gates Cursor.** The
  response half is documented; the input half is not; the difference between
  those two statements is the whole point of this file.
- **That Cursor repositories are protected in any sense.** No Cursor wiring
  exists (§2.2), and absence of configuration is not protection.
- **`HARDENED` for Cursor — or for anything.** `HARDENED` is produced only by a
  boundary measurement in which every control is observed available, and the
  provider that would establish it is implemented but not installed, so no
  harness in this build reaches it (`docs/CAPABILITY-LEVELS.md:10`, `:41-50`).
  Cursor is therefore not special here, and Cursor's own confinement story
  (Run Modes, shell sandboxing, and Cursor's own statement that *"Auto-review is
  not a security boundary"*, [Run Modes](https://cursor.com/docs/agent/security/run-modes.md))
  is not the reason for the `UNMEASURED` state. The completion gate is.
- **Nothing about a machine without Cursor.** The verdict here is about this
  host's ability to measure; it is not evidence about Cursor installs elsewhere.

### 5.3 The cheapest honest improvements (not done here)

Recorded so the next owner does not have to re-derive them, and none of them is
a measurement: write `.cursor/mcp.json` as well as `.mcp.json` (or instead of it,
per harness) so a Cursor user can *ask*; teach `setup` to install the advisory
block when Cursor is the detected harness; and report the advisory state on the
unmeasured row. Each is a code change that must ship with the same
`UNMEASURED` word attached, because none of them observes Cursor.

---

## 6. Re-measurement procedure (run this on a host that HAS Cursor)

Deterministic, reviewable, and safe to fail — if Cursor is absent, the probe
must print **`SKIP`**, and a `SKIP` is never a PASS.

### 6.1 Confirm the host first (read-only)

```powershell
Get-Command agent, cursor-agent, cursor -ErrorAction SilentlyContinue | Select-Object Name, Source
agent --version                      # Cursor's CLI; `cursor-agent` on older installs
Test-Path "$env:USERPROFILE\.cursor"
```

If none of these resolves, stop: the state on that host is **NOT MEASURABLE**,
exactly as it is here, and nothing may be upgraded on the strength of a
neighbouring harness.

### 6.2 Build the scratch repository (never this one)

```powershell
$probe = Join-Path $env:TEMP ("cursor-probe-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $probe | Out-Null
Set-Location $probe
git init
# a project whose DECLARED check fails on the current bytes (a failing test in its own suite)
canary setup --yes
canary agents                        # expect: GATED Claude Code [hook installed here …]
                                     #         UNMEASURED Cursor — … whether this harness honours it is UNMEASURED
```

### 6.3 Capture what Cursor actually sends

The imported path reads `.claude/settings.json`, so add a **second** `Stop`
handler whose command is a small committed fixture script that appends its
stdin to a file and exits 0 — Canary's own entry keeps running, and the raw
payload is on disk afterwards. The future probe should ship that fixture at
`tooling/test-support/fixtures/` and drive the whole journey from
`tooling/probes/v15-cursor-stop-hook.mjs`, following the Codex precedent
(`tooling/probes/v14-codex-stop-hook.mjs`): fixtures created under
`fs.mkdtempSync(os.tmpdir(), …)`, `PASS`/`FAIL`/`SKIP` lines only, exit 0 only
when everything passed.

### 6.4 Drive a real completion, both ways — and record the raw bytes

```powershell
# failing case: the sealed check must still fail when Cursor says it is done
agent -p --force "Make one small edit in this repository, then stop."

# passing case: fix the failing check, then let Cursor finish again
agent -p --force "Fix the failing test, then stop."
```

Do the same once in the **IDE** (open the scratch repo in Cursor, let the agent
finish a turn): the hooks documentation was written for the IDE agent loop, and
headless `-p` coverage of `stop` is exactly one of the things to confirm rather
than assume.

### 6.5 Read the captured payload for the four answers

1. Does the hook run at all on a Cursor completion (IDE **and** `agent -p`)?
2. Which fields arrive — `cwd`? `stop_hook_active`? `workspace_roots`?
   `loop_count`? `hook_event_name`? (Raw JSON, quoted verbatim in the report.)
3. On failure, does Canary's `{"decision":"block","reason"}` produce an observed
   automatic follow-up in which the agent continues **with Canary's reason**?
4. On the repair turn, does the loop terminate the way Canary intends — and how
   many times did Cursor re-fire before it stopped?

---

## 7. What evidence would move this to MEASURED

The bar is the same one Codex had to clear, and nothing weaker:

1. **Two recorded hook invocations on a real Cursor install — one allowed, one
   blocked** — with the **raw stdin** Cursor supplied and the **raw stdout**
   `canary checkpoint` returned, stored as files (not prose).
2. **The field question answered from those bytes**, not from documentation: is
   `stop_hook_active` present, and is `cwd`/`workspace_roots` sufficient for
   `cmdCheckpoint` to identify the repository? If the guard field is absent, the
   honest outcome is either a documented Canary-side adaptation (with its own
   evidence) or a continued `UNMEASURED` — never a `GATED` row resting on the
   vendor's response mapping.
3. **An observed loop, bounded**: a persistently failing check, driven through
   Cursor, that ends with Canary's own honest stop (`systemMessage`, allow)
   rather than an unbounded follow-up storm — remembering that `loop_limit`
   defaults to `null` on this format.
4. **A re-runnable probe** in `tooling/probes/` that reproduces all of the above
   and prints an explicit `SKIP` where Cursor is absent — so the next host
   measures rather than guesses.

Until those artefacts exist, the words stay `UNMEASURED`, and `apps/cli/src/agents.ts:126-127`
stays `gating: false, gatingMeasured: false`. The forbidden move is the one this
document exists to make impossible: reading a vendor page about a mechanism and
writing `GATED` on the strength of it.

---

## 8. What could NOT be confirmed

- **Whether Cursor synthesises `cwd` and `stop_hook_active` for hooks imported
  from `.claude/settings.json`.** The third-party hooks page documents the
  response mapping and no input payload; the native page documents a different
  input shape. Unconfirmed, and load-bearing (§4.2).
- **Whether `stop` fires in headless `agent -p`.** The docs describe hooks on
  the agent loop and state that `workspaceOpen` "runs in the Cursor desktop app
  and CLI"; they do not state `stop` coverage per surface.
- **Whether exit code `2` blocks a `stop`.** "Exit code 2 from command hooks
  blocks the action" is stated generally on both pages, while `stop`'s own
  output table lists only `followup_message` and the `stop` event is absent from
  the list of hooks Cursor documents as blocking on an invalid response. Two
  readings are possible; only a host can settle it.
- **The exact wording of a prior claim**: `docs/V1.3-PRODUCT-AUDIT.md:289-291`
  states agents "can modify workspace files without approval" and that no
  documented way exists to remove Cursor's native tools. Nothing in the hooks,
  MCP, rules or run-modes pages I read contradicts that (the sandbox there
  governs *shell commands*, and `afterFileEdit` exists precisely because the
  agent edits files), but I did not find a page that states it positively
  either, so it remains a reading of absence rather than a confirmed statement.
- **Stale cross-reference, for whoever edits next**: `docs/V1.4-GAP-AUDIT.md:110`
  cites `apps/cli/src/agents.ts:86-92` for Cursor; after the v1.4 Codex entry
  that range is the Codex comment, and the Cursor entry is at `:112-131`. That
  file was **not** edited for this document (out of scope by instruction).

---

## Sources

All read 2026-09-24.

- Cursor — Hooks: <https://cursor.com/docs/hooks.md>
- Cursor — Third Party Hooks (Claude Code compatibility): <https://cursor.com/docs/reference/third-party-hooks.md>
- Cursor — Model Context Protocol: <https://cursor.com/docs/mcp.md>
- Cursor — Rules and `AGENTS.md`: <https://cursor.com/docs/rules.md>
- Cursor — Run Modes and sandboxing: <https://cursor.com/docs/agent/security/run-modes.md>
- Cursor — Headless CLI: <https://cursor.com/docs/cli/headless.md>
- Cursor — CLI installation: <https://cursor.com/docs/cli/installation.md>

Repository evidence relied on: `apps/cli/src/agents.ts:38-47,112-131,133-181,198-221`;
`apps/cli/src/onboarding.ts:137-141,221-238,434,500-502,553,564,641-643,692-736,2519,2525-2526,2546-2555,3195-3218,3242,3246,3303,3346,3389,3761-3772,3780,3801-3827`;
`apps/cli/src/mcp.ts:1-24`; `apps/cli/test/agents.test.ts:84-100`;
`docs/CAPABILITY-LEVELS.md:10,41-50`; `docs/V1.3-PRODUCT-AUDIT.md:282-315`;
`docs/V1.4-GAP-AUDIT.md:107-149`; `README.md:418-423`; `docs/TROUBLESHOOTING.md:31`;
`docs/RELEASE-1.4.md:98-103`; `tooling/probes/v14-codex-stop-hook.mjs` (the precedent).
