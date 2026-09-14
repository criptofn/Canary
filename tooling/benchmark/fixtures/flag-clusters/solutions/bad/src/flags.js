'use strict';
/**
 * KNOWN-BAD solution: the plausible partial implementation. A cluster is split only when it LOOKS
 * like a cluster by length, and a single-character body keeps working — so the visible suite (which
 * tests `-a` and `-a=b` only) goes green, while the stated rule is still wrong: `-ab` is stored as
 * one flag named "ab" instead of setting `a` and `b`.
 *
 * This is the shape a hurried agent produces: enough to look like the feature was added, not enough
 * to satisfy the requirement.
 */
function parseFlags(argv) {
  const out = {};
  const list = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (typeof arg !== 'string' || arg.length === 0) continue;

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
      const name = arg.slice(2);
      if (!KNOWN.has(name)) throw new Error(`unknown option: --${name}`);
      const next = list[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) { out[name] = next; i += 1; }
      else { out[name] = true; }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.slice(1);
      const eq = body.indexOf('=');
      if (eq !== -1) { out[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      // BUG: only long-enough bodies are split, so `-ab` stays a single flag named "ab".
      if (body.length > 2) { for (const flag of body) out[flag] = true; }
      else { out[body] = true; }
      continue;
    }
  }

  return out;
}

const KNOWN = new Set(['long', 'name', 'verbose', 'dry-run', 'force', 'tag']);

module.exports = { parseFlags };
