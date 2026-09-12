/**
 * The redactor's own tests — a redactor nobody tests is a comment.
 *
 * The fixtures use OBVIOUSLY FAKE values with the right shapes. No real credential appears
 * in this repository, in its tests, or in any stored result (see `secret-scan.test.mjs`,
 * which is the guard that keeps it that way).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REDACTED, looksSecret, redactDeep, redactSecrets } from './redact.mjs';

describe('secret redaction', () => {
  it('removes token-shaped strings wherever they appear in prose', () => {
    const text = 'I used sk-sp-AAAABBBBCCCCDDDDEEEEFFFF to call the endpoint, then continued.';
    const r = redactSecrets(text);
    assert.equal(r.hits, 1);
    assert.doesNotMatch(r.text, /sk-sp-AAAABBBB/);
    assert.match(r.text, new RegExp(REDACTED));
    assert.equal(looksSecret(r.text), false);
  });

  it('removes a NAMED credential assignment in env, JSON and shell forms', () => {
    for (const text of [
      'ANTHROPIC_AUTH_TOKEN=zzzzzzzzzzzzzzzz',
      '"ANTHROPIC_AUTH_TOKEN": "zzzzzzzzzzzzzzzz"',
      'OPENAI_API_KEY=zzzzzzzzzzzzzzzz',
      'SOME_PASSWORD: hunter2hunter2',
    ]) {
      const r = redactSecrets(text);
      assert.equal(r.hits, 1, text);
      assert.equal(looksSecret(r.text), false, r.text);
    }
  });

  it('removes a Bearer header and keeps the header name readable', () => {
    const r = redactSecrets('Authorization: Bearer abcdefghijklmnop');
    assert.equal(r.hits, 1);
    assert.match(r.text, /Bearer <redacted>/);
  });

  it('leaves ordinary text and short identifiers alone', () => {
    for (const text of ['the tests pass', 'sk-1', 'PASSWORD is documented in SECURITY.md', 'token matches a', 'key=short']) {
      const r = redactSecrets(text);
      assert.equal(r.hits, 0, `over-redacted: ${text} -> ${r.text}`);
    }
  });

  it('redacts every string in a nested record, including inside arrays', () => {
    const record = {
      label: 't1',
      agentResult: { finalText: 'used sk-sp-AAAABBBBCCCCDDDDEEEEFFFF here' },
      notes: ['API_KEY=zzzzzzzzzzzzzzzz', 'harmless'],
    };
    const out = redactDeep(record);
    assert.doesNotMatch(JSON.stringify(out), /sk-sp-AAAABBBB/);
    assert.doesNotMatch(JSON.stringify(out), /zzzzzzzzzzzzzzzz/);
    assert.equal(out.label, 't1');
    assert.equal(out.notes[1], 'harmless');
  });

  it('does not mutate the input and tolerates non-strings', () => {
    const record = { a: 'sk-AAAABBBBCCCCDDDD' };
    const before = JSON.stringify(record);
    redactDeep(record);
    assert.equal(JSON.stringify(record), before, 'the input must be left alone');
    assert.equal(redactSecrets(undefined).text, '');
    assert.equal(redactDeep(42), 42);
    assert.equal(redactDeep(null), null);
  });
});
