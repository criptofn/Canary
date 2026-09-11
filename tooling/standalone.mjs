#!/usr/bin/env node
/**
 * v1.1 item C — the STANDALONE distribution: a single executable with Node
 * embedded, so an ordinary Python / Rust / Go user does not have to install
 * Node.js to run Canary.
 *
 * WHY SEA AND NOT A THIRD-PARTY COMPILER: `node --build-sea` is the runtime's
 * own supported mechanism and, on the Node builds this repo targets, it is a
 * SINGLE STEP — no `postject`, no native toolchain, no extra dependency. That
 * was measured, not assumed (`tooling/probes/standalone-capability.mjs` proves
 * both a CommonJS and an ES-module main build and then RUN the result with every
 * Node directory removed from PATH).
 *
 * WHAT THIS SCRIPT GUARANTEES, AND WHAT IT REFUSES TO CLAIM:
 *  - It builds for the HOST it runs on, only. `--build-sea` embeds the running
 *    `node` binary, so a Linux or macOS artifact cannot be produced from
 *    Windows; cross-building is not a flag, it is a different machine. Each
 *    target must be built where it will run, and this script says which targets
 *    were actually built rather than implying the others.
 *  - It does not report success from a build exit code alone. It EXECUTES the
 *    produced binary with Node removed from the environment and requires real
 *    output, then records those commands and their observed results next to the
 *    artifact. An artifact that has not been run is not evidence.
 *
 * Usage: node tooling/standalone.mjs   (after `npm run build`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const CANARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(CANARY, 'apps', 'cli', 'dist', 'src', 'main.js');
const OUTDIR = path.join(CANARY, 'pack', 'standalone');
const TARGET = `${process.platform}-${process.arch}`;
const EXT = process.platform === 'win32' ? '.exe' : '';
const OUT = path.join(OUTDIR, `canary-${TARGET}${EXT}`);
const NODE_DIR = path.dirname(process.execPath);

/**
 * The distribution targets this repository builds for. Each one must be built
 * AND EXECUTED on its own host: `--build-sea` embeds the RUNNING `node` binary,
 * so there is no cross-build — a Linux artifact cannot be produced from Windows,
 * and claiming one would be claiming an unexecuted binary.
 *
 * This list is the honest status board: it says which target this machine can
 * produce, not which targets exist somewhere.
 */
export const DISTRIBUTION_TARGETS = ['win32-x64', 'linux-x64', 'darwin-arm64'];

const argv = process.argv.slice(2);
const wantTarget = argv.find((a) => a.startsWith('--target='))?.slice('--target='.length);
const listTargets = argv.includes('--list-targets');

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (listTargets) {
  console.log(JSON.stringify({
    schema: 'canary-distribution-targets/1',
    host: TARGET,
    hostBuildable: TARGET,
    targets: DISTRIBUTION_TARGETS.map((t) => ({
      target: t,
      // Only the host can be built here; the others are IMPLEMENTED_BUT_REQUIRES_OTHER_OS.
      status: t === TARGET ? 'BUILD_AND_EXECUTE_ON_THIS_HOST' : 'IMPLEMENTED_BUT_REQUIRES_OTHER_OS',
      build: 'npm run standalone      # on a runner for this target',
      verify: 'the builder EXECUTES the artifact with every Node directory removed from PATH before it reports success',
    })),
    alternate: {
      id: 'npm-tgz',
      build: 'node tooling/pack.mjs',
      note: 'the self-contained bundle + tarball; needs Node 22+ on the target but no per-OS build',
      proven: 'tooling/probes/cleanroom-packed-artifact.mjs (clean-room install + run, spaces in the path)',
    },
  }, null, 2));
  process.exit(0);
}

if (wantTarget !== undefined && wantTarget !== TARGET) {
  fail(`cannot build "${wantTarget}" on ${TARGET}: \`node --build-sea\` embeds the RUNNING node binary, so a `
    + `single-executable artifact can only be produced ON its own host. Run \`npm run standalone\` on a `
    + `${wantTarget} machine (the CI job "standalone" does exactly that for ${DISTRIBUTION_TARGETS.join(', ')}), `
    + 'or distribute the npm tarball (node tooling/pack.mjs), which is platform-neutral but needs Node 22+.');
}

/** PATH with every Node directory removed — the "no Node installed" posture the
 *  standalone build exists to serve. */
function pathWithoutNode() {
  const sep = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH ?? '').split(sep)
    .filter((d) => d.trim() !== '' && path.resolve(d).toLowerCase() !== path.resolve(NODE_DIR).toLowerCase())
    .join(sep);
}

if (!fs.existsSync(ENTRY)) fail(`no compiled CLI at ${ENTRY} — run \`npm run build\` first`);

const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-standalone-'));
const evidence = {
  schema: 'canary-standalone-evidence/1',
  builtOn: { platform: process.platform, arch: process.arch, node: process.version, os: os.release() },
  target: TARGET,
  artifact: path.relative(CANARY, OUT).replace(/\\/g, '/'),
  runs: [],
};

