// M7 probe fixture: the drift-BLOCKS-BEFORE-EXECUTION check swaps a candidate's
// sealed test script to run THIS file. If it executes, it leaves a marker — the
// marker's absence is mechanical proof the block preceded any run, not a
// behavioral claim. Marker path arrives as argv (probe-scoped); the fallback
// keeps direct/manual runs working. Exits 0 on purpose: a swapped-to-green
// hollow check is exactly the attack the seal must stop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
fs.writeFileSync(process.argv[2] ?? path.join(os.tmpdir(), 'canary-m7-swap-ran.txt'), `ran by pid ${process.pid}\n`);
process.exit(0);
