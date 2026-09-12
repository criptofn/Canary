/**
 * The stream ledger's tests, driven by events in the shapes the CLI ACTUALLY emits.
 *
 * The ledger is what the token claims rest on, so its arithmetic and its tolerances are pinned
 * here. Two of these tests exist because the first version of the ledger was WRONG in a way no
 * synthetic fixture caught, and a real run did:
 *
 *   - `tooling/probes/stream-usage-shape.mjs` measured 4 assistant events for `num_turns: 2`,
 *     because one message with two content blocks arrives as two events sharing `message.id`;
 *     and every one of those events reported `output_tokens: 0` while the run produced 96.
 *     Summing that produced 67,940 "tokens" against the CLI's own 36,448.
 *   - the authoritative session figure is `modelUsage`, not `usage` (which is the last request).
 *
 * So the tests below use the measured shapes: duplicated message ids, partial per-message usage,
 * and a `result` event carrying both `usage` and `modelUsage`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseStream, isCanaryInvocation } from './stream.mjs';

const assistant = (usage, blocks, id = undefined) => JSON.stringify({
  type: 'assistant',
  message: { ...(id === undefined ? {} : { id }), model: 'qwen-test', content: blocks, usage },
});
const toolResult = (text, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }], is_error: isError }] } });
const bash = (command, id = 't') => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const edit = (file, id = 'e') => ({ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } });
const hook = (name, output = '') => JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: name, hook_event: 'Stop', exit_code: 0, outcome: 'success', output });

/** Per-message usage in the shape the CLI really uses: it carries output. */
const USAGE = (out) => ({ input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });
/** And the shape it really uses on this host: present, but with no output accounting. */
const PARTIAL = () => ({ input_tokens: 16985, output_tokens: 0 });

describe('stream ledger', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', tools: [], model: 'claude-test-1' }),
    assistant(USAGE(50), [bash('npm test', 't1')], 'm1'),
    toolResult('x'.repeat(4000)),                       // the model SAW 4000 chars of test output
    assistant(USAGE(60), [edit('src/x.js', 'e1')], 'm2'),
    toolResult('ok'),
    assistant(USAGE(70), [bash('canary doctor', 't2')], 'm3'),
    toolResult('y'.repeat(500)),                        // Canary's own output, 500 chars
    assistant(USAGE(80), [{ type: 'text', text: 'All tests pass.' }], 'm4'),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_ms: 1000, total_cost_usd: 0.01, result: 'All tests pass.', usage: USAGE(80) }),
  ].join('\n');

  it('counts tokens per turn and in total', () => {
    const s = parseStream(stream);
    assert.equal(s.turns, 4);
    assert.equal(s.messages, 4);
    assert.equal(s.usage.output, 80, 'the result event is authoritative for totals');
    assert.equal(s.usage.total, 10 + 80 + 100 + 5);
    assert.equal(s.perTurn.length, 4);
    assert.equal(s.perTurn[0].usage.output, 50);
    assert.equal(s.streamedUsageUsable, true, 'every message carried output accounting');
  });

  it('records WHICH model served the run, and where the token figure came from', () => {
    const s = parseStream(stream);
    assert.equal(s.model, 'claude-test-1', 'the init event names the model');
    assert.match(s.usage.source, /result\.usage/);
    const fromAssistant = parseStream([
      assistant(USAGE(1), [], 'm1'),
    ].join('\n'));
    assert.equal(fromAssistant.model, 'qwen-test', 'an assistant message is a fallback source');
    assert.equal(parseStream('not json').model, null, 'no evidence means null, never a guess');
  });

  it('measures the bytes the model was SHOWN, which is the context cost', () => {
    const s = parseStream(stream);
    assert.equal(s.bytes.toolResultTotal, 4000 + 2 + 500);
    assert.equal(s.bytes.largestToolResult, 4000);
  });

  it('attributes Canary-visible bytes separately from everything else', () => {
    const s = parseStream(stream);
    assert.equal(s.bytes.canaryVisible, 500, "only the output of the `canary …` call counts as Canary's share");
  });

  it('counts how many times the MODEL ran the project checks (the work Canary takes over)', () => {
    const s = parseStream(stream);
    assert.equal(s.commands.total, 2);
    assert.equal(s.commands.checks, 1);
    assert.equal(s.commands.canary, 1);
  });

  it('counts shell commands issued through whichever tool the CLI exposes', () => {
    const s = parseStream([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'PowerShell', input: { command: 'npm test' } }], usage: USAGE(1) } }),
    ].join('\n'));
    assert.equal(s.commands.total, 1, 'a command is a command, not a tool name');
    assert.equal(s.commands.checks, 1);
  });

  it('measures the tail: turns spent after the last file edit', () => {
    const s = parseStream(stream);
    assert.equal(s.tail.lastFileEditTurn, 1, 'the edit happened in the second turn (0-based)');
    assert.equal(s.tail.turnsAfterLastEdit, 2);
    assert.equal(s.tail.tokensAfterLastEdit, (10 + 70 + 100 + 5) + (10 + 80 + 100 + 5),
      'the canary call and the closing message are the tail');
    assert.match(String(s.tail.shareOfTokensAfterLastEdit), /^[0-9.]+$/);
  });

  it('tolerates shape drift instead of throwing', () => {
    const drifted = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'thinking_delta', delta: 'hmm' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }), // no usage
      'not json at all',
    ].join('\n');
    const s = parseStream(drifted);
    assert.equal(s.parseErrors, 1);
    assert.equal(s.unknownTypes.thinking_delta, 1);
    assert.equal(s.sawResult, false, 'a missing result event must be visible, not guessed');
    assert.equal(s.usage.total, 0);
    assert.equal(s.toolCalls.length, 1);
  });

  it('handles an empty stream without inventing anything', () => {
    const s = parseStream('');
    assert.equal(s.turns, 0);
    assert.equal(s.usage.total, 0);
    assert.equal(s.bytes.toolResultTotal, 0);
    assert.equal(s.tail.lastFileEditTurn, -1);
    assert.equal(s.tail.tokensAfterLastEdit, null);
    assert.equal(s.tail.tokensAvailable, false);
  });
});

