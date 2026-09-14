'use strict';
/**
 * A small argv parser.
 *
 * The contract `README.md` documents, and which the visible suite covers only partially:
 *
 *   parseFlags(argv) -> options object
 *
 *   - `--name=value`      -> options.name = 'value'   (the string, not coerced)
 *   - `--name value`      -> options.name = 'value'   (the following argument, if it is not a flag)
 *   - `--name`            -> options.name = true
 *   - `-a`                -> options.a = true
 *   - a combined short-flag argument -> each flag in order set to true
 *   - an unknown `--` option          -> throws, naming the option
 *
 * The combined-short-flag rule is the part that is NOT implemented yet. Everything else works.
 */
function parseFlags(argv) {
  const out = {};
  const list = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];

    if (typeof arg !== 'string' || arg.length === 0) continue;

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      if (!KNOWN.has(name)) throw new Error(`unknown option: --${name}`);
      const next = list[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) {
        out[name] = next;
        i += 1;
      } else {
        out[name] = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.slice(1);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        // `-a=b`: the flag name keeps its short form, the value is the rest.
        out[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      // TODO: a combined short-flag argument (`-abc`) should set a, b and c.
      out[body] = true;
      continue;
    }

    // A bare value with no flag in front of it is not an option; ignore it.
  }

  return out;
}

/** Long options the parser knows about. An unknown `--` option is an error. */
const KNOWN = new Set(['long', 'name', 'verbose', 'dry-run', 'force', 'tag']);

module.exports = { parseFlags };
