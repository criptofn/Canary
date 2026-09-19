// Which models the INSTALLED harness can actually reach.
//
// The release instruction requires an availability check before any secondary-model
// validation, and forbids inventing an identifier or silently substituting a model:
//   node tooling/probes/v12-model-availability.mjs
//
// It reports the model aliases the harness configuration declares and the model ids the
// configured endpoint itself advertises. It never prints, logs or transmits the
// credential beyond the request header the endpoint requires.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const env = settings.env ?? {};
console.log('=== harness configuration ===');
console.log(`settings: ${settingsPath}`);
console.log(`ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL ?? '(unset)'}`);
console.log(`ANTHROPIC_MODEL: ${env.ANTHROPIC_MODEL ?? '(unset)'}`);
console.log(`CLAUDE_CODE_SUBAGENT_MODEL: ${env.CLAUDE_CODE_SUBAGENT_MODEL ?? '(unset)'}`);
const aliases = { ...(env.ANTHROPIC_DEFAULT_OPUS_MODEL ? { opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL } : {}),
  ...(env.ANTHROPIC_DEFAULT_SONNET_MODEL ? { sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL } : {}),
  ...(env.ANTHROPIC_DEFAULT_HAIKU_MODEL ? { haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL } : {}) };
console.log(`model aliases: ${JSON.stringify(aliases)}`);
console.log(`modelSettings keys: ${JSON.stringify(Object.keys(settings.modelSettings ?? {}))}`);
console.log(`credential present: ${Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)}`);

// Ask the endpoint what it serves. Failure is reported, never worked around.
const base = env.ANTHROPIC_BASE_URL;
if (!base) { console.log('\n=== endpoint model list ===\nno base URL configured; cannot enumerate'); process.exit(0); }
try {
  const response = await fetch(new URL('/v1/models', base), {
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY ?? '', authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN ?? ''}`,
      'anthropic-version': '2023-06-01' },
  });
  const body = await response.text();
  console.log(`\n=== endpoint model list ===\nHTTP ${response.status}`);
  let ids = null;
  try { const parsed = JSON.parse(body); ids = (parsed.data ?? parsed.models ?? []).map(m => m.id ?? m.name ?? m.model); } catch { }
  console.log(ids && ids.length ? `ids: ${JSON.stringify(ids)}` : `body: ${body.slice(0, 600)}`);
} catch (e) {
  console.log(`\n=== endpoint model list ===\nunreachable: ${e.message}`);
}
const mentions = JSON.stringify(settings).match(/[A-Za-z0-9._-]*(apollo|gpt|gemini|claude|qwen|deepseek)[A-Za-z0-9._-]*/gi) ?? [];
console.log(`\nidentifiers mentioned anywhere in the harness settings: ${JSON.stringify([...new Set(mentions)])}`);
