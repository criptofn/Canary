#!/usr/bin/env node
/**
 * v1.4 — the ONE fact `tooling/standalone.mjs` needs before it can build, kept
 * in its own module so a deterministic, model-free test can pin it.
 *
 * WHY THIS IS SEPARATE FROM standalone.mjs: that script IS the build. Importing
 * it runs it (top-level `await build(...)`, a 100 MB spawn, a fixture repo), so
 * a predicate exported from there can never be exercised by a test without
 * performing a real distribution build. The rule this module encodes is small,
 * load-bearing and was WRONG in CI for two releases, so it is exactly the kind
 * of thing that must be covered by a test rather than by a comment.
 *
 * MEASURED SOURCE OF TRUTH: Node's documentation records the flag as
 * "Added in: v25.5.0 — Added built-in single executable application generation
 * via the CLI flag `--build-sea`"
 * (https://nodejs.org/api/single-executable-applications.html, History table,
 * read 2026-09-20). Below that version node rejects `--build-sea` as an unknown
 * option: it prints nothing and exits 9, which is the least useful failure this
 * repository produced — the CI job "standalone" pinned `node-version: 22`, so
 * all three of its legs failed for two releases with `FAIL: node --build-sea
 * failed (status 9)` and no explanation.
 *
 * This is a DISTRIBUTION-BUILD requirement, NOT a runtime one: the CLI still
 * supports Node >= 22 (`engines`), and the platform-neutral npm tarball
 * (`node tooling/pack.mjs`) needs only Node 22+.
 */

/** The oldest Node that provides the single-step `--build-sea` flag. */
export const MIN_SEA_NODE = '25.5.0';

/**
 * Does this Node provide `--build-sea`? Pure, total and deterministic: it reads
 * only the version string it is given, so it can be tested without spawning
 * anything and cannot be influenced by PATH, cwd or the environment.
 */
export function seaCapable(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  const [minMajor, minMinor] = MIN_SEA_NODE.split('.').map((n) => Number.parseInt(n, 10));
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * The refusal text, so the requirement and the remedy are stated the same way
 * wherever they appear (WHAT HAPPENED / WHY DOES IT MATTER / WHAT TO DO).
 */
export function seaRequirement(version = process.versions.node) {
  return `this Node cannot build a single executable — ${version} does not provide \`--build-sea\`.\n`
    + `  \`--build-sea\` was added in Node v${MIN_SEA_NODE}; on an older runtime node rejects it as an\n`
    + '  unknown option, prints no reason and exits 9, so the artifact could never be produced here.\n'
    + `  Run \`npm run standalone\` on Node >= ${MIN_SEA_NODE} (the CI job "standalone" pins a Node that has it),\n`
    + '  or use the platform-neutral npm tarball: `node tooling/pack.mjs` (needs Node 22+).\n'
    + '  The CLI itself still runs on Node >= 22 — this requirement is for the DISTRIBUTION BUILD only.';
}
