/**
 * THE INSTRUMENT FINGERPRINT.
 *
 * WHY: a benchmark number is meaningless without knowing which instrument produced it. This
 * harness has already corrected four measurement bugs; two of those corrections changed how
 * PAST trials would be scored, and the honest handling of that is to mark the old data with
 * the instrument that produced it rather than to rewrite history. So every trial record and
 * every report carries an `instrument` block:
 *
 *   { version: 'bench-<12 hex>', files: N, hash: '<64 hex>' }
 *
 * The version is a content digest of the HARNESS ITSELF (every module in this directory)
 * plus every FIXTURE (project files, hidden oracles, task text, fixture metadata). Changing a
 * prompt, an oracle, a fixture or the verdict logic therefore changes the version, and any
 * result can be attributed to the exact instrument that produced it.
 *
 * `results/` and `scratch/` are excluded on purpose: they are the instrument's OUTPUT, and
 * including them would make the fingerprint change every time a trial ran.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BENCH = path.resolve(import.meta.dirname);
const EXCLUDE_DIRS = new Set(['results', 'scratch', 'node_modules', '.git']);

/** Every file that defines the instrument: its modules, and every fixture byte. */
export function instrumentFiles(benchDir = BENCH) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(mjs|js|cjs|json|md|txt)$/i.test(e.name)) out.push(p);
    }
  };
  walk(benchDir);
  return out;
}

/**
 * @returns {{ version: string, files: number, hash: string, detail: Record<string, string> }}
 */
export function instrumentFingerprint(benchDir = BENCH) {
  const files = instrumentFiles(benchDir);
  const detail = {};
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const rel = path.relative(benchDir, f).split(path.sep).join('/');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    detail[rel] = digest;
    h.update(`${rel}\0${digest}\n`);
  }
  const hash = h.digest('hex');
  return { version: `bench-${hash.slice(0, 12)}`, files: files.length, hash, detail };
}
