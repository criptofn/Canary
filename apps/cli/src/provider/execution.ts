/** In-process controller scope, never a worker environment flag or CLI option. */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ControllerExecution {
  hooksDirectory: string;
  run(argv: readonly string[], cwd: string, timeoutMs: number): {
    status: number | null; stdout: string; stderr: string; error?: Error;
  };
}
export const controllerExecution = new AsyncLocalStorage<ControllerExecution>();
