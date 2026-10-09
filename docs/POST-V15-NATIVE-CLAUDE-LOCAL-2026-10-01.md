# Native Claude Code with local inference: executed preflight

## Result

Three native Claude Code sessions completed against the explicitly installed
Canary improvement. The real Claude Stop hook accepted the passing control and
blocked the failing control. The latter triggered native Stop feedback and a
second model response; the loop guard subsequently allowed handoff with the
checkpoint still **fail**, never pass. CLI exit 0 and the end of a model session
are distinct from a passed Canary verification.

| Session | Native API input/output tokens | CLI totals match | Actual hook/checkpoint |
| --- | --- | --- | --- |
| Connection | 227 / 432 | yes | no hook configured |
| Passing control | 1,543 / 737 | yes | native Stop; pass |
| Failing control | 3,429 / 144 | yes | native Stop; fail; handoff after guard |

This establishes a local native-agent route with recorded input/output usage.
It does not measure task repair, source correctness improvements, token savings,
or the full twelve-session pilot. Built-in tools and MCP were disabled for these
transport/hook controls, so MCP behavior and accounting remain unmeasured.
Separate cache/reasoning counters are not available in the recorded Ollama API
usage and are not inferred from the CLI's compatibility zero fields.

## Actual configuration and charge boundary

- Claude Code: **2.1.278**; Ollama: **0.33.2**.
- Local model: `qwen3.5:9b`, digest
  `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`.
- The actual loaded context length was **65,536** in all three sessions.
- Captured requests used `max_tokens: 32000` and `output_config.effort: high`.
  Temperature and thinking were absent from the request; no temperature-0 or
  separate reasoning-budget claim is made from the environment variables alone.
- Installed CLI SHA-256:
  `22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`.
  This is the local improved package, not the GitHub release artifact.
- Claude used a separate temporary profile and explicit session settings.
  Provider credentials and endpoint variables were removed from the inherited
  environment; personal settings were not edited or forwarded.
- The owned Ollama server logged `Ollama cloud disabled: true`. A loopback gateway
  accepted model requests only for the pinned local model and forwarded them
  only to that owned loopback server. Native request/response bytes were saved.
- No paid model endpoint was used: provider USD charge was **0**. Any USD price
  estimate emitted by Claude for an unrecognized model is not a provider bill.

This is LOCAL operation with the same OS user rights, not an OS network or
filesystem sandbox. The controlled model had no tools. A later real coding pilot
must preserve the explicit local routing and record its different access scope.

The optional Claude `/api/hello` probes received HTTP 400 from the recording
gateway. They did not prevent the four successful `/v1/messages` requests. This
compatibility limitation is visible in `summary.json`; no failed model request
or absent token counter was substituted with an estimate.

The owned model was unloaded (`/api/ps`: zero models), the server stopped and the
temporary project/profile removed. A subsequent host process inventory found no
Ollama process.

## Reproduction and raw evidence

```powershell
node tooling/probes/v15-claude-local-preflight.mjs --cli '<absolute installed main.js>' --claude '<absolute claude.exe>' --ollama '<absolute ollama.exe>' --out '<new absolute evidence directory>'
```

The saved probe uses a temporary Git project with an operator-sealed assertion:
the exported value must equal 1. After the passing session, the operator changes
only that value to 2. Neither session can edit files or tests. This is a
deliberately injected control, not naturally observed agent benefit. No manual
checkpoint invocation is used to obtain either hook result.

The final probe exited 0: **3/3 captured**, accounting matched in each case. It ran from
23:28:56 to 23:29:48 UTC on 2026-09-30 (2026-10-01 locally). Instrument, executable,
model hashes, commands, raw native stream events, API exchanges, checkpoint
records, product evidence and cleanup are retained at:

`C:\Users\Johannes\Desktop\canary\_canary-data\evidence\claude-local-preflight-20261001-final`.

Start with `summary.json`, then each session's `record.json`, `claude.jsonl` and
the numbered API request/response files. `instrument.mjs` preserves the executed
probe bytes and `v15-anthropic-usage.mjs` preserves the usage parser;
`SHA256SUMS` covers all saved files. The installed CLI hash remained
unchanged. No shipped product source was changed in this preflight.

The initial preflight is retained separately under `claude-local-preflight-20261001`.
Its three real responses also matched their native counters. A synthetic
accounting regression then exposed a gap: a stream without the final output
counter could certify the initial compatibility zero. The parser now requires
that final counter and the message end, rejects invalid/missing numbers, and
preserves explicitly reported valid zeroes. The targeted regression failed
before and all three parser tests passed afterwards. Raw reporters are in
`claude-local-accounting-20261001/parser-before.log` and `parser-after.log`.
The final three live controls above revalidated the stricter parser.

The earlier full unit/productization results apply to that unchanged artifact,
as documented in [the input-control report](POST-V15-INPUT-CONTROL-2026-09-30.md).
Those batteries were not repeated for this separate experimental preflight.

## Next step

Prepare a native Claude/local paired pilot from fresh task starts, first with
actual coding tools and Canary MCP available. Before freezing twelve sessions,
verify that the same request accounting remains complete with tool calls and
that both arms get equal task access. The local model replaces the previously
planned paid Alibaba connection; results must identify that substitution and
cannot be generalized to the earlier model. The original paid-provider spending
cap remains unresolved, while the executed local route requires no provider USD
budget.

The setup follows [Ollama's Claude Code integration](https://docs.ollama.com/integrations/claude-code),
[Anthropic API compatibility](https://docs.ollama.com/api/anthropic-compatibility),
[local-only mode](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features),
and [Claude settings precedence](https://code.claude.com/docs/en/settings).
