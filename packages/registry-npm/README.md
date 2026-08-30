# @canary-rn/registry-npm (reserved — not yet implemented)

Planned home for npm-registry resolution helpers: version existence checks,
`gitHead`/repository metadata for specs, and (later) resolution-window
(`--before`) computation from release dates.

**Why it is empty:** the golden fixture path currently validates candidate
versions directly from `node_modules` after the swap (a stronger guarantee
than registry metadata — we trust the installed artifact, not the registry's
claim). Building speculative registry queries now would violate the v0.1
discipline in docs/ADR-001. This package is added when a real need lands
(e.g. second verification domain, or spec preflight UX).
