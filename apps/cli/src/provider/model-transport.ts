/** Trusted model I/O only. Native coding tools, skills, hooks and configuration
 * discovery are disabled. The sole model capability is our confined MCP tool. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { selfArgv, readConfig, readTaskRecord, unboundRequirements } from '../onboarding.js';
import { enrollment, productionTool } from './production.js';

export const TRANSPORT_TOOL = 'mcp__canary_confined__implement';
export function modelTransportArgs(store: string, work: string, prompt: string, model: string): string[] {
  const mcp = { mcpServers: { canary_confined: { command: process.execPath,
    args: selfArgv(['provider', 'worker-tools', store, work]),
    env: { TEMP: os.tmpdir(), TMP: os.tmpdir(), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '' } } } };
  return ['--bare', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--allowedTools', TRANSPORT_TOOL,
    '--model', model, '--output-format', 'stream-json', '--verbose', '-p', prompt];
}
export async function modelTransport(store: string, work: string, prompt: string, model: string, executable: string): Promise<number> {
  const e = enrollment(store), cfg = readConfig(e.base);
  if (!cfg || cfg === 'corrupt' || !readTaskRecord(e.base)) throw new Error('trusted task preflight missing');
  if (unboundRequirements(e.base, cfg).unbound.length) throw new Error('REQUIREMENT UNBOUND: no model execution');
  if (!path.isAbsolute(executable)) throw new Error('operator must select an absolute transport executable');
  // Exercise the exact executor before the model may issue any operation.
  const preflight = productionTool(store, work, { op: 'list', path: '.' }) as { output?: { error?: string } };
  if (preflight.output?.error) throw new Error('confined workspace preflight failed');
  const control = fs.mkdtempSync(path.join(e.store, 'transport-'));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { USERPROFILE: control, HOME: control, APPDATA: control, LOCALAPPDATA: control, TEMP: control, TMP: control,
    CLAUDE_CONFIG_DIR: control, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const child = spawn(executable, modelTransportArgs(store, work, prompt, model), {
    cwd: control, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Stream telemetry unchanged. Neither text nor tool requests are evaluated here.
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('model transport timed out; no promotion')); }, 15 * 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 2); });
  });
}
