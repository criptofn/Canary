# Canary repo rules

## Verification workflow authoring (binding for every agent, including spawned ones)

Do not use inline interpreters (`node -e`, `python -c`, `bash -c` with generated
code, PowerShell `-Command` snippets) for multi-step Canary verification. Add or
use a dedicated local probe or test runner instead:

- One-off or scripted verification: `tooling/probes/<purpose>.mjs`, invoked as
  `node tooling/probes/<purpose>.mjs` — deterministic, self-cleaning, explicit exit code.
- Shared fixture programs for tests: `tooling/test-support/fixtures/` (plain files
  referenced by absolute path, e.g. from package.json scripts inside test repos).
- The whole productization surface verifies through ONE command:
  `npm run verify:productization`. Prefer it over assembling ad-hoc chains.

Rationale: this is a workflow-quality rule, not a hook-evasion rule. Since the
2026-09-06 structural classifier, HoldTheGoblin decides from what the shell will
EXECUTE — trigger strings inside quoted arguments, commit messages, or search
patterns are inert data and need no approval. The goal is NOT "avoid strings
that upset HoldTheGoblin" (never reword honest descriptions for that). The goal
is: probes are deterministic, self-cleaning, reviewable artifacts; snippets are
not. Real inline interpreter execution still requires a human — that boundary
stands. If a command is genuinely ambiguous to the parser, the hook asks; fix
the structure or write the probe, do not reshape the text to hide intent.

Probe conventions: create fixtures only under the OS temp dir (`fs.mkdtempSync`),
never write outside controlled test scope; print `PASS`/`FAIL` lines; exit 0 only
when everything passed.
