#!/usr/bin/env node
/** Preserve preparation logs and full worker changes, including committed changes. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const arg = (key) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? null : process.argv[i + 1]; };
const evidence = arg('evidence'), out = arg('out');
assert.ok(evidence && out && path.isAbsolute(evidence) && path.isAbsolute(out) && !fs.existsSync(out));
const read = (file) => JSON.parse(fs.readFileSync(path.join(evidence, file), 'utf8'));
const summary = read('summary.json'), preparation = read('preparation-summary.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(out, 'archive-instrument.mjs'));
fs.copyFileSync(path.join(evidence, 'preparation-summary.json'), path.join(out, 'preparation-summary.json'));
fs.cpSync(path.join(preparation.outRoot, 'preflight'), path.join(out, 'preflight'), { recursive: true });
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args[0]} failed`); return r.stdout ?? '';
};
for (const record of summary.sessions) {
  const before = read(`${record.name}-before.json`), repo = record.cwd;
  const targetRoot = path.join(out, record.name); fs.mkdirSync(targetRoot);
  fs.writeFileSync(path.join(targetRoot, 'baseline-to-worker.diff'), git(repo, 'diff', '--binary', before.head), { flag: 'wx' });
  fs.writeFileSync(path.join(targetRoot, 'git-history.txt'), git(repo, 'log', '--format=fuller', '--all'), { flag: 'wx' });
  const files = new Set([...git(repo, 'diff', '--name-only', before.head).trim().split('\n'),
    ...git(repo, 'ls-files', '--others', '--exclude-standard').trim().split('\n'),
    'package.json', 'build.gradle.kts', '.canary/canary.local.json', '.claude/settings.json', '.mcp.json'].filter(Boolean));
  for (const file of files) {
    const relative = path.relative(repo, path.resolve(repo, file)); assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
    const source = path.join(repo, relative); if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    const target = path.join(targetRoot, 'files', relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  }
}
const note = arg('note'); if (note) fs.writeFileSync(path.join(out, 'operator-note.txt'), `${note}\n`, { flag: 'wx' });
const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, file)).isFile()).sort();
fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${files.map((file) => `${hash(fs.readFileSync(path.join(out, file)))}  ${file.replaceAll('\\', '/')}`).join('\n')}\n`, { flag: 'wx' });
console.log(`PASS archived ${files.length} files, ${summary.sessions.length} worker states; ${out}`);
