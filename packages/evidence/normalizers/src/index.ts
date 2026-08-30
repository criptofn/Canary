/**
 * Output normalizers — deterministic substitution of known run-to-run
 * nondeterminism in test logs (the preserved core concept from the Python
 * prototype). Applied identically to both arms; order is contractual.
 *
 * What normalizers may do: hide values that legitimately differ per run
 * (times, temp dirs, ports, ids). What they may never do: alter lines that
 * encode test outcomes. Every pattern here is anchored on unstable value
 * shapes, not on result words.
 */

export type Normalizer = (text: string) => string;

export const DEFAULT_RULE_NAMES = [
  'line-endings',
  'iso-timestamp',
  'date',
  'duration',
  'uuid',
  'hex-address',
  'port',
  'workspace-root',
  'temp-path',
  'home-path',
  'host-name',
  'user-name',
  'trailing-ws',
] as const;

function lineEndings(t: string): string {
  return t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trailingWs(t: string): string {
  let out = t.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  out = out.replace(/\n+$/, '');
  return out === '' ? '' : out + '\n';
}

const ISO_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const DURATION = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ADDR = /\b0x[0-9a-f]{8,16}\b/gi;

export const staticRules: Readonly<Record<string, Normalizer>> = {
  'line-endings': lineEndings,
  'iso-timestamp': (t) => t.replace(ISO_TS, '<TS>'),
  'date': (t) => t.replace(DATE, '<DATE>'),
  'duration': (t) => t.replace(DURATION, '<DUR>'),
  'uuid': (t) => t.replace(UUID, '<UUID>'),
  'hex-address': (t) => t.replace(HEX_ADDR, '<ADDR>'),
  'trailing-ws': trailingWs,
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every path spelling we should match (native, slashed, drive-case). */
export function pathVariants(p: string): string[] {
  const norm = p.replace(/[\\/]+$/, '');
  const set = new Set<string>([norm, norm.replace(/\\/g, '/'), norm.replace(/\//g, '\\')]);
  if (/^[A-Za-z]:/.test(norm)) {
    const lower = norm[0]!.toLowerCase() + norm.slice(1);
    set.add(lower);
    set.add(lower.replace(/\\/g, '/'));
  }
  return [...set].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function makePathRule(p: string, token: string): Normalizer {
  const variants = pathVariants(p);
  if (variants.length === 0) return (t) => t;
  const re = new RegExp(
    `(?:${variants.map(escapeRe).join('|')})(?:[\\\\/][^\\s"',;]*)?`,
    'gi',
  );
  return (t) => t.replace(re, token);
}

export function makeLiteralRule(value: string, token: string): Normalizer {
  if (!value || !value.trim()) return (t) => t;
  const re = new RegExp(escapeRe(value.trim()), 'gi');
  return (t) => t.replace(re, token);
}

/**
 * Machine-derived rules. `workspaceRoot` is additionally normalized to
 * `<WS>` — the disposable run directory appears in every path and differs
 * per run; this is the single most important rule for experiment logs.
 */
export function machineRules(opts: {
  tempDir: string;
  homeDir: string;
  user: string;
  host: string;
  workspaceRoot: string;
}): Readonly<Record<string, Normalizer>> {
  const hostNames = [opts.host, opts.host.split('.')[0]!].filter(Boolean);
  // CRITICAL: an empty alternation regex matches the empty string *everywhere*;
  // with no host to normalize, the rule must be the identity function.
  const hostRe = hostNames.length ? new RegExp(hostNames.map(escapeRe).join('|'), 'gi') : null;
  return {
    'port': (t) => t.replace(/\blocalhost:(\d{2,5})\b/gi, 'localhost:<PORT>'),
    'workspace-root': makePathRule(opts.workspaceRoot, '<WS>'),
    'temp-path': makePathRule(opts.tempDir, '<TEMP>'),
    'home-path': makePathRule(opts.homeDir, '<HOME>'),
    'host-name': hostRe ? ((t) => t.replace(hostRe, '<HOST>')) : ((t) => t),
    'user-name': makeLiteralRule(opts.user, '<USER>'),
  };
}

export function buildPipeline(names: readonly string[], machine: Readonly<Record<string, Normalizer>>): Normalizer[] {
  const merged = { ...staticRules, ...machine };
  return names.map((n) => {
    const rule = merged[n];
    if (!rule) throw new Error(`unknown normalizer: ${n}`);
    return rule;
  });
}

export function normalize(text: string, pipeline: readonly Normalizer[]): string {
  let out = text;
  for (const rule of pipeline) out = rule(out);
  return out;
}
