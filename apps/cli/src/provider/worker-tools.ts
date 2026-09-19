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
        // Authority is unchanged: the same primitives, the same confined paths.
        //
        // v1.3 §D: `edit` is described in terms of the cost it removes, because the cost is the
        // model's OWN output — every byte it sends is re-read on every later turn, and the measured
        // dominant term for a long task was whole-file `write` re-emissions (src/api.js, 979 B on
        // disk, written nine times). A description that only lists verbs does not tell the caller
        // WHY one verb is cheaper, and the caller is the one paying.
        case 'tools/list': result = { tools: [{ name: 'implement',
          description: 'Work inside the confined workspace by sending an ordered list of operations in ONE call. '
            + 'Operations: list (a directory), read (a file), write (CREATE a file), edit (CHANGE an existing file), exec (run argv). '
            + 'To change an existing file use `edit` with `find` (an exact snippet that occurs EXACTLY ONCE) and `replace` '
            + '(the text that takes its place; "find":"" replaces the whole file). Every byte you send stays in this '
            + 'conversation and is re-read on every later turn, so send the part that changes, not the file. '
            + 'Send every operation you already know together — they run in order in one confined process — and make a '
            + 'further call only for what genuinely depends on an earlier result. '
            + 'A non-zero exit status is a normal result; a refused operation stops the list and says which one. '
            + 'No authority operations: setup, sealing, review and promotion are not available here.',
          inputSchema: {
            type: 'object',
            properties: {
              operations: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object',
                properties: { op: { enum: ['list', 'read', 'write', 'edit', 'exec'] }, path: { type: 'string' }, text: { type: 'string' },
                  find: { type: 'string' }, replace: { type: 'string' },
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
