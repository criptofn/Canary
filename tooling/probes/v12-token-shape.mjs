// Token-shape analysis of a real transport log.
//
//   node tooling/probes/v12-token-shape.mjs <transport.log> [more.log ...]
//
// Answers the release question "is the remaining overhead removable orchestration
// waste, or is it fundamental?" with measurements instead of estimates:
//   * how many model turns the confined worker needed, and what each turn cost;
//   * how large every tool RESULT was (the content that is re-read on every later turn);
//   * how much of the total is the accumulated context being re-read (cache-read).
// Nothing here is a correctness or security verdict; it only describes cost shape.
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tooling/probes/v12-token-shape.mjs <transport.log> [...]'); process.exit(2); }

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const events = text.split('\n').filter(l => l.trim().startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = [...events].reverse().find(e => e.type === 'result');
  if (!result) { console.log(`${path.basename(file)}: no result event (transport never completed)`); continue; }
  const u = result.usage ?? {};
  const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const turns = result.num_turns ?? null;

  // Tool calls and their results, in order. A result is what the model must carry in
  // context for every subsequent turn, so its size is the marginal cost of that turn.
  const calls = [];
  const results = [];
  for (const e of events) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') calls.push({ name: block.name, op: block.input?.op ?? null, bytes: JSON.stringify(block.input ?? {}).length });
      if (block.type === 'tool_result') {
        const body = Array.isArray(block.content) ? block.content.map(c => c.text ?? '').join('') : String(block.content ?? '');
        results.push({ bytes: body.length, head: body.slice(0, 80).replace(/\s+/g, ' ') });
      }
    }
  }
  const sizes = results.map(r => r.bytes).sort((a, b) => b - a);
  const sum = sizes.reduce((a, b) => a + b, 0);
  const ops = calls.reduce((acc, c) => (acc[c.op ?? c.name] = (acc[c.op ?? c.name] ?? 0) + 1, acc), {});
  console.log(`\n=== ${path.basename(file)} ===`);
  console.log(`turns=${turns} toolCalls=${calls.length} totalTokens=${total} (in ${u.input_tokens ?? 0} / out ${u.output_tokens ?? 0} / cacheRead ${u.cache_read_input_tokens ?? 0} / cacheWrite ${u.cache_creation_input_tokens ?? 0})`);
  console.log(`cacheRead per turn ~${turns ? Math.round((u.cache_read_input_tokens ?? 0) / turns) : '?'}; output per turn ~${turns ? Math.round((u.output_tokens ?? 0) / turns) : '?'}`);
  console.log(`tool ops: ${JSON.stringify(ops)}`);
  console.log(`tool RESULTS: n=${results.length} bytes=${sum} max=${sizes[0] ?? 0} p50=${sizes[Math.floor(sizes.length / 2)] ?? 0}`);
  console.log(`largest results: ${JSON.stringify(results.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5).map(r => ({ bytes: r.bytes, head: r.head.slice(0, 60) })))}`);
  // Cost accounting: how much of the total is re-reading accumulated context?
  const contextShare = total ? ((u.cache_read_input_tokens ?? 0) / total * 100).toFixed(1) : '?';
  const outputShare = total ? ((u.output_tokens ?? 0) / total * 100).toFixed(1) : '?';
  console.log(`share: cache-read ${contextShare}% · output ${outputShare}% · fresh input ${total ? ((u.input_tokens ?? 0) / total * 100).toFixed(2) : '?'}% · cache-write ${total ? ((u.cache_creation_input_tokens ?? 0) / total * 100).toFixed(1) : '?'}%`);
  const avg = results.length ? sum / results.length : 0;
  console.log(`if every tool result were capped at 4KB: result bytes ${sum} -> ${Math.min(sum, avg > 4096 ? results.length * 4096 : sum)} (only the portion above the cap is ever saved)`);
}
