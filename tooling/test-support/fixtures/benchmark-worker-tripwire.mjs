// Test-only observer: prevents spending model tokens if a launch gate regresses.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = function(command, ...args) {
  if (/(?:^|[\\/])claude(?:\.exe|\.cmd)?$/i.test(command)) {
    fs.appendFileSync(process.env.CANARY_TEST_WORKER_TRIPWIRE, 'worker launch attempted\n');
    throw new Error('test intercepted forbidden worker launch');
  }
  return spawn.call(this, command, ...args);
};
syncBuiltinESMExports();
