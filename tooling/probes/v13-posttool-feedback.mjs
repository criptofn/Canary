// v1.3 §24 — CAN THE EVERYDAY PATH TELL THE AGENT, MID-TASK, THAT ITS CHANGE FAILS?
//
// The confined transport got 51.5% cheaper on the long fixture by returning the project's own check result
// AFTER each batch, so the worker stopped spending a round trip to ask (MEASURED UPDATE 4). The EVERYDAY
// path — the shape v1.3 actually ships — has no equivalent: its Stop hook only speaks at the END of a turn,
// and mid-task the agent must decide for itself to call `canary_doctor`. So the same waste is available
// there, and the everyday shape is the one at 92.7% of plain.
//
// Claude Code documents a `PostToolUse` hook whose `additionalContext` is "added to Claude's context
// alongside the tool result". If that works here, Canary can hand the agent the project's own check result
// the moment it edits a file — the same information, at the same moment, without the agent asking.
//
// THIS PROBE MEASURES THE MECHANISM, ON THIS HOST, WITH THE REAL CLI. A documented field is not evidence
// that it is delivered; this repository has already been burned by exactly that assumption (`--strict-mcp-config`
// was believed to load the fixture's own MCP config and does not). So the hook plants a MARKER beside the
// real failure text of a real failing check, the agent is asked to write a value the check rejects, and the
// probe reports which channel — if any — carried the text to the model.
//
// Host-bound: no Claude Code CLI, no measurement — an explicit SKIP, never a pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const claude = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-posttool-'));
const MARKER = 'CANARY-MIDTASK-MARKER';
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

if (!fs.existsSync(claude)) {
  console.log(`SKIP host-bound: no Claude Code CLI at ${claude} — PostToolUse delivery cannot be measured here`);
  console.log('\n=== posttool feedback: SKIP (host-bound) — NOT a pass ===');
  process.exit(0);
}

/** The API endpoint and model live in the user's Claude Code settings; forward them, never print values. */
function agentEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    for (const [k, v] of Object.entries(s.env ?? {})) if (typeof v === 'string' && v !== '' && !env[k]) env[k] = v;
  } catch { /* the CLI's own environment is used as-is */ }
  return env;
}

function build() {
  const root = fs.mkdtempSync(path.join(temp, 'proj-'));
  // The project's OWN check: it rejects anything but 'two'. The agent will be asked to write 'one'.
  fs.writeFileSync(path.join(root, 'check.cjs'), [
    "const fs = require('node:fs');",
    "let v = '(missing)';",
    "try { v = fs.readFileSync('data.txt', 'utf8').trim(); } catch {}",
    "if (v !== 'two') { console.log('CHECK FAILED: expected two, got ' + v); process.exit(1); }",
    "console.log('CHECK PASSED');",
    '',
  ].join('\n'));
  // The hook: run that check and hand the result to the model alongside the tool result.
  fs.writeFileSync(path.join(root, 'posttool.cjs'), [
    "const { spawnSync } = require('node:child_process');",
    `const MARKER = ${JSON.stringify(MARKER)};`,
    "const r = spawnSync(process.execPath, ['check.cjs'], { cwd: __dirname, encoding: 'utf8', timeout: 60000 });",
    "const text = ((r.stdout || '') + (r.stderr || '')).trim();",
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',",
    "  additionalContext: MARKER + ' — this project\\'s own check just ran (exit ' + r.status + '): ' + text } }));",
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `node "${path.join(root, 'posttool.cjs')}"`, timeout: 60 }] }],
    },
  }, null, 2) + '\n');
  return root;
}

function runSession(root) {
  const r = spawnSync(claude, ['-p',
    "Create a file named data.txt in the current directory containing exactly: one\n"
    + "Then state, verbatim, any verification or check message that was shown to you after the file was written. "
    + "If none was shown, say NONE.",
    '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--strict-mcp-config', '--setting-sources', 'project,local', '--allowedTools', 'Write', 'Read'],
  { cwd: root, encoding: 'utf8', timeout: 420_000, windowsHide: true, env: agentEnv() });

  const events = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line)); } catch { /* unparseable lines are not the question here */ }
  }
  const notices = events.filter((e) => e?.type === 'system' && e?.subtype === 'informational').map((e) => String(e.content ?? ''));
  const userTexts = [];
  for (const e of events) {
    if (e?.type !== 'user') continue;
    for (const b of (Array.isArray(e?.message?.content) ? e.message.content : [])) {
      if (b?.type === 'text' && typeof b.text === 'string') userTexts.push(b.text);
    }
  }
  const assistantTexts = [];
  for (const e of events) {
    if (e?.type !== 'assistant') continue;
    for (const b of (Array.isArray(e?.message?.content) ? e.message.content : [])) {
      if (b?.type === 'text' && typeof b.text === 'string') assistantTexts.push(b.text);
    }
  }
  const result = events.find((e) => e?.type === 'result') ?? null;
  const carrier = notices.some((n) => n.includes(MARKER)) ? 'informational'
    : userTexts.some((t) => t.includes(MARKER)) ? 'user-message'
      : assistantTexts.some((t) => t.includes(MARKER)) ? 'assistant-text'
        : 'none';
  return { status: r.status, notices, userTexts, assistantTexts, result, carrier, delivered: carrier !== 'none',
    usage: result?.usage ?? null, stderr: (r.stderr ?? '').trim() };
}

try {
  const root = build();
  const run = runSession(root);
  const tokens = run.usage ? (run.usage.input_tokens ?? 0) + (run.usage.output_tokens ?? 0)
    + (run.usage.cache_read_input_tokens ?? 0) + (run.usage.cache_creation_input_tokens ?? 0) : null;
  console.log(`INFO session: exit ${run.status}; result ${run.result?.subtype ?? 'MISSING'}; tokens ${tokens ?? 'n/a'}`);
  console.log(`INFO marker delivered via: ${run.carrier}`);
  const said = run.assistantTexts.find((t) => /CHECK FAILED|expected two/i.test(t));
  if (said) console.log(`INFO the model repeated the check result: ${said.trim().slice(0, 200)}`);

  check('A1-the-hook-ran-and-the-project-check-failed-as-designed', () => {
    const wrote = fs.existsSync(path.join(root, 'data.txt'));
    assert(wrote, 'the agent never wrote data.txt, so no PostToolUse event fired and this probe measured nothing');
    const v = fs.readFileSync(path.join(root, 'data.txt'), 'utf8').trim();
    assert(v !== 'two', `the fixture is wrong: data.txt holds "${v}", which the check accepts, so there was no failure to report`);
  });

  check('A2-PostToolUse-additionalContext-REACHES-THE-MODEL-on-this-host', () => {
    assert(run.delivered,
      'the marker planted in the hook\'s additionalContext never reached the session. The documented field is '
      + 'therefore NOT usable here, and the mid-task feedback design is closed on this harness version rather '
      + `than assumed to work. channels seen: notices=${run.notices.length} user=${run.userTexts.length} assistant=${run.assistantTexts.length}`);
  });

  check('A3-the-delivered-text-carried-the-CHECK-RESULT-not-just-a-marker', () => {
    const haystack = [...run.notices, ...run.userTexts, ...run.assistantTexts].join('\n');
    assert(/expected two, got one/i.test(haystack),
      'the marker arrived but the check\'s own failure text did not, so the model was told "something happened" '
      + 'rather than what failed — which is the part that saves the round trip');
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 posttool feedback — mid-task check delivery ${failures === 0 ? 'WORKS' : 'does NOT hold'} on this host`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.log(`FAIL v1.3 posttool feedback — ${String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
