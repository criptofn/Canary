#!/usr/bin/env node
/**
 * M0 dry-run — Canary's security boundary made executable.
 *
 * Executes the approved golden-fixture experiment (3846masa/axios-cookiejar-
 * support @ f1e045d4) under the mandatory constraints approved 2026-08-30:
 *   - pinned repo + exact commit (content fetched by SHA, not branch)
 *   - disposable workspace inside the repo (.canary-runs/...)
 *   - allowlisted environment (no ANTHROPIC/GITHUB/cloud credential vars; by omission)
 *   - --ignore-scripts everywhere (no dependency lifecycle code)
 *   - no git auth, no publish, no pushes; network only npm registry + codeload
 *   - all downstream code treated as UNTRUSTED
 *
 * This is the direct ancestor of packages/runner/{workspace,executor,environment}.
 * Run:  node scripts/m0-dryrun.mjs
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WS = path.join(
  REPO_ROOT,
  ".canary-runs",
  `m0-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const FIXTURE = path.join(WS, "fixture");
const ARTIFACTS = path.join(WS, "artifacts");
const SANDBOX_HOME = path.join(WS, "isolated-home");
const SANDBOX_TMP = path.join(WS, "isolated-tmp");

const PIN = {
  repo: "3846masa/axios-cookiejar-support",
  commit: "f1e045d4787b4f4e427a502867e47c1e52cb7aa6",
  url: "https://codeload.github.com/3846masa/axios-cookiejar-support/tar.gz/f1e045d4787b4f4e427a502867e47c1e52cb7aa6",
};
const DEP = { package: "axios", baseline: "0.27.2", candidate: "1.0.0" };
const NODE = process.execPath;
const NPM_CLI = path.join(path.dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js");
const SYSTEMROOT = process.env.SystemRoot ?? "C:\\WINDOWS";
const NODE_DIR = path.dirname(NODE);

/** Allowlist environment — everything not listed is invisible to fixture code. */
function sanitizedEnv(overrides = {}) {
  return {
    PATH: `${NODE_DIR};${SYSTEMROOT}\\System32;${SYSTEMROOT}`,
    PATHEXT: ".EXE;.CMD",
    SystemRoot: SYSTEMROOT,
    windir: SYSTEMROOT,
    ComSpec: path.join(SYSTEMROOT, "System32", "cmd.exe"),
    TEMP: SANDBOX_TMP,
    TMP: SANDBOX_TMP,
    HOME: SANDBOX_HOME,
    USERPROFILE: SANDBOX_HOME,
    ...overrides,
  };
}

function log(msg) {
  console.log(msg);
}

function run(label, argv, { cwd = FIXTURE, timeoutSecs = 300, env = {} } = {}) {
  const started = new Date().toISOString();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: sanitizedEnv(env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutSecs * 1000,
    shell: false,
  });
  const out = res.stdout ?? "";
  const err = res.stderr ?? "";
  if (res.error) {
    fs.writeFileSync(path.join(ARTIFACTS, `${label}.spawnerror`), String(res.error));
  }
  fs.writeFileSync(path.join(ARTIFACTS, `${label}.stdout.txt`), out);
  fs.writeFileSync(path.join(ARTIFACTS, `${label}.stderr.txt`), err);
  const code = res.status === null ? -1 : res.status; // -1 = killed/timeout
  fs.writeFileSync(
    path.join(ARTIFACTS, `${label}.meta.json`),
    JSON.stringify({ started, exitCode: code, argv, envKeys: Object.keys(sanitizedEnv(env)) }, null, 2),
  );
  const tail = (out + err).trim().split("\n").slice(-6).join("\n      ");
  log(`  ${label}: exit=${code}  tail:\n      ${tail}`);
  return { code, out, err };
}

async function fetchPinnedTarball() {
  log(`fetching ${PIN.repo} @ ${PIN.commit.slice(0, 8)} (tarball by SHA)`);
  const res = await fetch(PIN.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tgz = path.join(WS, "fixture.tgz");
  fs.writeFileSync(tgz, buf);
  log(`  downloaded ${(buf.length / 1024).toFixed(0)} KiB sha256=${createHash("sha256").update(buf).digest("hex").slice(0, 16)}…`);
  // Windows 10+ ships bsdtar at System32\tar.exe
  const tr = spawnSync(path.join(SYSTEMROOT, "System32", "tar.exe"), ["-xzf", tgz, "-C", WS], {
    env: sanitizedEnv(), shell: false, timeout: 120_000,
  });
  if (tr.status !== 0) throw new Error("tar extraction failed: " + tr.stderr);
  const extracted = fs.readdirSync(WS).find((d) => d.startsWith("axios-cookiejar-support-"));
  fs.renameSync(path.join(WS, extracted), FIXTURE);
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, "package.json"), "utf8"));
  log(`  extracted: ${pkg.name}@${pkg.version}; devDep axios=${pkg.devDependencies.axios}`);
  if (pkg.devDependencies.axios !== DEP.baseline)
    throw new Error(`pin mismatch: expected devDep axios ${DEP.baseline}`);
  // Safety re-check at runtime: no install lifecycle hooks may exist.
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    if (pkg.scripts?.[hook]) throw new Error(`unexpected lifecycle hook: ${hook}`);
  }
}

function main() {
  if (!fs.existsSync(NPM_CLI)) throw new Error(`npm cli not found at ${NPM_CLI}`);
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  log(`\nworkspace: ${WS}\n`);
}

