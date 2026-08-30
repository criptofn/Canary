import os from 'node:os';

export interface EnvironmentFingerprint {
  nodeVersion: string;
  npmVersion: string;
  packageManagerUsed: string;
  platform: string;
  arch: string;
  osRelease: string;
  /** Toolchain pins applied to BOTH arms, with the rationale (must be declared). */
  toolchainOverrides: Record<string, string>;
}

export function staticFingerprint(toolchainOverrides: Record<string, string> = {}): Omit<EnvironmentFingerprint, 'npmVersion'> {
  return {
    nodeVersion: process.version,
    packageManagerUsed: 'npm',
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    toolchainOverrides,
  };
}

/** npm version resolved by the caller (spawn injected — this package does not spawn). */
export function withNpmVersion(
  fp: Omit<EnvironmentFingerprint, 'npmVersion'>,
  npmVersion: string,
): EnvironmentFingerprint {
  return { ...fp, npmVersion };
}
