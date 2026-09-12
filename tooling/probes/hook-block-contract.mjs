#!/usr/bin/env node
/**
 * WHICH STOP-HOOK SHAPE ACTUALLY GATES, AND WHICH ONE ACTUALLY EXPLAINS?
 *
 * Canary's Claude Code integration is one `Stop` hook running `canary checkpoint`. The product
 * records its OWN decision (`.canary/last-checkpoint.json`), but that is not evidence the harness
 * honoured it OR delivered its reason — and a block whose reason never reaches the model is a gate
 * that loops the agent instead of correcting it. This probe measures the harness side with nothing
 * of Canary's involved except the JSON shape it emits.
 *
 * WHY IT EXISTS (MEASURED, first version of this probe): a Stop hook printing
 * `{"decision":"block","reason":"<marker>"}` and exiting 0 produced
 *   - a `system/notification { key: "stop-hook-error", text: "Stop hook error occurred · ctrl+o to see" }`,
 *   - FOURTEEN model turns for the prompt "Reply with the single word OK." (the model was never
 *     told why it could not stop, so it tried again), and
 *   - ZERO delivery of the marker text to the model.
 * That is the difference between "the gate fired" and "the gate worked": the reason is the whole
 * point of the compact failure payload, and the CLI was dropping it while logging an error.
 *
 * So this probe plants each candidate shape in a throwaway project and reports, per shape:
 * exit code, model turns, whether the marker reached the session, whether the CLI logged a
 * hook error, and which event channel carried the text. The allow shape is the control.
 *
 * Usage: node tooling/probes/hook-block-contract.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The API endpoint / model live in the user's Claude Code settings; forward them, never print values. */
function agentEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    for (const [k, v] of Object.entries(s.env ?? {})) if (typeof v === 'string' && v !== '' && !env[k]) env[k] = v;
  } catch { /* the CLI's own environment is used as-is */ }
  return env;
}

const MARKER = 'CANARY-PROBE-MARKER';

/**
 * The candidate shapes, each as the hook's whole program. `blocked` says whether the shape is
 * meant to prevent the stop; `delivers` is the question the probe answers by measurement.
 */
const SHAPES = [
  {
    name: 'json-decision-block',
    note: 'the shape Canary emits today: {"decision":"block","reason"} on stdout, exit 0',
    blocked: true,
    body: `process.stdout.write(JSON.stringify({ decision: 'block', reason: '${MARKER}: checks still failing' }));\nprocess.exit(0);`,
  },
  {
    name: 'exit2-stderr',
    note: 'the documented universal fallback: exit 2 with the reason on stderr',
    blocked: true,
    body: `process.stderr.write('${MARKER}: checks still failing (exit-2 shape)\\n');\nprocess.exit(2);`,
  },
  {
    name: 'exit2-stderr-and-json',
    note: 'exit 2 with the reason on stderr AND the JSON block on stdout',
    blocked: true,
    body: `process.stderr.write('${MARKER}: checks still failing (exit-2 + json shape)\\n');\nprocess.stdout.write(JSON.stringify({ decision: 'block', reason: '${MARKER}: checks still failing' }));\nprocess.exit(2);`,
  },
  {
    name: 'continue-false',
    note: 'the other documented block form: {"continue":false,"stopReason"} on stdout, exit 0',
    blocked: true,
    body: `process.stdout.write(JSON.stringify({ continue: false, stopReason: '${MARKER}: checks still failing' }));\nprocess.exit(0);`,
  },
  {
    name: 'systemMessage-only',
    note: 'the loop-guard shape Canary uses for its second attempt: {"systemMessage"} on stdout, exit 0',
    blocked: false,
    body: `process.stdout.write(JSON.stringify({ systemMessage: '${MARKER}: checks still failing after one repair attempt' }));\nprocess.exit(0);`,
  },
  {
    name: 'allow-silent',
    note: 'what Canary emits when the checks pass: no stdout, exit 0 (control)',
    blocked: false,
    body: 'process.exit(0);',
  },
];

