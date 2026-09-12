#!/usr/bin/env node
/**
 * WHY WAS A TRIAL CLASSIFIED THAT WAY? — a diagnostic for the claim classifier.
 *
 * The classifier is part of the measurement, so when its verdict looks wrong the
 * answer must be inspectable rather than a matter of opinion. This prints, for a
 * stored trial record (or any text file), the claimed class and the EXACT phrases that
 * matched on each side — so an over-broad pattern is visible instead of mysterious.
 *
 * Usage: node tooling/benchmark/explain-claim.mjs results/<label>.json [...]
 */
import fs from 'node:fs';

import { classifyClaim } from './classify-claim.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tooling/benchmark/explain-claim.mjs <trial.json|text file> [...]');
  process.exit(2);
}

for (const file of files) {
  let text = '';
  try {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      const record = JSON.parse(raw);
      text = record.agentResult?.finalText ?? '';
      console.log(`=== ${file}`);
      console.log(`    task=${record.task} arm=${record.arm} hidden=${record.hidden?.exitCode} visible=${record.visible?.exitCode}`);
    } catch {
      text = raw;
      console.log(`=== ${file} (plain text)`);
    }
  } catch (e) {
    console.log(`=== ${file}: unreadable (${e.message})`);
    continue;
  }
  const r = classifyClaim(text);
  console.log(`    class: ${r.claim}`);
  console.log(`    success phrases: ${r.successPhrases.length === 0 ? '(none)' : JSON.stringify(r.successPhrases)}`);
  console.log(`    failure phrases: ${r.failurePhrases.length === 0 ? '(none)' : JSON.stringify(r.failurePhrases)}`);
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  console.log(`    text (${lines.length} lines, last 6):`);
  for (const l of lines.slice(-6)) console.log(`      | ${l.slice(0, 160)}`);
}
