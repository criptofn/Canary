# Night Runner evidence — retention contract

**Rule: a report's evidence paths must resolve inside the repository.**
`NO PROOF, NO DONE` applies to the evidence *layer* too: an unattended run
whose RED/GREEN/mutant/probe logs exist only in an ephemeral directory is not
auditable, and a green `git status` around missing evidence is not "clean".

The independent 2026-09-05 audit of the F6 night run proved this by
mechanical failure: the report cited `.night-run/*.log`, but `.night-run/`
is per-worktree scratch, never tracked by git, and its ignore lived only in
the builder's local `.git/info/exclude`. Another worktree or a fresh clone
of the same commit contained **none** of the cited evidence.

## Convention

1. `.night-run/` is scratch (git-ignored, not shared between worktrees).
   Writes there during a run are fine.
2. **Before recording DONE**, every evidence file a report cites must be
   copied into `docs/night-evidence/<UTC-date>-<slug>/` (this directory) and
   the report must cite the `docs/` path, not the `.night-run/` path.
   `cp .night-run/<f> docs/night-evidence/<slug>/<f>` — no tooling needed.
3. The evidence commit and the report commit must be the same or adjacent;
   a report citing `docs/night-evidence/...` paths that are not in
   `git ls-files` is not done.
4. Re-derivations and corrections (post-audit) go in the same directory,
   prefixed so the original attempt-1 logs stay byte-identical.

## Contents

- `2026-09-05-F6/` — night-run F6 attempt-1 (starting SHA `34cf515`,
  five fixes, final HEAD `d327e71`), exported post-audit plus re-derivation
  logs. Index: `2026-09-05-F6/DONE` and
  `docs/NIGHT-F6-HARDENING-2026-09-05.md` (errata section records what was
  wrong in attempt 1).
