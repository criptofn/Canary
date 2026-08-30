/**
 * AI explanation layer — the adapter boundary from ADR-001.
 *
 * Contract: an AiProvider may summarize logs, explain likely root cause,
 * inspect diffs. It may NOT decide pass/fail: the return type has no
 * classification field, and EvidenceBundle.ai is a sibling namespace the
 * classifier never reads. Future external tools (RepoWise, Semgrep,
 * CodSpeed, ...) follow the same optional-adapter pattern: evidence in,
 * Canary's pipeline decides.
 */

import type { EvidenceBundle } from '@canary-rn/evidence-schema';

export interface AiSummary {
  provider: string;
  summary: string;
  attachedAt: string;
}

/** Input deliberately excludes any authority: providers see evidence, never own it. */
export interface SummarizeInput {
  bundle: EvidenceBundle;
  logs: { name: string; text: string }[];
}

export interface AiProvider {
  readonly name: string;
  summarize(input: SummarizeInput): Promise<AiSummary | null>;
}

/** The only provider shipped enabled: does nothing, attaches nothing. */
export const noOpProvider: AiProvider = {
  name: 'noop',
  async summarize(): Promise<AiSummary | null> {
    return null;
  },
};

/** Attach a summary to a bundle WITHOUT touching classification (type-enforced). */
export function attachSummary(bundle: EvidenceBundle, summary: AiSummary | null): EvidenceBundle {
  if (summary === null) return bundle;
  const { ai: _prev, ...rest } = bundle as EvidenceBundle & { ai?: unknown };
  return { ...rest, ai: summary } as EvidenceBundle;
}
