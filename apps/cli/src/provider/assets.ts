import path from 'node:path';

// Build-time constant only: callers cannot redirect the trusted toolchain via env.
declare const CANARY_PACKAGED: boolean;
export const packagedProvider = typeof CANARY_PACKAGED !== 'undefined' && CANARY_PACKAGED;
export const providerRoot = path.resolve(import.meta.dirname, packagedProvider ? '..' : '../../../../..');
