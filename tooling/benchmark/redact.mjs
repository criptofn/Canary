/**
 * SECRET REDACTION for benchmark artifacts.
 *
 * WHY THIS EXISTS: during environment discovery a live API token was printed into a
 * session log. Benchmark artifacts store whatever an agent writes — final messages, stdout,
 * stderr — and a model can echo an environment value into its own report, so "the agent
 * would never print a key" is not a control. Every byte this harness STORES or PRINTS goes
 * through `redactSecrets` first, so a secret cannot reach a committed result file, a report,
 * or the console by accident.
 *
 * The patterns are deliberately the generic SHAPES of credentials rather than one vendor's
 * prefix: a redactor that only knows the key you already leaked protects nothing else.
 */

/** `sk-…`, `sk-sp-…`, `ghp_…`, `AKIA…`, `xoxb-…` and friends. */
const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9._-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

/** `NAME=value`, `NAME: value`, `"NAME": "value"` — anything that names itself a credential. */
const NAMED_ASSIGNMENTS = [
  /\b([A-Za-z0-9_]*(?:AUTH_TOKEN|API_?KEY|ACCESS_TOKEN|CLIENT_SECRET|SECRET|PASSWORD|PASSWD|CREDENTIALS?))\b(["']?)(\s*[=:]\s*)(["']?)([^\s"',;)]{8,})\4/gi,
];

/** `Authorization: Bearer …`. */
const BEARER = [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi];

/** Placeholder written in place of a redacted value. */
export const REDACTED = '<redacted>';

/**
 * @param {string} text
 * @returns {{ text: string, hits: number }}
 */
export function redactSecrets(text) {
  let out = typeof text === 'string' ? text : '';
  let hits = 0;
  for (const re of TOKEN_SHAPES) {
    out = out.replace(re, () => { hits += 1; return REDACTED; });
  }
  for (const re of BEARER) {
    out = out.replace(re, () => { hits += 1; return `Bearer ${REDACTED}`; });
  }
  for (const re of NAMED_ASSIGNMENTS) {
    out = out.replace(re, (_m, name, nameQuote, sep, valueQuote) => {
      hits += 1;
      return `${name}${nameQuote}${sep}${valueQuote}${REDACTED}${valueQuote}`;
    });
  }
  return { text: out, hits };
}

/** Depth-first redaction of every string in a JSON-ish value (records, reports). */
export function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

/**
 * Does this text still LOOK like it carries a credential? Used by the harness self-test to
 * prove the redactor actually removes what it claims to remove — a redactor nobody tests is
 * a comment.
 */
export function looksSecret(text) {
  // The placeholder itself is not a secret: `NAME=<redacted>` must read as clean, or the
  // self-test could never confirm a redaction actually happened.
  const t = (typeof text === 'string' ? text : '').split(REDACTED).join('');
  for (const re of TOKEN_SHAPES) { re.lastIndex = 0; if (re.test(t)) return true; }
  for (const re of NAMED_ASSIGNMENTS) { re.lastIndex = 0; if (re.test(t)) return true; }
  return false;
}
