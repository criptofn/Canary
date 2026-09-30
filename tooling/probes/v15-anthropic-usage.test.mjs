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