describe('stream ledger: what counts as "the model invoked Canary"', () => {
  // The regression that motivated these cases: the benchmark works inside a temp directory named
  // `canary-bench-<task>-<arm>-<random>`, so a PLAIN-arm trial was credited with two Canary
  // invocations and its output with "Canary-visible bytes" — the very column the negative-overhead
  // claim rests on. Containment is not invocation.
  const plainPath = 'C:\\Users\\x\\AppData\\Local\\Temp\\canary-bench-bug-sum-plain-7cAsCH\\project';
  const cases = [
    [`ls -R "${plainPath}" | head -50`, false, 'a quoted path that merely contains "canary"'],
    [`cd "${plainPath}" && npm test`, false, 'same, in a compound command the plain arm really ran'],
    ['cat canary-bench-notes.md', false, 'a file whose name contains it'],
    ['CANARY=1 npm test', false, 'an environment variable, not an invocation'],
    ['canary doctor --json', true, 'the documented bare invocation'],
    ['npx canary result --json', true, 'invoked through a package runner'],
    ['cd project && canary finish widget', true, 'chained after another command'],
    ['node "C:\\repo\\apps\\cli\\dist\\src\\main.js" checkpoint', true, 'the repository CLI entry point directly'],
    ['/usr/local/bin/canary doctor', true, 'a canary binary addressed by path'],
  ];
  for (const [cmd, expected, why] of cases) {
    it(`${expected ? 'counts' : 'does not count'}: ${why}`, () => {
      assert.equal(isCanaryInvocation(cmd), expected, cmd);
    });
  }

  it('keeps a plain-arm stream free of Canary bytes even though the path says canary', () => {
    const s = parseStream([
      assistant(USAGE(10), [bash(`cd "${plainPath}" && npm test`, 't1')], 'm1'),
      toolResult('x'.repeat(2000)),
    ].join('\n'));
    assert.equal(s.commands.canary, 0);
    assert.equal(s.bytes.canaryVisible, 0);
    assert.equal(s.commands.checks, 1, 'the check it ran is still measured');
  });
});

