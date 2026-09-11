#!/usr/bin/env node
/**
 * The GENERIC agent loop, in about fifty lines.
 *
 * Any agent that can run a command can drive Canary through its protocol — no
 * hook, no harness-specific integration, no parsing of prose. This script is the
 * whole contract:
 *
 *   1. `canary result --json`  — what Canary knows right now (free, runs nothing)
 *   2. `canary doctor --json`  — actually run the sealed checks and report
 *
 * It exits with doctor's exit code, so a caller (or a CI step) can use it as a
 * gate. Nothing here can mint a verdict: it only reports what Canary decided.
 *
 * usage:  node agent-loop.mjs [project-dir]
 * env:    CANARY_CLI  absolute path to apps/cli/dist/src/main.js (run from a
 *                     checkout, where `canary` is not on PATH)
 *         CANARY_BIN  the installed `canary` executable (default: `canary`)
 */
import { spawnSync } from 'node:child_process';

const dir = process.argv[2] ?? process.cwd();
const cli = process.env.CANARY_CLI;
const bin = process.env.CANARY_BIN ?? 'canary';

function canary(args) {
  const argv = cli ? [process.execPath, cli, ...args] : [bin, ...args];
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 600_000 });
  if (r.error) throw r.error;
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON: reported below */ }
  return { code: r.status, json, raw: r.stdout, err: r.stderr };
}

/** Print only what an agent needs: status, problems and the next action. Logs
 *  stay in the files the envelope names — context is not a log buffer. */
function show(label, r) {
  const e = r.json;
  if (e === null) {
    console.error(`${label}: could not read a JSON envelope (exit ${r.code})`);
    console.error(r.err.trim());
    return;
  }
  console.log(`${label}: ${e.status}  (exit ${e.exitCode})`);
  if (e.checks) console.log(`  checks: ${e.checks.map((c) => `${c.adapter}:${c.script}`).join(', ')}`);
  if (e.security) console.log(`  security: ${e.security.level}`);
  if (e.agent) console.log(`  agent hooked: ${e.agent.hooked}  (gated: ${e.agent.harnesses.filter((h) => h.gated).map((h) => h.id).join(', ') || 'none'})`);
  for (const p of e.problems ?? []) console.log(`  - ${p}`);
  if (e.next) console.log(`  next: ${e.next}`);
  if (e.evidencePath) console.log(`  evidence: ${e.evidencePath}`);
}

const state = canary(['result', '--json', dir]);
show('state', state);

const gate = canary(['doctor', '--json', dir]);
show('gate', gate);

// The agent should repair exactly this and re-run. Exit code is Canary's.
process.exit(gate.code ?? 1);
