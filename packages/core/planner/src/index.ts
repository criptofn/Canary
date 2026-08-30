/**
 * Experiment spec — the declarative input to Canary (docs/PLAN.md §4).
 * Validation is strict and total: a spec that validates cannot crash the
 * planner downstream.
 */

export interface DependencyRef {
  package: string;
  baseline: string;
  candidate: string;
}

export interface DownstreamRef {
  /** owner/name on github.com */
  repo: string;
  /** full 40-hex commit SHA — branch names are rejected */
  commit: string;
}

export type Argv = string[];

export interface ExperimentCommands {
  prepare: Argv[];
  /** Toolchain pins applied identically to both arms, recorded in evidence. */
  toolchainOverrides?: Argv[];
  build?: Argv[] | null;
  swap: Argv;
  test: Argv;
}

export interface ExperimentSpec {
  schema: number;
  id: string;
  dependency: DependencyRef;
  downstream: DownstreamRef;
  commands: ExperimentCommands;
  repeats: { baseline: number; candidate: number };
  timeoutSecs?: { install?: number; test?: number; build?: number };
  environmentNotes?: { toolchainOverrides?: Record<string, string>; [k: string]: unknown };
  notes?: string;
}

export interface SpecValidation {
  ok: boolean;
  errors: string[];
  spec?: ExperimentSpec;
}

const SHA40 = /^[0-9a-f]{40}$/;
const PKG_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0;
}

export function validateSpec(raw: unknown): SpecValidation {
  const errors: string[] = [];
  const fail = (m: string): void => { errors.push(m); };

  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['spec is not an object'] };
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(o.id)) fail('id must match [A-Za-z0-9._-]+');
  if (o.schema !== 1 && o.schema !== 2) fail('schema must be 1 or 2');

  const dep = o.dependency as Record<string, unknown> | undefined;
  if (!dep || typeof dep.package !== 'string' || !PKG_NAME.test(dep.package)) {
    fail('dependency.package invalid');
  }
  for (const k of ['baseline', 'candidate']) {
    const v = dep?.[k];
    if (typeof v !== 'string' || v.length === 0) fail(`dependency.${k} missing`);
  }
  if (dep && dep.baseline === dep.candidate) fail('baseline and candidate must differ');

  const ds = o.downstream as Record<string, unknown> | undefined;
  if (!ds || typeof ds.repo !== 'string' || !REPO.test(ds.repo)) fail('downstream.repo must be owner/name');
  if (!ds || typeof ds.commit !== 'string' || !SHA40.test(ds.commit)) {
    fail('downstream.commit must be a full 40-hex SHA (branches/tags are not acceptable pins)');
  }

  const cmds = o.commands as Record<string, unknown> | undefined;
  if (!cmds) fail('commands missing');
  else {
    if (!Array.isArray(cmds.prepare) || cmds.prepare.length === 0 || !cmds.prepare.every((c) => isStrArray(c))) {
      fail('commands.prepare must be a non-empty array of argv arrays');
    }
    if (cmds.toolchainOverrides !== undefined) {
      if (!Array.isArray(cmds.toolchainOverrides) || !cmds.toolchainOverrides.every((c) => isStrArray(c))) {
        fail('commands.toolchainOverrides must be an array of argv arrays');
      }
    }
    if (cmds.build !== null && cmds.build !== undefined && (
      !Array.isArray(cmds.build) || !cmds.build.every((c) => isStrArray(c)))) {
      fail('commands.build must be null/omitted or an array of argv arrays');
    }
    if (!isStrArray(cmds.swap)) fail('commands.swap must be an argv array');
    else if (!(cmds.swap as string[]).some((a) => a.includes('{candidate}'))) {
      fail('commands.swap must contain {candidate} — the swap must install the candidate version');
    }
    if (!isStrArray(cmds.test)) fail('commands.test must be an argv array');
  }

  const rep = o.repeats as Record<string, unknown> | undefined;
  if (!rep || typeof rep.baseline !== 'number' || rep.baseline < 2) {
    // F8: a single baseline round makes the FLAKY guard (rule 2) unreachable.
    fail('repeats.baseline must be >= 2 (baseline stability must be observable)');
  }
  if (!rep || typeof rep.candidate !== 'number' || rep.candidate < 2) {
    fail('repeats.candidate must be >= 2 (a regression needs reproduction)');
  }

  return { ok: errors.length === 0, errors, ...(errors.length === 0 ? { spec: raw as ExperimentSpec } : {}) };
}

/** The ordered list of arms as a planner would emit them (data only). */
export function planArms(spec: ExperimentSpec): Array<'prepare' | 'toolchain' | 'build' | 'baseline' | 'swap' | 'candidate'> {
  const steps: Array<'prepare' | 'toolchain' | 'build' | 'baseline' | 'swap' | 'candidate'> = ['prepare'];
  if (spec.commands.toolchainOverrides?.length) steps.push('toolchain');
  if (spec.commands.build?.length) steps.push('build');
  steps.push('baseline', 'swap', 'candidate');
  return steps;
}