describe('stream ledger: the measured wire format (partial per-message usage)', () => {
  // Real shape, abbreviated from tooling/probes/stream-usage-shape.mjs: one tool call, two
  // requests, four assistant events over two message ids, zero output on every event.
  const real = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'qwen3.8-flash' }),
    JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', exit_code: 0, outcome: 'success', output: 'PONYTAIL MODE ACTIVE'.repeat(20) }),
    assistant(PARTIAL(), [{ type: 'thinking', thinking: 'let me read it' }], 'msg_A'),
    assistant(PARTIAL(), [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'VERSION.txt' } }], 'msg_A'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\tshape-fixture\n' }] } }),
    assistant(PARTIAL(), [{ type: 'thinking', thinking: 'done' }], 'msg_B'),
    assistant(PARTIAL(), [{ type: 'text', text: 'shape-fixture' }], 'msg_B'),
    JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 11122,
      total_cost_usd: 0.129, result: 'shape-fixture',
      usage: { input_tokens: 12, output_tokens: 96, cache_read_input_tokens: 17658, cache_creation_input_tokens: 17752 },
      modelUsage: { 'qwen3.8-flash': { inputTokens: 830, outputTokens: 208, cacheReadInputTokens: 17658, cacheCreationInputTokens: 17752, costUSD: 0.129 } },
    }),
  ].join('\n');

  it('does not count one message twice when the CLI emits it one content block per event', () => {
    const s = parseStream(real);
    assert.equal(s.assistantEvents, 4, 'four events on the wire');
    assert.equal(s.messages, 2, 'but two messages, and two turns');
    assert.equal(s.turns, 2, 'the result event is authoritative for turns');
    assert.equal(s.toolCalls.length, 1, 'the tool_use block appears once');
  });

  it('refuses to sum partial per-message usage into a token total', () => {
    const s = parseStream(real);
    assert.equal(s.streamedUsageUsable, false, 'output accounting was absent on every message');
    assert.equal(s.usage.total, 12 + 96 + 17658 + 17752,
      'the headline is the result event figure — the same field every stored batch used');
    assert.match(s.usage.source, /result\.usage/);
    assert.equal(s.sessionUsage.total, 830 + 208 + 17658 + 17752,
      'modelUsage is recorded beside it as the CLI\'s wider per-model session total');
    // The over-count that a real run exposed: 4 events × 16,985 = 67,940 "tokens" that the model
    // never spent. The ledger now attributes usage per MESSAGE, so the partial figure is 2 × it.
    assert.equal(s.streamedUsage.total, 2 * 16985, 'the partial figure is still recorded, labelled');
  });

  it('marks the tail as unavailable instead of attributing tokens it cannot attribute', () => {
    const s = parseStream(real);
    assert.equal(s.tail.tokensAfterLastEdit, null);
    assert.equal(s.tail.tokensAvailable, false);
    assert.equal(s.tail.shareOfTokensAfterLastEdit, null);
  });

  it('measures hook output, which is context the model was given for free', () => {
    const s = parseStream(real);
    assert.equal(s.hooks.count, 1);
    assert.equal(s.hooks.names[0], 'SessionStart:startup');
    assert.equal(s.bytes.hookOutput, 'PONYTAIL MODE ACTIVE'.length * 20);
    assert.equal(s.hooks.canaryCount, 0);
  });

  it('recognises Canary\'s own Stop hook from the stream, not by inference', () => {
    // The real block reason (tooling/probes/checkpoint-payload.mjs) opens with
    // "Canary verification failed: …", which is how the gate is attributable from the stream.
    const reason = 'Canary verification failed: tests — total includes negative values (5 !== 0). Full output: <log>';
    const s = parseStream([hook('Stop', reason), hook('PostToolUse')].join('\n'));
    assert.equal(s.hooks.count, 2);
    assert.equal(s.hooks.canaryCount, 1, 'the hook whose output names Canary is the gate');
  });

  it('detects a refusal that reached the model, separately from hook events', () => {
    // MEASURED: this CLI emits no hook events for the project-level Stop hook, so a block can only
    // be seen in the stream as a user message. Both signals are recorded, neither is assumed.
    const blocked = parseStream(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'Canary verification failed: tests — 2 checks did not pass. Full output: <log>' }] },
    }));
    assert.equal(blocked.gate.messages, 1);
    assert.equal(blocked.gate.bytes > 0, true);
    assert.equal(blocked.hooks.count, 0, 'no hook events were needed for the block to be visible');
    assert.match(blocked.gate.samples[0], /Canary verification failed/);
    const clean = parseStream(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'ok' }] } }));
    assert.equal(clean.gate.messages, 0, 'ordinary conversation is not a refusal');
  });
});