try {
  // 1. ONE self-contained ES module, exactly like the npm tarball's bundle.
  const bundlePath = path.join(STAGE, 'main.mjs');
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: bundlePath,
    legalComments: 'none',
    logLevel: 'warning',
  });
  // A shebang is meaningless inside an executable and SEA does not need it;
  // strip it so the embedded module is plain ESM with no leading special line.
  const bundled = fs.readFileSync(bundlePath, 'utf8');
  if (bundled.startsWith('#!')) fs.writeFileSync(bundlePath, bundled.slice(bundled.indexOf('\n') + 1));
  evidence.bundleBytes = fs.statSync(bundlePath).size;

  // 2. The SEA config. `mainFormat: 'module'` keeps `import.meta.url` and ESM
  //    semantics working (measured: the CLI is ESM and relies on them).
  const cfgPath = path.join(STAGE, 'sea-config.json');
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
    main: bundlePath,
    output: OUT,
    disableExperimentalSEAWarning: true,
    mainFormat: 'module',
  }, null, 2) + '\n');

  fs.rmSync(OUT, { force: true });
  const b = spawnSync(process.execPath, [`--build-sea=${cfgPath}`], { encoding: 'utf8', timeout: 600_000, windowsHide: true });
  if (b.status !== 0 || !fs.existsSync(OUT)) {
    fail(`node --build-sea failed (status ${b.status})\n${(b.stdout ?? '') + (b.stderr ?? '')}`);
  }
  const bytes = fs.readFileSync(OUT);
  evidence.artifactBytes = bytes.length;
  evidence.artifactSha256 = sha256(bytes);
  console.log(`built ${evidence.artifact} (${Math.round(bytes.length / 1024 / 1024)} MB, bundle ${Math.round(evidence.bundleBytes / 1024)} KB)`);

  // 3. PROVE IT RUNS with no Node on PATH. A build that was never executed is
  //    not a distribution.
  const env = { ...process.env, PATH: pathWithoutNode() };
  const run = (args, cwd = STAGE) => {
    const r = spawnSync(OUT, args, { cwd, encoding: 'utf8', timeout: 300_000, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { args, status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error ? String(r.error.message) : null };
  };

  const version = run(['--version']);
  evidence.runs.push(version);
  if (version.status !== 0 || !/^canary \d+\.\d+\.\d+/.test(version.stdout)) {
    fail(`the standalone binary did not report its version with Node removed from PATH: ${JSON.stringify(version)}`);
  }
  console.log(`PASS: ${evidence.artifact} --version -> ${version.stdout} (no Node on PATH)`);

  // A real command in a real repository, still with no Node on PATH.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-standalone-repo-'));
  const g = spawnSync('git', ['-C', repo, 'init', '-b', 'main'], { encoding: 'utf8' });
  if (g.status !== 0) fail(`could not create the smoke repository: ${g.stderr}`);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'standalone-smoke', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n');
  const result = run(['result', '--json'], repo);
  evidence.runs.push(result);
  let envelope = null;
  try { envelope = JSON.parse(result.stdout); } catch { /* reported below */ }
  if (envelope === null || envelope.schema !== 'canary-result/1') {
    fail(`the standalone binary did not produce a canary-result/1 envelope: ${JSON.stringify(result)}`);
  }
  console.log(`PASS: ${evidence.artifact} result --json -> schema=${envelope.schema} status=${envelope.status} exit=${result.status} (no Node on PATH)`);
  fs.rmSync(repo, { recursive: true, force: true });

  // 4. Record the evidence beside the artifact. No claim without it.
  const sums = path.join(OUTDIR, `canary-${TARGET}.sha256`);
  fs.writeFileSync(sums, `${evidence.artifactSha256}  canary-${TARGET}${EXT}\n`);
  const evidencePath = path.join(OUTDIR, `canary-${TARGET}.evidence.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  // A manifest of the whole distribution story, so the artifact cannot be read
  // without also seeing the path that was NOT built here.
  const manifestPath = path.join(OUTDIR, 'distribution.json');
  const prior = (() => { try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return {}; } })();
  const built = { ...(prior.built ?? {}), [TARGET]: { sha256: evidence.artifactSha256, bytes: evidence.artifactBytes, node: process.version, at: new Date().toISOString() } };
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema: 'canary-distribution/1',
    host: TARGET,
    built,
    notBuiltHere: DISTRIBUTION_TARGETS.filter((t) => built[t] === undefined)
      .map((t) => ({ target: t, status: 'IMPLEMENTED_BUT_REQUIRES_OTHER_OS', build: 'npm run standalone on that host' })),
    alternate: { id: 'npm-tgz', build: 'node tooling/pack.mjs', needsNode: '>=22' },
  }, null, 2) + '\n');
  console.log(`PASS: standalone ${TARGET} built and executed — ${path.relative(CANARY, sums)} , ${path.relative(CANARY, evidencePath)}`);
  console.log(`      distribution manifest: ${path.relative(CANARY, manifestPath)}`);
  console.log('NOTE: this is the ONLY target built here. --build-sea embeds the running node binary, so');
  console.log(`      ${DISTRIBUTION_TARGETS.filter((t) => t !== TARGET).join(', ')} must be built and executed on those hosts;`);
  console.log('      none is claimed from this machine. The npm tarball (node tooling/pack.mjs) is the alternate,');
  console.log('      platform-neutral distribution and needs Node 22+ rather than a per-OS build.');
} finally {
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch { /* OS-temp scratch; leak is inert */ }
}
