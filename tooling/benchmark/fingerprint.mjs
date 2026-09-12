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

/**
 * Documentation is not the instrument.
 *
 * MEASURED problem this fixes: `BENCHMARKS.md` and `RESULTS.md` used to be part of the digest, so
 * writing up a finished matrix moved the version and the NEXT trial in a running batch recorded a
 * different instrument than the ones before it — for a doc edit that changes no rule. Fixture task
 * text (`fixtures/<task>/TASK.md`) IS part of the instrument and stays in: the model reads it.
 */
const isTopLevelDoc = (dir, name, benchDir) => dir === benchDir && /\.md$/i.test(name);

/** Every file that defines the instrument: its modules, and every fixture byte. */
export function instrumentFiles(benchDir = BENCH) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      if (isTopLevelDoc(dir, e.name, benchDir)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(mjs|js|cjs|json|md|txt)$/i.test(e.name)) out.push(p);
    }
  };
  walk(benchDir);
  return out;
}

/**
 * THE PRODUCT IS PART OF THE INSTRUMENT.
 *
 * Trials do not run a description of Canary; they run `apps/cli/dist/src/main.js` — `canary setup`
 * seals the plan, the Stop hook runs `canary checkpoint`, and the verdict is the built CLI's. A
 * rebuild between two trials of the same matrix therefore changes what was measured, and the
 * fingerprint has to say so. That gap was found the honest way: while planning a rebuild during a
 * running batch, and being unable to tell from the instrument block whether the later trials ran
 * the same product as the earlier ones.
 *
 * The directory is resolved RELATIVE to the benchmark directory, so a miniature harness in a temp
 * dir has no product and its fingerprint stays comparable (see fingerprint.test.mjs).
 */
export function productFiles(benchDir = BENCH) {
  const distSrc = path.join(benchDir, '..', '..', 'apps', 'cli', 'dist', 'src');
  if (!fs.existsSync(distSrc)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(mjs|js|cjs|json)$/i.test(e.name)) out.push(p);
    }
  };
  walk(distSrc);
  return out;
}

/**
 * @returns {{ version: string, files: number, hash: string, product: {files: number, hash: string}|null, detail: Record<string, string> }}
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
  // The product enters the same digest under a `product/…` key, so a rebuilt CLI changes the
  // version exactly like an edited harness module or fixture byte does.
  let product = null;
  const pf = productFiles(benchDir);
  if (pf.length > 0) {
    const ph = crypto.createHash('sha256');
    for (const f of pf) {
      const rel = `product/${path.relative(path.join(benchDir, '..', '..'), f).split(path.sep).join('/')}`;
      const digest = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      detail[rel] = digest;
      ph.update(`${rel}\0${digest}\n`);
      h.update(`${rel}\0${digest}\n`);
    }
    product = { files: pf.length, hash: ph.digest('hex') };
  }
  const hash = h.digest('hex');
  return { version: `bench-${hash.slice(0, 12)}`, files: files.length, product, hash, detail };
}
