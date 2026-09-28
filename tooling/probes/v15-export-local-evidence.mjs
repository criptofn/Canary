#!/usr/bin/env node
/** Keep raw pilot evidence outside Git while recording every copied byte. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const sources = [
  ['invalid-pilot', arg('invalid')], ['paired-pilot', arg('pilot')],
  ['preflight', arg('preflight')], ['preparation-summary.json', arg('preparation')],
  ['guidance-preflight', arg('guidance-preflight')], ['guidance-runs', arg('guidance-runs')],
  ['guidance-oracles', arg('guidance-oracles')], ['guidance-package.tgz', arg('package')],
];
const out = arg('out') ? path.resolve(arg('out')) : null;
if (!out || fs.existsSync(out) || sources.some(([, source]) => !source || !fs.existsSync(source))) {
  console.error('FAIL: provide all evidence paths and a new --out directory');
  process.exit(2);
}
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function files(root, relative = '') {
  if (fs.statSync(root).isFile()) return [''];
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error(`refused symlink: ${path.join(root, relative, entry.name)}`);
    const next = path.join(relative, entry.name);
    return entry.isDirectory() ? files(root, next) : [next];
  });
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-v15-evidence-export-'));
const stageRelative = path.relative(os.tmpdir(), stage);
if (!stageRelative || stageRelative.startsWith('..') || path.isAbsolute(stageRelative)) throw new Error('temporary export is outside the OS temp directory');
try {
  const manifest = { schema: 'canary-v15-local-evidence-export/1', exportedAt: new Date().toISOString(), files: [] };
  for (const [name, sourceArg] of sources) {
    const source = path.resolve(sourceArg);
    const destination = path.join(stage, name);
    fs.cpSync(source, destination, { recursive: fs.statSync(source).isDirectory(), errorOnExist: true, force: false });
    for (const relative of files(source)) {
      const original = fs.readFileSync(relative ? path.join(source, relative) : source);
      const copied = fs.readFileSync(relative ? path.join(destination, relative) : destination);
      if (sha256(original) !== sha256(copied)) throw new Error(`copy hash differs: ${name}/${relative}`);
      manifest.files.push({ path: path.join(name, relative).replaceAll('\\', '/'), sha256: sha256(original), bytes: original.length });
    }
  }
  fs.writeFileSync(path.join(stage, 'export-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.renameSync(stage, out);
  console.log(`PASS exported ${manifest.files.length} verified raw evidence files to ${out}`);
} finally {
  if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
}
