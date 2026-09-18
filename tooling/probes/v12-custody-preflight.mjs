// Read-only privilege measurement, NOT an attack battery and never a HARDENED verdict.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repository = fileURLToPath(new URL('../../', import.meta.url));
if (process.platform !== 'win32') {
  console.error('BLOCKED: Windows preflight unavailable; no checks credited');
  process.exitCode = 2;
} else {
  const probe = fileURLToPath(new URL('../test-support/fixtures/windows-custody-preflight.ps1', import.meta.url));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-Repository', repository], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  try {
    if (r.status !== 0) throw new Error(`preflight failed: ${r.stderr}`);
    const m = JSON.parse(r.stdout.trim());
    if (m.schema !== 'canary-custody-preflight/1') throw new Error('missing measurement');
    console.log(JSON.stringify(m, null, 2));
    for (const name of ['scmConnect', 'scmCreateServiceAccess', 'wfpOpen', 'wfpReadOptions']) {
      const p = m[name];
      console.log(`${p.executed && p.win32 === 0 ? 'AVAILABLE' : 'UNAVAILABLE'} ${name}: executed=${p.executed}, Win32=${p.win32}`);
    }
    const available = ['scmConnect', 'scmCreateServiceAccess', 'wfpOpen', 'wfpReadOptions']
      .every(name => m[name].executed && m[name].win32 === 0);
    console.log('Security attacks executed: 0; this reports installation/diagnostic access only.');
    console.log(available ? 'Preflight rights available; security controls still require implementation and measurement.'
      : 'BLOCKED: current token lacks required rights for the service deployment / WFP diagnostic path. NOT HARDENED.');
    process.exitCode = available ? 0 : 2;
  } catch (e) { console.error(`BLOCKED: ${e.message}`); process.exitCode = 2; }
}
