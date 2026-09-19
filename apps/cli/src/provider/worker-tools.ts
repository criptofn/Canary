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
        // ONE shape, deliberately: a call carries an ordered list of operations. The
        // one-operation-at-a-time form is not offered, because every model round trip
        // re-reads the whole conversation and the session is spent on round trips.
        // Authority is unchanged: the same four primitives, the same confined paths.
        case 'tools/list': result = { tools: [{ name: 'implement',
          description: 'Work inside the confined workspace by sending an ordered list of operations in ONE call. '
            + 'Operations: list (a directory), read (a file), write (a file), exec (run argv). '
            + 'Send every operation you already know together — they run in order in one confined process — and make a '
            + 'further call only for what genuinely depends on an earlier result. '
            + 'A non-zero exit status is a normal result; a refused operation stops the list and says which one. '
            + 'No authority operations: setup, sealing, review and promotion are not available here.',
          inputSchema: {
            type: 'object',
            properties: {
              operations: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object',
                properties: { op: { enum: ['list', 'read', 'write', 'exec'] }, path: { type: 'string' }, text: { type: 'string' },
                  argv: { type: 'array', items: { type: 'string' } } }, required: ['op'], additionalProperties: false } },
            },
            required: ['operations'], additionalProperties: false,
          } }] }; break;
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
