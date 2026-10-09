import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCodexLocalUsageEvidence, parseCodexJsonl } from './v15-codex-jsonl.mjs';

test('parses Codex local JSONL completion, final message, model and native usage', () => {
  const usage = { input_tokens: 2050, cached_input_tokens: 0, output_tokens: 1619, reasoning_output_tokens: 0 };
  const raw = [
    JSON.stringify({ type: 'thread.started', thread_id: 'local-smoke' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'LOCAL_OK' } }),
    JSON.stringify({ type: 'turn.completed', usage }),
  ].join('\n');
  const parsed = parseCodexJsonl(raw, 'qwen3.5:9b');
  assert.equal(parsed.parseErrors, 0);
  assert.equal(parsed.model, 'qwen3.5:9b');
  assert.deepEqual(parsed.agentMessages, ['LOCAL_OK']);
  assert.equal(parsed.result.subtype, 'success');
  assert.deepEqual(parsed.result.usage, usage);
  assert.equal(parsed.result.total_cost_usd, null);
});

test('does not invent completion or usage when Codex has no terminal success', () => {
  const raw = JSON.stringify({ type: 'turn.failed', error: { message: 'local failure' } });
  const parsed = parseCodexJsonl(raw, 'qwen3.5:9b');
  assert.equal(parsed.result, null);
  assert.equal(parsed.parseErrors, 0);
});

test('records malformed trailing output without losing a completed Codex usage event', () => {
  const raw = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }) + '\n{' ;
  const parsed = parseCodexJsonl(raw, 'qwen3.5:9b');
  assert.equal(parsed.parseErrors, 1);
  assert.equal(parsed.result.usage.input_tokens, 1);
});

test('accepts the digest in the nested Ollama runtime observation and rejects incomplete evidence', () => {
  const usage = { input_tokens: 2050, output_tokens: 390, cached_input_tokens: 0, reasoning_output_tokens: 0 };
  const runtime = { match: { digest: 'a'.repeat(64) } };
  assert.equal(hasCodexLocalUsageEvidence(usage, runtime), true);
  assert.equal(hasCodexLocalUsageEvidence(usage, { match: {} }), false);
  assert.equal(hasCodexLocalUsageEvidence({ ...usage, output_tokens: null }, runtime), false);
});