/** Resolve a package's bin entry point from its own package.json (portable). */
function resolveBin(pkgName, binKey) {
  const pj = JSON.parse(
    fs.readFileSync(path.join(FIXTURE, "node_modules", pkgName, "package.json"), "utf8"),
  );
  let rel;
  if (typeof pj.bin === "string") rel = pj.bin;
  else rel = pj.bin?.[binKey ?? pkgName];
  if (!rel) throw new Error(`no bin for ${pkgName}`);
  const abs = path.join(FIXTURE, "node_modules", pkgName, rel);
  if (!fs.existsSync(abs)) throw new Error(`bin missing: ${abs}`);
  return abs;
}

async function drive() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(SANDBOX_HOME, { recursive: true });
  fs.mkdirSync(SANDBOX_TMP, { recursive: true });
  fs.writeFileSync(path.join(WS, "empty.npmrc"), "");
  main();

  log(`\n[1] prepare: fetch pinned fixture`);
  await fetchPinnedTarball();

  const npmFlags = [
    "--userconfig", path.join(WS, "empty.npmrc"),
    "--cache", path.join(WS, "npm-cache"),
    "--no-audit", "--no-fund", "--ignore-scripts", "--legacy-peer-deps",
  ];

  log(`\n[2] era-locked install (yarn 1.22.22 --frozen-lockfile --ignore-scripts)`);
  const install = run("install", [
    NODE, NPM_CLI, "exec", "--yes", "--package", "yarn@1.22.22", "--",
    "yarn", "install", "--frozen-lockfile", "--non-interactive",
    "--ignore-scripts", "--cache-folder", path.join(WS, "yarn-cache"),
  ], { timeoutSecs: 600 });
  if (install.code !== 0) { console.log("\nM0: INFRASTRUCTURE_FAILURE during install — aborting"); process.exit(2); }

  log(`\n[3] build compiled specs ONCE against baseline types (tsc)`);
  const build = run("build", [NODE, path.join(FIXTURE, "node_modules", "typescript", "bin", "tsc")], { timeoutSecs: 300 });
  if (build.code !== 0) { console.log("\nM0: build failed under baseline — inspect artifacts"); process.exit(2); }

  const avaEntry = resolveBin("ava");
  log(`  ava bin resolved: ${path.relative(REPO_ROOT, avaEntry)}`);
  const baseRounds = [];
  for (let i = 1; i <= 2; i++) {
    log(`\n[4.${i}] BASELINE run ${i}/2 (axios ${DEP.baseline})`);
    baseRounds.push(run(`baseline-${i}`, [NODE, avaEntry], { timeoutSecs: 300 }).code);
  }

  log(`\n[5] candidate swap: replace ONLY axios -> ${DEP.candidate} (npm --no-save --ignore-scripts)`);
  const swap = run("swap", [NODE, NPM_CLI, "install", ...npmFlags, "--no-package-lock", `${DEP.package}@${DEP.candidate}`], { timeoutSecs: 600 });
  if (swap.code !== 0) { console.log("\nM0: candidate swap failed — INFRASTRUCTURE_FAILURE"); process.exit(2); }
  const vcheck = run("axios-version", [NODE, "-e",
    `console.log(require(${JSON.stringify(path.join(FIXTURE, "node_modules", "axios", "package.json"))}).version)`]);
  log(`  installed axios now: ${vcheck.out.trim()}`);

  const candRounds = [];
  for (let i = 1; i <= 3; i++) {
    log(`\n[6.${i}] CANDIDATE run ${i}/3 (axios ${DEP.candidate})`);
    candRounds.push(run(`candidate-${i}`, [NODE, avaEntry], { timeoutSecs: 300 }).code);
  }

  // ---- deterministic classification per docs/PLAN.md §6 (exit codes are authoritative)
  const basePass = baseRounds.every((c) => c === 0);
  const candFail = candRounds.every((c) => c !== 0);
  const candAllPass = candRounds.every((c) => c === 0);
  let classification;
  if (!basePass && !candFail) classification = "INCONCLUSIVE";
  else if (basePass && candAllPass) classification = "PASS";
  else if (basePass && candFail) classification = "CONFIRMED_REGRESSION";
  else if (!basePass && candFail) classification = "PRE_EXISTING_FAILURE";
  else classification = "FLAKY";

  const summary = {
    m0: "dry-run",
    pinnedRepo: PIN, dependency: DEP, workspace: WS,
    baselineExitCodes: baseRounds, candidateExitCodes: candRounds,
    buildExitCode: build.code,
    classification,
    expectedSignature: "baseline [0,0] + candidate [nonzero x3] => CONFIRMED_REGRESSION",
  };
  fs.writeFileSync(path.join(ARTIFACTS, "summary.json"), JSON.stringify(summary, null, 2));
  log(`\n${"=".repeat(64)}\nM0 SUMMARY: baseline=${JSON.stringify(baseRounds)} candidate=${JSON.stringify(candRounds)}\nCLASSIFICATION (deterministic): ${classification}\nartifacts: ${ARTIFACTS}\n${"=".repeat(64)}`);
  process.exit(classification === "CONFIRMED_REGRESSION" ? 0 : 1);
}

drive().catch((e) => {
  console.error("\nM0 CRASHED:", e);
  process.exit(2);
});
