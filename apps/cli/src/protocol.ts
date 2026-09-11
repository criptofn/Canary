/**
 * 1.1 §21/§26/§28 — the machine-readable protocol.
 *
 * Canary is used by agents that are not Claude Code, and by CI systems that are
 * not agents at all. Prose is for humans; a stable, versioned, COMPACT JSON
 * envelope is the interface everything else parses. Two rules shape it:
 *
 *   1. `--json` never changes what Canary DECIDES. It changes where the human
 *      prose goes (stderr) and puts exactly one JSON object on stdout. Exit
 *      codes are identical in both modes — an agent must never get a different
 *      verdict because it asked for JSON.
 *   2. The envelope carries FACTS and a next action, never a log dump. Full
 *      logs stay in the evidence files the envelope names; a completion payload
 *      that pastes megabytes into a model's context is a token bug, not a
 *      feature. `problems` and `checks` are deliberately short lists.
 *
 * The schemas are versioned strings so a consumer can detect a change instead
 * of silently misreading a field.
 */
export const PROTOCOL_STATUS = 'canary-status/1';
export const PROTOCOL_RESULT = 'canary-result/1';

/** One sealed check, as an agent needs to see it: what it is, which ecosystem
 *  declared it, where it lives, and the exact command that will run. */
export interface ProtocolCheck {
  kind: string;
  script: string;
  adapter: string;
  scope: string;
  argv: string[];
}

/** How much protection Canary can claim here, and why — never more than was
 *  measured (see trust-store probeTrustLevel). */
export interface ProtocolSecurity {
  level: 'HARDENED' | 'LOCAL' | 'ADVISORY' | 'UNSUPPORTED';
  reasons: string[];
}

export interface ProtocolAgent {
  /** Which harnesses were found, and whether each can actually gate an agent's
   *  completion. `hooked: false` means: do not claim protection from it. */
  harnesses: Array<{ id: string; label: string; gated: boolean; reason: string }>;
  hooked: boolean;
}

export interface ProtocolEnvelope {
  schema: string;
  command: string;
  /** The same vocabulary the human verdict uses, so the two never diverge. */
  status: string;
  exitCode: number;
  root?: string;
  checks?: ProtocolCheck[];
  security?: ProtocolSecurity;
  agent?: ProtocolAgent;
  problems?: string[];
  /** The one thing to do next, when there is one. */
  next?: string;
  /** Where the full evidence lives — context stays out of the model's window. */
  evidencePath?: string;
}

/** Exactly one JSON object on stdout. Everything else is a line of prose. */
export function emitEnvelope(env: ProtocolEnvelope): void {
  console.log(JSON.stringify(env));
}
