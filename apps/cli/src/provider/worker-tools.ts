/** Model I/O bridge. Only this fixed implementation tool is exposed; setup,
 * sealing, review and promotion are not model-callable transport operations. */
import readline from 'node:readline';
import { productionTool } from './production.js';

export async function workerTools(store: string, work: string): Promise<number> {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line.length > 2 * 1024 * 1024) return 2;
    let req;
    try { req = JSON.parse(line); } catch { return 2; }
    if (req.id === undefined) continue;
    let result;
    try {
      switch (req.method) {
        case 'initialize': result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'canary-confined', version: '1' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: [{ name: 'implement', description: 'Read, list, write or execute argv inside the confined workspace. No authority operations.',
          inputSchema: { type: 'object', properties: { op: { enum: ['list', 'read', 'write', 'exec'] }, path: { type: 'string' }, text: { type: 'string' },
            argv: { type: 'array', items: { type: 'string' } } }, required: ['op'], additionalProperties: false } }] }; break;
        case 'tools/call':
          if (req.params?.name !== 'implement') throw new Error('unknown confined tool');
          result = { content: [{ type: 'text', text: JSON.stringify(productionTool(store, work, req.params.arguments)) }] }; break;
        default: throw new Error('unsupported transport method');
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
    } catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: (e as Error).message } }) + '\n'); }
  }
  return 0;
}
