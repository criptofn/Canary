#!/usr/bin/env node
/**
 * PRINT THE DIGEST `canary bind` / `canary.proofs` NEED FOR A STATED REQUIREMENT.
 *
 * A binding is keyed by the material digest of the requirement TEXT (trimmed, internal whitespace
 * collapsed), so authoring a fixture — or an operator preparing a `package.json canary.proofs` /
 * `canary.project.json proofs` block by hand — needs that digest before the project is set up. The
 * product prints it too (`canary task --requirement "…"`), and this utility is the offline form of
 * the same function, so the two can never disagree: it imports the SAME `materialDigest`.
 *
 * Usage:
 *   node tooling/probes/requirement-digests.mjs "the result is lower-case" "…"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { materialDigest, canonicalText } = await import(`file://${path.join(REPO, 'apps', 'cli', 'dist', 'src', 'authorization.js').replace(/\\/g, '/')}`);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node tooling/probes/requirement-digests.mjs "<requirement text>" ["…"]');
  process.exit(2);
}
for (const a of args) {
  console.log(`${materialDigest(a)}  "${canonicalText(a)}"`);
}
process.exit(0);
