import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localCapabilities, requireAuthorizationLevel, validateNetworkAuthority } from '../src/platform-boundary.js';

test('capability is the minimum actually available boundary, with no HARDENED fallback', () => {
  assert.equal(localCapabilities(true).level, 'LOCAL');
  assert.equal(localCapabilities(false).level, 'ADVISORY');
  assert.equal(localCapabilities(true).unavailable.length, 6);
  requireAuthorizationLevel('LOCAL');
  for (const input of ['HARDENED', 'ADVISORY', 'UNSUPPORTED', undefined, true, { level: 'HARDENED', attested: true }]) assert.throws(() => requireAuthorizationLevel(input));
});
test('network policy has no ambient access or implicit wildcard', () => {
  validateNetworkAuthority({ mode: 'deny', origins: [] });
  validateNetworkAuthority({ mode: 'allowlist', origins: ['https://registry.npmjs.org'] });
  for (const input of [null, {}, { mode: 'allow' }, { mode: 'deny', origins: [], proxy: 'http://localhost' },
    { mode: 'allowlist', origins: ['https://example.com', 'https://example.com'] },
    ...['*', 'https://example.com/', 'https://user@example.com', 'file:///x', 'http://example.com', 'https://example.com#x'].map(x => ({ mode: 'allowlist', origins: [x] }))]) assert.throws(() => validateNetworkAuthority(input));
});
