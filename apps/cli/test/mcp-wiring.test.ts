/**
 * v1.3 §C — `setup` registers Canary's MCP server, so the agent can ASK Canary whether it is done
 * instead of running its own verification campaign. Measured token effect: on the long fixture ~36 of
 * 57 confined execs were the model re-running its own checks (see docs/V1.3-PRODUCT-AUDIT.md).
 *
 * The risk this file pins is not whether the server works — `mcp.test.ts` covers the protocol — but
 * that installing it makes Canary write ONE MORE FILE into a user's repository. So every property the
 * Stop hook already has must hold for it, and the failure directions matter:
 *
 *   - a stranger's MCP server entry is never touched, and a server under OUR KEY that we did not
 *     write is REFUSED rather than replaced (a confused-deputy guard: silently swapping someone's
 *     `canary` server would be Canary claiming an entry it does not own);
 *   - the entry is owned by its ARGV SIGNATURE, not by the key name, so uninstall removes exactly
 *     what this installation wrote;
 *   - a re-run is byte-identical, and uninstall leaves the file exactly as it found it otherwise.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  hasMcpEntry, installMcpServer, mcpArgSignature, mcpConfigPath, mcpServerArgs,
  pruneOwnedMcp, uninstallHooks, type CanaryConfig,
} from '../src/onboarding.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mcp-wiring-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const repo = (): string => {
  const root = path.join(TMP, `repo-${seq++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
};
const CLI = 'C:\\fake\\canary\\main.js';
const backups = (root: string): string => path.join(root, '.canary', 'backups');
const read = (root: string): Record<string, unknown> => JSON.parse(fs.readFileSync(mcpConfigPath(root), 'utf8')) as Record<string, unknown>;
const servers = (root: string): Record<string, unknown> => (read(root).mcpServers ?? {}) as Record<string, unknown>;
const write = (root: string, doc: unknown): void => fs.writeFileSync(mcpConfigPath(root), JSON.stringify(doc, null, 2) + '\n');

describe('v1.3 MCP wiring: setup registers the server without owning anything it did not write', () => {
  it('writes one entry that runs THIS Canary as an MCP server, and records it as an mcp touch', () => {
    const root = repo();
    const res = installMcpServer(root, CLI, new Set(), backups(root));
    assert.equal(res.ok, true, res.problem);
    assert.equal(res.touched?.kind, 'mcp');
    assert.equal(res.touched?.created, true);
    const entry = servers(root).canary as { command: string; args: string[] };
    assert.deepEqual(entry.args, mcpServerArgs(CLI));
    assert.equal(entry.args.at(-1), 'mcp');
    assert.ok(entry.command.length > 0, 'a server needs a command');
  });

  it("preserves a stranger's server entry byte-for-byte", () => {
    const root = repo();
    const foreign = { command: 'node', args: ['their-server.js'], env: { A: '1' } };
    write(root, { mcpServers: { someoneelse: foreign } });
    assert.equal(installMcpServer(root, CLI, new Set(), backups(root)).ok, true);
    assert.deepEqual(servers(root).someoneelse, foreign);
    assert.ok(servers(root).canary, 'and ours is added beside it');
  });

  it('REFUSES to replace a server under our key that we did not write, and changes nothing', () => {
    const root = repo();
    const squatter = { command: 'node', args: ['not-ours.js'] };
    write(root, { mcpServers: { canary: squatter } });
    const before = fs.readFileSync(mcpConfigPath(root), 'utf8');
    const res = installMcpServer(root, CLI, new Set(), backups(root));
    assert.equal(res.ok, false);
    assert.match(String(res.problem), /did not write/);
    assert.equal(fs.readFileSync(mcpConfigPath(root), 'utf8'), before, 'a refusal must not touch the file');
  });

  it('replaces its OWN previous entry, so a re-run is idempotent and never stacks', () => {
    const root = repo();
    installMcpServer(root, CLI, new Set(), backups(root));
    const first = fs.readFileSync(mcpConfigPath(root), 'utf8');
    const owned = new Set([mcpArgSignature(mcpServerArgs(CLI))]);
    assert.equal(installMcpServer(root, CLI, owned, backups(root)).ok, true);
    assert.equal(fs.readFileSync(mcpConfigPath(root), 'utf8'), first);
    assert.equal(Object.keys(servers(root)).length, 1, 'exactly one entry, never a growing pile');
  });

  it('refuses invalid JSON and a non-object mcpServers, writing nothing', () => {
    const bad = repo();
    fs.writeFileSync(mcpConfigPath(bad), '{ not json');
    const r1 = installMcpServer(bad, CLI, new Set(), backups(bad));
    assert.equal(r1.ok, false);
    assert.match(String(r1.problem), /not valid JSON/);
    assert.equal(fs.readFileSync(mcpConfigPath(bad), 'utf8'), '{ not json');

    const shaped = repo();
    write(shaped, { mcpServers: ['not', 'an', 'object'] });
    const r2 = installMcpServer(shaped, CLI, new Set(), backups(shaped));
    assert.equal(r2.ok, false);
    assert.match(String(r2.problem), /mcpServers/);
  });

  it('ownership is the ARGV SIGNATURE, so a same-named foreign server is never mistaken for ours', () => {
    const root = repo();
    write(root, { mcpServers: { canary: { command: 'node', args: ['not-ours.js'] } } });
    const owned = new Set([mcpArgSignature(mcpServerArgs(CLI))]);
    assert.equal(hasMcpEntry(read(root), owned), false, 'the key name alone proves nothing');
    assert.equal(pruneOwnedMcp(read(root), owned), 0, 'and it must not be pruned');
    // the recorded signature, on the other hand, is ours and IS prunable
    write(root, { mcpServers: { canary: { command: 'node', args: mcpServerArgs(CLI) } } });
    assert.equal(hasMcpEntry(read(root), owned), true);
    const doc = read(root);
    assert.equal(pruneOwnedMcp(doc, owned), 1);
    assert.equal(doc.mcpServers, undefined, 'the last server removed takes the empty section with it');
  });
});

describe('v1.3 MCP wiring: uninstall undoes exactly what setup did', () => {
  const config = (root: string, touched: CanaryConfig['touched']): CanaryConfig => ({
    version: 'product-0.1', installedAt: '2026-01-01T00:00:00.000Z', pm: 'npm', plan: [],
    cliPath: CLI, hookCommand: `node "${CLI}" checkpoint`, hookCommands: [`node "${CLI}" checkpoint`],
    mcpArgSignatures: [mcpArgSignature(mcpServerArgs(CLI))], touched,
  });

  it('removes our MCP entry and keeps the neighbour, leaving the file in place', () => {
    const root = repo();
    const foreign = { command: 'node', args: ['their-server.js'] };
    write(root, { mcpServers: { someoneelse: foreign } });
    const res = installMcpServer(root, CLI, new Set(), backups(root));
    assert.equal(res.ok, true);
    const out = uninstallHooks(root, config(root, [res.touched!]));
    assert.deepEqual(out.problems, []);
    assert.equal(out.removed, 1);
    assert.deepEqual(servers(root).someoneelse, foreign);
    assert.equal(servers(root).canary, undefined);
  });

  it('deletes the file it created when nothing else is left in it', () => {
    const root = repo();
    const res = installMcpServer(root, CLI, new Set(), backups(root));
    const out = uninstallHooks(root, config(root, [res.touched!]));
    assert.equal(out.removed, 1);
    assert.equal(fs.existsSync(mcpConfigPath(root)), false, 'a file Canary created and emptied is removed');
  });
});
