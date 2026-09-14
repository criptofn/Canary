'use strict';
/** KNOWN-GOOD solution: the combined-short-flag rule, with every existing behaviour preserved. */
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
      // A short argument without `=` is a cluster: each character is its own flag, in order.
      for (const flag of body) out[flag] = true;
      continue;
    }
  }

  return out;
}

const KNOWN = new Set(['long', 'name', 'verbose', 'dry-run', 'force', 'tag']);

module.exports = { parseFlags };
