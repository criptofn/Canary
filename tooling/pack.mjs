#!/usr/bin/env node
/**
 * M1 PACKAGING — produces the distributable Canary tarball (gpv.10).
 *
 * esbuild (devDep, never shipped) bundles the compiled dist into ONE
 * self-contained ESM file named main.js. The name is load-bearing: the CLI
 * derives its own entry path as path.join(dirname(import.meta.url), 'main.js')
 * (CLI_ENTRY in onboarding.ts), and the Stop-hook command is built from it.
 *
 * The staging manifest drops private:true and every "*" workspace dependency:
 * the bundle has zero runtime deps, so the tarball installs in any repo on any
 * machine. Nothing is published — `npm pack` only writes the .tgz into pack/
 * (gitignored scratch) for the clean-room probe to install from.
 *
 * Staging happens in a fresh OS-temp dir ON PURPOSE: inside this repo, npm
 * anchors file paths at the workspace root and the repo .gitignore (`dist/`)
 * silently excludes the bundle from the tarball. A temp staging dir has no
 * parent project, so the manifest's `files` allowlist governs, exactly as it
 * will when the package ships standalone.
 *
 * First-class script (repo workflow rule): deterministic, self-cleaning,
 * explicit exit code. Run after `npm run build`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const CANARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(CANARY, 'apps', 'cli', 'dist', 'src', 'main.js');
// OWN SUBDIRECTORY, not the whole `pack/`: `tooling/standalone.mjs` writes
// `pack/standalone/`, and wiping the parent (which this used to do) deleted the
// single-executable artifact as a side effect of packing the tarball — a real
// defect: two distribution paths must be able to coexist, and one build step must
// never silently destroy another's deliverable.
const OUT = path.join(CANARY, 'pack', 'npm');

if (!fs.existsSync(ENTRY)) { console.error('FAIL: no compiled CLI — run `npm run build` first'); process.exit(1); }

const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pack-'));
try {
  // The compiled entry already starts with #!/usr/bin/env node (tsc preserves
  // it); adding a banner then yields a SECOND shebang on line 2, which Node
  // does not strip — SyntaxError. Only add one if the source lacks it.
  const hasShebang = fs.readFileSync(ENTRY, 'utf8').startsWith('#!');
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    define: { CANARY_PACKAGED: 'true' },
    outfile: path.join(STAGE, 'dist', 'main.js'), // esbuild creates the parent dir
    ...(hasShebang ? {} : { banner: { js: '#!/usr/bin/env node' } }),
    legalComments: 'none',
    logLevel: 'warning',
  });
  const out = fs.readFileSync(path.join(STAGE, 'dist', 'main.js'), 'utf8');
  if (!out.startsWith('#!/') || out.slice(0, out.indexOf('\n', out.indexOf('\n') + 1) + 1).includes('\n#!')) {
    console.error('FAIL: bundle must start with exactly one shebang line (double shebang = SyntaxError at load)');
    process.exit(1);
  }

  const cliPkg = JSON.parse(fs.readFileSync(path.join(CANARY, 'apps', 'cli', 'package.json'), 'utf8'));
  const manifest = {
    name: '@canary-rn/cli',
    version: cliPkg.version,
    description: 'Canary: pre-finish verification for coding agents (self-contained bundle).',
    license: 'Apache-2.0',
    type: 'module',
    bin: { canary: 'dist/main.js' },
    engines: { node: '>=22' },
    files: ['dist/main.js', 'tools/windows-boundary', 'tooling/test-support/fixtures'],
  };
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Apache-2.0 §4(a): a recipient of this artifact must receive a copy of the License.
  // The manifest's `license` field is a declaration, not the license text, so the file
  // itself ships in the tarball and is asserted by the cleanroom probe.
  fs.copyFileSync(path.join(CANARY, 'LICENSE'), path.join(STAGE, 'LICENSE'));
  for (const name of ['CanaryConfinedLauncher.cs', 'CanaryBroker.cs', 'production-native.ps1', 'production-child.cjs', 'production-tool.cjs', 'production-host.ps1', 'production-heartbeat.ps1']) {
    const relative = path.join('tools/windows-boundary', name);
    fs.mkdirSync(path.dirname(path.join(STAGE, relative)), { recursive: true });
    fs.copyFileSync(path.join(CANARY, relative), path.join(STAGE, relative));
  }
  for (const name of ['boundary-native-child.cs', 'boundary-native-parent.cs', 'boundary-native-run.ps1', 'confined-listener.cjs', 'confined-caller.cjs', 'medium-pipe.ps1']) {
    const relative = path.join('tooling/test-support/fixtures', name);
    fs.mkdirSync(path.dirname(path.join(STAGE, relative)), { recursive: true });
    fs.copyFileSync(path.join(CANARY, relative), path.join(STAGE, relative));
  }

  const packed = spawnSync('npm pack --silent', { cwd: STAGE, encoding: 'utf8', shell: true, timeout: 120_000 });
  if (packed.status !== 0) { console.error('FAIL: npm pack failed\n' + ((packed.stdout ?? '') + (packed.stderr ?? ''))); process.exit(1); }
  const tgzs = fs.readdirSync(STAGE).filter((f) => f.endsWith('.tgz'));
  if (tgzs.length !== 1) { console.error('FAIL: expected exactly one tarball, found ' + JSON.stringify(tgzs)); process.exit(1); }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const dest = path.join(OUT, tgzs[0]);
  fs.copyFileSync(path.join(STAGE, tgzs[0]), dest);
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`PASS: packed ${path.relative(CANARY, dest)} (${kb} KB, bundle ${Math.round(fs.statSync(path.join(STAGE, 'dist', 'main.js')).size / 1024)} KB)`);
} finally {
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch { /* OS-temp scratch; leak is inert */ }
}
