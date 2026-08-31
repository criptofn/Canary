import { extractFailingTestNames } from './packages/core/comparator/dist/src/index.js';
import fs from 'node:fs';
const p = '.canary-runs/exp-axios-mock-adapter-1.21.1-2026-08-30T23-08-39-029Z/artifacts/candidate-1.stdout.log';
const stderrP = p.replace('.stdout.log', '.stderr.log');
const combined = fs.readFileSync(p, 'utf8') + fs.readFileSync(stderrP, 'utf8');
console.log(JSON.stringify(extractFailingTestNames(combined).sort(), null, 2));
