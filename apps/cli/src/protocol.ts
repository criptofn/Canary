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
   *  completion. `gated: true` and `hooked: true` are DIFFERENT facts: `gated`
   *  is a capability of the integration ("this agent's completions could be
   *  blocked"), `hooked` is a fact about THIS repository ("Canary's hook is
   *  installed here"). `hooked: false` means: do not claim protection from it —
   *  a detected agent is not a protected repository. */
  harnesses: Array<{ id: string; label: string; gated: boolean; reason: string }>;
  hooked: boolean;
}

/** One agent integration, with its honest capability. `gating: false` is not a
 *  failure — it is the difference between "blocked until fixed" and "told, but
 *  free to ignore", and a caller must be able to tell them apart. */
export interface ProtocolIntegration {
  id: string;
  label: string;
  gating: boolean;
  /** v1.3 §E: is the `gating` answer MEASURED or merely documented by the vendor? Absent means
   *  measured (every integration that existed before this field did). `false` means a mechanism the
   *  vendor documents has NOT been reproduced on a real install here, and the integration is reported
   *  as UNMEASURED rather than folded into a yes or a no — both of which would be claims. */
  gatingMeasured?: boolean;
  detected: boolean;
  /** v1.4 §C: a one-time act the HARNESS owns before the installed hook will run at all — Codex
   *  runs a project hook only after the hook definition has been reviewed and trusted. Present only
   *  where such a step exists AND the hook is installed here; a machine consumer must be able to see
   *  that `gating: true` at this moment means "written, one trust step from gating". */
  gatingNeedsTrust?: string;
  /** For advisory integrations: is the AGENTS.md block currently installed? */
  advisoryInstalled?: boolean;
  summary: string;
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
  integrations?: ProtocolIntegration[];
  /** Steps the fast path left out, each with its reason. Present ONLY when
   *  something was skipped: a consumer must be able to see that a run was not
   *  the full plan, and a skip is never a pass. */
  skipped?: Array<{ step: string; reason: string }>;
  problems?: string[];
  /** The one thing to do next, when there is one. */
  next?: string;
  /** Where the full evidence lives — context stays out of the model's window. */
  evidencePath?: string;
  /**
   * `canary provider status` only (v1.5): the honest, machine-readable answer to
   * "is HARDENED real HERE, and if not, what exactly is missing?".
   *
   * Every field is a MEASURED fact, never a declaration: `hostPrimitives` is what
   * the host was observed to offer (presence is explicitly NOT proof), and
   * `deploymentMeasured` is `null` until a boundary measurement actually validates
   * in this store. A consumer must not read `hostPrimitives !== null` as HARDENED.
   */
  provider?: {
    hardenedAvailable: boolean;
    controlsAvailable: number;
    controlsTotal: number;
    controlsMissing: string[];
    hostPrimitives: string | null;
    deploymentMeasured: 'production' | 'confined-caller' | null;
  };
}

/** Exactly one JSON object on stdout. Everything else is a line of prose. */
export function emitEnvelope(env: ProtocolEnvelope): void {
  console.log(JSON.stringify(env));
}
