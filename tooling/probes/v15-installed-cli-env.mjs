import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Measurement only: give both pilot arms the same explicitly installed CLI. */
export function installedCliEnvironment(cli, env, toolchains = []) {
  const packageRoot = path.dirname(path.dirname(cli));
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
  assert.equal(pkg.name, '@canary-rn/cli'); assert.equal(pkg.bin?.canary, 'dist/main.js');
  assert.equal(fs.realpathSync.native(path.join(packageRoot, pkg.bin.canary)), fs.realpathSync.native(cli));
  const bin = path.resolve(packageRoot, '../../.bin');
  for (const name of process.platform === 'win32' ? ['canary', 'canary.cmd', 'canary.ps1'] : ['canary']) {
    assert.ok(fs.statSync(path.join(bin, name), { throwIfNoEntry: false })?.isFile(), 'installed package aliases required; no global fallback');
  }
  const ambient = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH')),
    PATH: [bin, path.dirname(process.execPath), ...toolchains, ambient].join(path.delimiter) };
}
