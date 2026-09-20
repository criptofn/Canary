---
name: Bug report
about: Something Canary did that it should not have, or failed to do that it should have
title: ''
labels: bug
assignees: ''
---

<!--
Before you post: `canary doctor` answers most questions, and
docs/TROUBLESHOOTING.md lists every failure that has actually been observed.

Please do NOT paste source code, test output, or logs. The four commands below
produce small, machine-readable answers that NAME the files holding the full
evidence, so a maintainer can diagnose without you attaching anything large.
-->

## What happened

<!-- One or two sentences. What did you expect, and what did Canary do instead? -->

## Which of these is it?

<!-- Tick one. The distinction matters: this project treats them very differently. -->

- [ ] **False pass** — Canary said a change was verified when it was not. *(highest priority)*
- [ ] **False block** — Canary blocked a completion that was genuinely fine.
- [ ] **Wrong verdict** — the wording or status does not match the situation.
- [ ] **Setup / wiring** — install, `setup`, `doctor`, `uninstall`, or the hook.
- [ ] **Agent integration** — the hook does not fire, or the wrong harness is reported.
- [ ] **Crash / unclear error** — a message that does not say what to do.
- [ ] **Something else**

## Diagnostics

Run these and paste the output. Every one of them is safe to share: they contain
no source code.

```sh
canary --version
canary status --json
canary doctor --json
canary agents
```

<details>
<summary>canary --version</summary>

```
paste here
```

</details>

<details>
<summary>canary status --json</summary>

```json
paste here
```

</details>

<details>
<summary>canary doctor --json</summary>

```json
paste here
```

</details>

<details>
<summary>canary agents</summary>

```
paste here
```

</details>

## Environment

| | |
|---|---|
| OS and version | <!-- e.g. Windows 11 24H2, macOS 15.2, Ubuntu 24.04 --> |
| Node version (`node --version`) | |
| Canary version (`canary --version`) | |
| Agent / harness (and version) | <!-- e.g. Claude Code 2.1.268, Codex CLI 0.154.0 --> |
| How Canary was installed | <!-- npm tarball / npm registry / single executable --> |
| Project type | <!-- e.g. Node with npm, Python with pytest, Makefile-only, monorepo --> |

## If it is a false pass

The one thing worth quoting in full:

- The change that was made (a one-line description is enough — not the diff).
- What Canary said (`doctor`'s verdict and status word).
- What was actually true.

## Does it reproduce on a second, unrelated repository?

<!--
Yes / No / Not tried. A false pass that reproduces only in one repository is a
different (and still important) finding from one that reproduces everywhere.
-->
