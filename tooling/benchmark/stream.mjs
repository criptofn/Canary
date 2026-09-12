/**
 * WHERE DID THE TOKENS GO? — the parser behind the token ledger.
 *
 * The owner's requirement is NEGATIVE overhead: an agent working with Canary should spend FEWER
 * model tokens than the same agent without it, because Canary does the verification instead of
 * the model. That cannot be engineered from a single total, so this module turns the CLI's
 * `--output-format stream-json` event stream into the ledger the harness needs:
 *
 *   - how many requests the agent made and which carried tool calls,
 *   - every tool call, what it ran, and HOW MANY BYTES OF OUTPUT the model was shown,
 *   - how much of that output came from Canary itself,
 *   - how many times the project's own checks were run by the model (the work Canary is
 *     supposed to take over),
 *   - the tail: how many turns were spent after the last file edit,
 *   - the hooks that ran, including Canary's own Stop hook.
 *
 * ── MEASURED SHAPE (tooling/probes/stream-usage-shape.mjs, real run 2026-09-12) ──
 * Three facts here were NOT what the first version of this module assumed, and getting them
 * wrong would have silently mis-stated every token number:
 *
 *   1. An assistant event carries ONE content block, not one turn. A message with a thinking
 *      block and a tool_use appears as TWO events with the SAME `message.id` (measured:
 *      4 assistant events for `num_turns: 2`). Counting events over-counts the work by 2x, so
 *      tool calls are de-duplicated by tool id and turns come from the result event.
 *   2. `message.usage` on those events is PARTIAL: `output_tokens: 0` on every one, while the
 *      run really produced output (result event: `output_tokens: 96`). Summing per-message usage
 *      produced 67,940 "tokens" against the CLI's own 36,448. So per-message usage is recorded
 *      as `streamed` and marked unusable when it is; the authoritative total is the CLI's own
 *      `modelUsage` (session totals), and `usage` alone is the LAST REQUEST, not the session.
 *      Consequence, stated rather than papered over: on this wire format "tokens after the last
 *      edit" cannot be attributed per turn, so the tail reports TURNS and marks tokens null.
 *   3. The run emits `system`/`hook_started` + `hook_response` events for every hook, including
 *      user-level ones. Their output is injected into the model's context, so it is measured —
 *      and Canary's Stop hook is visible here rather than inferred.
 *
 * It is deliberately TOLERANT of shape drift: an unknown event type is counted, not fatal, and a
 * missing result event is reported as such. A parser that throws on an unexpected field would
 * turn a model-interface change into a lost benchmark run.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Text of a tool_result content field, whatever shape it arrives in. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return '';
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Commands that mean "the model ran the project's own checks". */
const CHECK_CMD = /(?:^|[\s&|;(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|verify|lint|typecheck)\b|\bnode\s+run-tests\.js\b|\bcargo\s+test\b|\bgo\s+test\b|\bpytest\b|\bpython\s+-m\s+(?:pytest|unittest)\b|\bctest\b|\bmake\s+(?:test|check)\b/i;

/**
 * Text that means the agent was TOLD, inside its own session, that Canary refused its completion.
 *
 * MEASURED limit, stated rather than assumed: this CLI emits `system`/`hook_response` events for
 * some hook sources (SessionStart, from user settings) but NOT for the project-level Stop hook —
 * a canary trial whose Stop hook demonstrably fired (it wrote `.canary/last-checkpoint.json`
 * during the run) produced zero hook events in its stream. So the checkpoint file stays the
 * authoritative source for "the gate ran", and this pattern is the stream-side evidence that a
 * BLOCK reached the model.
 */
const GATE_MSG = /Canary verification failed|NO PROOF, NO DONE|canary (?:checkpoint|doctor|finish)/i;

/**
 * Did this command INVOKE Canary? — which is not the same as "does the string contain 'canary'".
 *
 * MEASURED false positive: a trial works inside `…\Temp\canary-bench-<task>-<arm>-<rand>\project`,
 * so in the PLAIN arm two commands (`ls -R "<path>" | head -50`, `cd "<path>" && npm test`) were
 * counted as Canary invocations, and their output as "Canary-visible bytes". That corrupts exactly
 * the two columns the negative-overhead claim rests on, so the test is about invocation:
 *
 *   1. the repository's own CLI entry point, or
 *   2. a bare `canary <subcommand>` at a command boundary, or
 *   3. a canary binary by path (`/usr/local/bin/canary doctor`).
 *
 * Quoted segments are stripped first, because a path is data, not an invocation.
 */
export function isCanaryInvocation(command) {
  const cmd = typeof command === 'string' ? command : '';
  if (/apps[\\/]cli[\\/]dist[\\/]src[\\/]main\.js/.test(cmd)) return true;
  // A path segment that IS the canary binary, followed by a subcommand-like word.
  if (/[\\/]canary(?:\.exe|\.cmd|\.js|\.mjs)?\s+[a-z][a-z-]*/i.test(cmd)) return true;
  const withoutQuoted = cmd.replace(/"[^"]*"|'[^']*'/g, ' ');
  return /(?:^|[\s&|;(])canary\s+[a-z][a-z-]*/.test(withoutQuoted);
}

/**
 * @param {string} stream the raw `stream-json` output (one JSON object per line)
 * @returns {object} the ledger
 */
export function parseStream(stream) {
  const text = typeof stream === 'string' ? stream : '';
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const unknownTypes = {};
  const toolCalls = [];
  const toolResults = [];
  const hooks = [];
  const userTexts = [];
  const messages = new Map(); // message.id -> merged record (fact 1: one id, several events)
  const seenToolIds = new Set();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, source: null };
  const streamed = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  let sessionUsage = null;
  let finalText = '';
  let result = null;
  let sawResult = false;
  let parseErrors = 0;
  let lastFileEditTurn = -1;
  let model = null;
  let assistantEvents = 0;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { parseErrors += 1; continue; }
    if (!isObj(ev)) { parseErrors += 1; continue; }
    const type = String(ev.type ?? 'missing');
    // Which model actually served the run is a FACT about the trial, not an assumption:
    // the `system`/init event names it, and every assistant message repeats it.
    if (model === null && typeof ev.model === 'string' && ev.model !== '') model = ev.model;
    if (type === 'assistant') {
      assistantEvents += 1;
      const msg = isObj(ev.message) ? ev.message : {};
      if (model === null && typeof msg.model === 'string' && msg.model !== '') model = msg.model;
      const id = typeof msg.id === 'string' && msg.id !== '' ? msg.id : `anon-${messages.size}`;
      let rec = messages.get(id);
      if (rec === undefined) {
        const u = isObj(msg.usage) ? msg.usage : {};
        rec = {
          id,
          usage: {
            input: n(u.input_tokens), output: n(u.output_tokens),
            cacheRead: n(u.cache_read_input_tokens), cacheCreation: n(u.cache_creation_input_tokens),
          },
          tools: [],
        };
        rec.usage.total = rec.usage.input + rec.usage.output + rec.usage.cacheRead + rec.usage.cacheCreation;
        streamed.input += rec.usage.input; streamed.output += rec.usage.output;
        streamed.cacheRead += rec.usage.cacheRead; streamed.cacheCreation += rec.usage.cacheCreation;
        streamed.total += rec.usage.total;
        messages.set(id, rec);
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') finalText = block.text;
        if (block.type !== 'tool_use') continue;
        // Fact 1 again: the same content block can be re-emitted; a tool call is counted once.
        const toolId = typeof block.id === 'string' && block.id !== '' ? block.id : null;
        if (toolId !== null && seenToolIds.has(toolId)) continue;
        if (toolId !== null) seenToolIds.add(toolId);
        const name = String(block.name ?? 'unknown');
        const input = isObj(block.input) ? block.input : {};
        const command = typeof input.command === 'string' ? input.command : '';
        const filePath = typeof input.file_path === 'string' ? input.file_path : '';
        const call = { turn: messages.size - 1, name, command, file: filePath, isEdit: /^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(name) };
        toolCalls.push(call);
        rec.tools.push(name);
        if (call.isEdit) lastFileEditTurn = call.turn;
      }
    } else if (type === 'user') {
      const msg = isObj(ev.message) ? ev.message : {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') userTexts.push(block.text);
        if (block.type !== 'tool_result') continue;
        const out = contentText(block.content);
        toolResults.push({ bytes: out.length, isError: block.is_error === true, turn: messages.size });
      }
    } else if (type === 'system') {
      const subtype = String(ev.subtype ?? 'none');
      if (subtype === 'hook_response') {
        const out = typeof ev.output === 'string' ? ev.output : '';
        hooks.push({
          name: String(ev.hook_name ?? 'unknown'),
          event: String(ev.hook_event ?? 'unknown'),
          exitCode: typeof ev.exit_code === 'number' ? ev.exit_code : null,
          outcome: ev.outcome === undefined ? null : String(ev.outcome),
          outputBytes: out.length,
          isCanary: /canary/i.test(`${ev.hook_name ?? ''} ${out.slice(0, 400)}`),
        });
      } else {
        unknownTypes[`system:${subtype}`] = (unknownTypes[`system:${subtype}`] ?? 0) + 1;
      }
    } else if (type === 'result') {
      sawResult = true;
      result = {
        subtype: ev.subtype ?? null,
        isError: ev.is_error === true,
        numTurns: typeof ev.num_turns === 'number' ? ev.num_turns : null,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        text: typeof ev.result === 'string' ? ev.result : '',
      };
      if (result.text !== '' && finalText === '') finalText = result.text;
      // Fact 2: BOTH figures on the result event are session-level, and they differ in what they
      // include. `modelUsage` (per model) is the CLI's session total; `usage` is the session
      // aggregate that drops the fresh non-cached input of earlier requests (measured on a
      // 2-request run: 35,518 vs 36,448 — 2.6% apart). `usage` is kept as the headline because
      // every already-recorded batch used it, so deltas across batches stay comparable; the
      // session figure is recorded beside it rather than replacing it silently.
      const perModel = isObj(ev.modelUsage) ? ev.modelUsage : null;
      const u = isObj(ev.usage) ? ev.usage : {};
      usage.input = n(u.input_tokens); usage.output = n(u.output_tokens);
      usage.cacheRead = n(u.cache_read_input_tokens); usage.cacheCreation = n(u.cache_creation_input_tokens);
      usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
      usage.source = Object.keys(u).length > 0 ? 'result.usage (session, excludes earlier fresh input)' : null;
      if (perModel !== null && Object.keys(perModel).length > 0) {
        const session = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, models: [] };
        for (const [name, m] of Object.entries(perModel)) {
          if (!isObj(m)) continue;
          session.input += n(m.inputTokens); session.output += n(m.outputTokens);
          session.cacheRead += n(m.cacheReadInputTokens); session.cacheCreation += n(m.cacheCreationInputTokens);
          session.models.push({ name, costUsd: typeof m.costUSD === 'number' ? m.costUSD : null });
        }
        session.total = session.input + session.output + session.cacheRead + session.cacheCreation;
        sessionUsage = session;
        if (model === null) model = Object.keys(perModel)[0];
        if (usage.source === null) {
          usage.input = session.input; usage.output = session.output;
          usage.cacheRead = session.cacheRead; usage.cacheCreation = session.cacheCreation;
          usage.total = session.total;
          usage.source = 'modelUsage (session totals)';
        }
      }
    } else {
      unknownTypes[type] = (unknownTypes[type] ?? 0) + 1;
    }
  }

  // Fact 2's honesty test: per-message usage is trustworthy ONLY if every message carries output
  // accounting. If any message reports zero output while the session total shows output, the
  // per-message numbers are partial (measured: ALL of them were), and summing them would invent a
  // token figure. Partial usage still gets recorded, but never as a total and never as the tail.
  const streamedUsable = messages.size > 0 && [...messages.values()].every((m) => m.usage.output > 0);
  if (!sawResult || usage.total === 0) {
    // No result event (or no session figure): the only numbers available are the streamed ones.
    usage.input = streamed.input; usage.output = streamed.output;
    usage.cacheRead = streamed.cacheRead; usage.cacheCreation = streamed.cacheCreation;
    usage.total = streamed.total;
    usage.source = sawResult ? 'streamed per-message usage (no session total available)' : 'streamed per-message usage (no result event)';
  }

  const commands = toolCalls.filter((c) => c.name === 'Bash' || c.name === 'PowerShell').map((c) => c.command);
  const canaryCalls = commands.filter((c) => isCanaryInvocation(c));
  const checkCalls = commands.filter((c) => CHECK_CMD.test(c));
  const toolResultBytes = toolResults.reduce((a, r) => a + r.bytes, 0);

  // Agent-visible Canary bytes: the output of tool calls that invoked Canary, matched to the
  // results that followed them by position (the stream pairs them in order).
  let canaryVisibleBytes = 0;
  {
    const orderedCalls = toolCalls.filter((c) => c.command !== '' || c.isEdit);
    for (let i = 0; i < orderedCalls.length && i < toolResults.length; i += 1) {
      if (isCanaryInvocation(orderedCalls[i].command)) canaryVisibleBytes += toolResults[i].bytes;
    }
  }

  const perTurn = [...messages.values()].map((m, i) => ({ turn: i, usage: m.usage, tools: m.tools }));
  const turnsAfterLastEdit = lastFileEditTurn >= 0 ? perTurn.filter((t) => t.turn > lastFileEditTurn).length : 0;
  const tokensAfterLastEdit = streamedUsable && lastFileEditTurn >= 0
    ? perTurn.filter((t) => t.turn > lastFileEditTurn).reduce((a, t) => a + t.usage.total, 0)
    : null;

  const hookOutputBytes = hooks.reduce((a, h) => a + h.outputBytes, 0);
  const gateMessages = userTexts.filter((t) => GATE_MSG.test(t));

  return {
    lines: lines.length,
    parseErrors,
    unknownTypes,
    sawResult,
    result,
    model,
    // Fact 1, made visible: EVENTS are not TURNS. Both are reported so the difference can never
    // be silently mistaken for work the model did.
    assistantEvents,
    messages: messages.size,
    turns: result !== null && result.numTurns !== null ? result.numTurns : messages.size,
    streamedUsage: streamed,
    streamedUsageUsable: streamedUsable,
    usage,
    // The CLI's own per-model session totals, when it reports them. Same run, slightly wider
    // accounting than `usage`; recorded so the difference is visible instead of assumed away.
    sessionUsage,
    perTurn,
    toolCalls,
    toolResults,
    finalText,
    bytes: {
      toolResultTotal: toolResultBytes,
      largestToolResult: toolResults.reduce((a, r) => Math.max(a, r.bytes), 0),
      canaryVisible: canaryVisibleBytes,
      hookOutput: hookOutputBytes,
    },
    hooks: {
      count: hooks.length,
      canaryCount: hooks.filter((h) => h.isCanary).length,
      names: [...new Set(hooks.map((h) => h.name))],
      events: hooks,
    },
    // The stream-side evidence that a refusal REACHED the model. Counted separately from hook
    // events, because this CLI does not emit hook events for the project-level Stop hook.
    gate: {
      messages: gateMessages.length,
      bytes: gateMessages.reduce((a, t) => a + t.length, 0),
      samples: gateMessages.slice(0, 2).map((t) => t.slice(0, 200)),
    },
    commands: {
      total: commands.length,
      canary: canaryCalls.length,
      checks: checkCalls.length,
      canaryCommands: canaryCalls.slice(0, 20),
    },
    tail: {
      lastFileEditTurn,
      turnsAfterLastEdit,
      tokensAfterLastEdit,
      tokensAvailable: tokensAfterLastEdit !== null,
      shareOfTokensAfterLastEdit: tokensAfterLastEdit === null || usage.total === 0
        ? null
        : Math.round((tokensAfterLastEdit / usage.total) * 1000) / 10,
    },
  };
}
