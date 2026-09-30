/** Read reported counters without estimating missing values. */
export function parseAnthropicUsage(text) {
  let usage = {}, complete = false;
  try {
    const value = JSON.parse(text);
    usage = value.usage ?? {};
    complete = value.type === 'message';
  } catch {
    let finalOutputReported = false;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));
        usage = { ...usage, ...(event.message?.usage ?? {}), ...(event.usage ?? {}) };
        if (event.type === 'message_delta' && Object.hasOwn(event.usage ?? {}, 'output_tokens')) finalOutputReported = true;
        if (event.type === 'message_stop') complete = true;
      } catch { /* Invalid events remain in the raw capture. */ }
    }
    complete &&= finalOutputReported;
  }
  complete &&= ['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0);
  return { usage, complete };
}