function project(shape) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `canary-hook-${shape.name}-`));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: `hook-${shape.name}`, private: true }, null, 2)}\n`);
  const hookFile = path.join(root, 'stop-hook.cjs');
  fs.writeFileSync(hookFile, `'use strict';\n${shape.body}\n`);
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${hookFile}"`, timeout: 60 }] }] },
  }, null, 2)}\n`);
  return root;
}

function runSession(root) {
  const r = spawnSync('claude', ['-p', 'Reply with the single word OK.', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--setting-sources', 'project,local',
    '--allowedTools', 'Read'], { cwd: root, encoding: 'utf8', timeout: 420_000, windowsHide: true, env: agentEnv() });
  const events = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line)); } catch { /* unparseable lines are not the question here */ }
  }
  const notices = events.filter((e) => e?.type === 'system' && e?.subtype === 'informational').map((e) => String(e.content ?? ''));
  const errors = events.filter((e) => e?.type === 'system' && e?.subtype === 'notification' && String(e.key ?? '') === 'stop-hook-error');
  const assistantEvents = events.filter((e) => e?.type === 'assistant');
  const turns = new Set(assistantEvents.map((e) => e?.message?.id).filter(Boolean)).size;
  const userTexts = [];
  for (const e of events) {
    if (e?.type !== 'user') continue;
    for (const b of (Array.isArray(e?.message?.content) ? e.message.content : [])) {
      if (b?.type === 'text' && typeof b.text === 'string') userTexts.push(b.text);
    }
  }
  const result = events.find((e) => e?.type === 'result') ?? null;
  const carrier = notices.some((n) => n.includes(MARKER)) ? 'informational'
    : userTexts.some((t) => t.includes(MARKER)) ? 'user-message'
      : errors.some((e) => String(e.text ?? '').includes(MARKER)) ? 'notification'
        : 'none';
  return {
    status: r.status, turns, notices, errors, userTexts, result, carrier,
    delivered: carrier !== 'none',
    stderr: (r.stderr ?? '').trim(),
  };
}

const rows = [];
for (const shape of SHAPES) {
  const root = project(shape);
  console.log(`\n── ${shape.name} — ${shape.note}`);
  const run = runSession(root);
  console.log(`   exit ${run.status}; turns ${run.turns}; result ${run.result?.subtype ?? 'MISSING'}; hook-error notifications ${run.errors.length}; marker delivered via ${run.carrier}`);
  for (const n of run.notices.slice(0, 3)) console.log(`   notice: ${n.slice(0, 160)}`);
  for (const u of run.userTexts.filter((t) => t.includes(MARKER)).slice(0, 2)) console.log(`   user text: ${u.slice(0, 160)}`);
  if (run.status !== 0 && run.stderr !== '') console.log(`   stderr: ${run.stderr.slice(0, 200)}`);
  rows.push({ shape: shape.name, blocked: shape.blocked, ...run });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n=== the table ===');
console.log('shape                    | exit | turns | marker delivered | carrier       | hook-error');
for (const r of rows) {
  console.log(`${r.shape.padEnd(24)} | ${String(r.status).padStart(4)} | ${String(r.turns).padStart(5)} | ${(r.delivered ? 'yes' : 'NO').padEnd(16)} | ${r.carrier.padEnd(13)} | ${r.errors.length}`);
}

const blocking = rows.filter((r) => r.blocked);
const delivering = blocking.filter((r) => r.delivered);
const silentAllow = rows.find((r) => r.shape === 'allow-silent');

check('1. a passing project is allowed silently, with no extra turn', () => {
  assert(silentAllow.status === 0, `the control session failed (exit ${silentAllow.status})`);
  assert(silentAllow.turns <= 2, `a silent allow must not cost turns (got ${silentAllow.turns})`);
  assert(silentAllow.notices.length === 0, 'a silent allow must not inject a notice');
});

check('2. at least one blocking shape both stops the model AND delivers the reason', () => {
  assert(delivering.length > 0,
    `no shape delivered the reason text; measured:\n${rows.map((r) => `  ${r.shape}: delivered=${r.delivered} carrier=${r.carrier} turns=${r.turns} errors=${r.errors.length}`).join('\n')}`);
  console.log(`      → the shape(s) that work: ${delivering.map((r) => `${r.shape} (via ${r.carrier})`).join(', ')}`);
});

check('3. the shape the product emits today DOES deliver its reason (and the CLI still logs a cosmetic error)', () => {
  const current = rows.find((r) => r.shape === 'json-decision-block');
  assert(current !== undefined, 'the current shape was not measured');
  // MEASURED, and this corrected the first version of this probe: the reason arrives as a USER
  // MESSAGE prefixed `Stop hook feedback:`, not as a system notice. An earlier run of the probe
  // only inspected system notices, concluded the reason was dropped, and was WRONG.
  assert(current.delivered, `{"decision":"block","reason"} must deliver its reason; carrier was ${current.carrier}`);
  assert(current.carrier === 'user-message', `expected the reason on a user message, got ${current.carrier}`);
  assert(current.turns > 1, 'a blocked stop must give the model a repair turn');
  // The CLI reports a hook error for EVERY blocking shape measured (JSON, exit 2, and both
  // together), so it is a property of blocking, not of Canary's payload. Recorded, not asserted.
  console.log(`      → the CLI logged ${current.errors.length} \`stop-hook-error\` notification(s) for the blocking shape; every blocking shape measured did the same, so it is cosmetic`);
});

check('4. every blocking shape is reported, so the choice is made on evidence', () => {
  for (const r of blocking) {
    console.log(`      ${r.shape}: turns=${r.turns} delivered=${r.delivered} carrier=${r.carrier} hookErrors=${r.errors.length}`);
  }
  assert(blocking.length >= 2, 'the probe must try more than one blocking shape');
  // `continue:false` is documented as a block form and is NOT one here: it ended the session
  // without a repair turn and delivered nothing. Recorded so nobody "simplifies" the product to it.
  const continueFalse = rows.find((r) => r.shape === 'continue-false');
  assert(continueFalse.delivered === false,
    'continue:false delivered text on this run — the measurement changed, re-read the table before shipping a change');
});

console.log(`\n=== stop-hook contract: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
