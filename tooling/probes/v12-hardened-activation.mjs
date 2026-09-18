// Production-backed activation contract. The suite provisions and attacks a real
// deployment; no fabricated schema-1 record is accepted as a positive fixture.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=8',
  'apps/cli/dist/test/confined-activation.test.js'], {cwd: repo, stdio: 'inherit', windowsHide: true});
if (result.error) console.error('FAIL activation execution: ' + result.error.message);
process.exitCode = result.status ?? 1;
