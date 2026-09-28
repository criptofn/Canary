export function parseCodexJsonl(rawStream, expectedModel) {
  const events = [];
  let parseErrors = 0;
  for (const line of rawStream.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { parseErrors++; }
  }
  const completedTurns = events.filter((event) => event.type === 'turn.completed');
  const failed = events.some((event) => event.type === 'turn.failed');
  const terminal = completedTurns.at(-1) ?? null;
  const result = terminal === null ? null : {
    subtype: failed ? 'error' : 'success',
    is_error: failed,
    stop_reason: null,
    usage: terminal.usage ?? null,
    num_turns: completedTurns.length,
    duration_ms: null,
    total_cost_usd: null,
  };
  const agentMessages = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
    .map((event) => String(event.item.text ?? ''));
  const warnings = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'error')
    .map((event) => String(event.item.message ?? ''));
  return {
    events,
    parseErrors,
    result,
    model: expectedModel,
    agentMessages,
    warnings,
  };
}

export function hasCodexLocalUsageEvidence(usage, runtime) {
  const usageKeys = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'];
  const digest = runtime?.digest ?? runtime?.match?.digest;
  return usage !== null && typeof usage === 'object'
    && usageKeys.every((key) => Number.isFinite(usage[key]) && usage[key] >= 0)
    && /^[0-9a-f]{64}$/i.test(digest ?? '');
}
