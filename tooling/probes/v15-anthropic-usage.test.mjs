import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnthropicUsage } from './v15-anthropic-usage.mjs';

const stream = (...events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
const start = { type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 0 } } };
const stop = { type: 'message_stop' };
test('a missing final output counter cannot certify an initial compatibility zero', () => {
  const result = parseAnthropicUsage(stream(start, stop));
  assert.equal(result.complete, false);
});
test('native streaming counters are cumulative and require a completed response', () => {
  const delta = { type: 'message_delta', usage: { input_tokens: 48, output_tokens: 7 } };
  assert.deepEqual(parseAnthropicUsage(stream(start, delta, stop)), {
    usage: { input_tokens: 48, output_tokens: 7 }, complete: true,
  });
  assert.equal(parseAnthropicUsage(stream(start, delta)).complete, false);
});
test('nonstream counters retain their native values, including a reported zero', () => {
  assert.deepEqual(parseAnthropicUsage(JSON.stringify({ type: 'message', usage: { input_tokens: 4, output_tokens: 0 } })), {
    usage: { input_tokens: 4, output_tokens: 0 }, complete: true,
  });
  for (const value of [undefined, -1, 0.5, '7']) {
    assert.equal(parseAnthropicUsage(JSON.stringify({ type: 'message', usage: { input_tokens: 4, output_tokens: value } })).complete, false);
  }
});
test('native model totals include the captured compaction request even when main usage omits it', async () => {
  const { claudeUsageMatchesNative } = await import('./v15-anthropic-usage.mjs');
  const terminal = { usage: { input_tokens: 1365530, output_tokens: 18411 },
    modelUsage: { 'qwen3.5:9b': { inputTokens: 1412037, outputTokens: 20416 } } };
  assert.equal(claudeUsageMatchesNative(terminal, { input_tokens: 1412037, output_tokens: 20416 }, 'qwen3.5:9b'), true);
});

test('missing or mismatched model totals cannot certify an otherwise matching main counter', async () => {
  const { claudeUsageMatchesNative } = await import('./v15-anthropic-usage.mjs');
  const usage = { input_tokens: 7, output_tokens: 2 };
  assert.equal(claudeUsageMatchesNative({ usage }, usage, 'qwen3.5:9b'), false);
  assert.equal(claudeUsageMatchesNative({ usage, modelUsage: { 'qwen3.5:9b': { inputTokens: 6, outputTokens: 2 } } }, usage, 'qwen3.5:9b'), false);
  assert.equal(claudeUsageMatchesNative({}, undefined, 'qwen3.5:9b'), false);
  for (const inputTokens of [-1, 7.5, '7', undefined]) {
    assert.equal(claudeUsageMatchesNative({ usage, modelUsage: { 'qwen3.5:9b': { inputTokens, outputTokens: 2 } } }, usage, 'qwen3.5:9b'), false);
  }
  assert.equal(claudeUsageMatchesNative({ usage, modelUsage: { 'qwen3.5:9b': { inputTokens: 7, outputTokens: 2 }, unexpected: {} } }, usage, 'qwen3.5:9b'), false);
});
