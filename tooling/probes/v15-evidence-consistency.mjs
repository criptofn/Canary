#!/usr/bin/env node
/**
 * v1.5 SECOND-AUDIT PASS — DOES THE PUBLIC EVIDENCE SET TELL ONE TRUTH?
 *
 * WHY THIS EXISTS. A second auditor found the public audit set internally stale and
 * contradictory: the claim/evidence matrix still carried `83.21 % / -16.79 %` as
 * SUPPORTED while a later section of the SAME FILE withdrew it; the audit kit still asked
 * a reviewer to attack a withdrawn number; the closure document ended by declaring gates
 * NOT RUN that had since gone green; and the README still described v1.3.0 as the newest
 * published artifact. Every one of those was found by a human reading carefully — which is
 * luck with a process around it, not a control.
 *
 * WHAT THIS PROBE IS: a TRIPWIRE on the *context* of a number, not a proof of prose. It
 * cannot tell whether a sentence is true. It can tell whether a figure that this project
 * has WITHDRAWN is still being presented as current, and whether a required statement of
 * the current truth has silently disappeared.
 *
 * TWO KINDS OF CHECK, and they are deliberately different:
 *
 *  1. MARKED OCCURRENCES. A withdrawn or superseded figure may stay in the documents —
 *     deleting a published dataset is how a benchmark becomes an advertisement — but it
 *     must sit in a context that marks it. The window is the hit line plus/minus 4 lines,
 *     because a markdown table's qualifier is often the note AFTER it. That window is a
 *     heuristic and is named as one: it reduces false alarms, and it can in principle
 *     accept a stale claim that happens to sit near an unrelated "historical".
 *
 *  2. ABSENT STRINGS. Statements that are simply no longer true anywhere in these files
 *     ("NOT RUN" as a gate status, "in progress" as a finding status, "not fixed in v1.5",
 *     "v1.3.0 is the newest", "the v1.4 candidate"). No context can rescue them.
 *
 *  3. REQUIRED PINS. The current truth, in the words the documents now use. If an edit
 *     removes one of these, the edit has changed what the project claims and must be
 *     deliberate.
 *
 * FILES: the public audit set — README.md and the v1.5 documents a reviewer is pointed at.
 * FIXTURES: none (read-only). EXIT: 0 only when every check held.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');

const FILES = {
  readme: 'README.md',
  matrix: 'docs/CLAIM-EVIDENCE-MATRIX-1.5.md',
  kit: 'docs/AUDIT-KIT-1.5.md',
  closure: 'docs/POST-AUDIT-CLOSURE-1.5.md',
  benchmark: 'docs/BENCHMARK-EVERYDAY-1.5.md',
  realworld: 'docs/REAL-WORLD-EVIDENCE-1.5.md',
};

let failures = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** @type {Map<string, {rel: string, lines: string[], flat: string}>} */
const docs = new Map();
for (const [key, rel] of Object.entries(FILES)) {
  const abs = path.join(REPO, rel);
  assert(fs.existsSync(abs), `${rel} is missing — the public audit set is incomplete`);
  const text = fs.readFileSync(abs, 'utf8');
  docs.set(key, {
    rel,
    lines: text.split(/\r?\n/),
    // Normalised for phrase pins: markdown emphasis and backticks removed, blockquote
    // markers dropped, all whitespace collapsed, so a phrase may span lines.
    flat: text.replace(/[*`_]/g, '').replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/\s+/g, ' ').trim(),
  });
}
const doc = (key) => {
  const d = docs.get(key);
  assert(d !== undefined, `unknown document key ${key}`);
  return d;
};

/**
 * A figure this project has WITHDRAWN, or a run figure that may only appear as an
 * observation. Each must have one of these markers within the window.
 */
const MARKED = [
  { re: /83\.21/g, what: 'the withdrawn everyday headline (83.21 %)' },
  { re: /16\.79/g, what: 'the withdrawn everyday headline (-16.79 %)' },
  { re: /\b92\.7\b/g, what: 'the historical v1.3 figure (92.7 %)' },
  { re: /\b10\.19\b/g, what: 'the pooled delta (-10.19 %)' },
  { re: /80\.74/g, what: 'the first COMPLETE run ratio (80.74 %)' },
  { re: /102\.91/g, what: 'the second COMPLETE run ratio (102.91 %)' },
];
const MARKERS = [
  'WITHDRAWN', 'withdrawn', 'SUPERSEDED', 'superseded', 'HISTORICAL', 'historical',
  'REJECTED', 'rejected', 'obsolete', 'overstated', 'do not quote', 'not the',
  'no current', 'no supported', 'NOT SUPPORTED', 'not supported', 'observation',
  'limitation', 'disagree', 'COMPLETE', 'spread', 'drift', 'sign', 'used to be',
  'for the record',
];
const WINDOW = 4;

check('every withdrawn or observation-only figure sits in a context that marks it', () => {
  const violations = [];
  let hits = 0;
  for (const key of docs.keys()) {
    const d = doc(key);
    d.lines.forEach((line, i) => {
      for (const { re, what } of MARKED) {
        re.lastIndex = 0;
        if (!re.test(line)) continue;
        hits++;
        const from = Math.max(0, i - WINDOW);
        const to = Math.min(d.lines.length, i + WINDOW + 1);
        const window = d.lines.slice(from, to).join(' ');
        if (!MARKERS.some((m) => window.includes(m))) {
          violations.push(`${d.rel}:${i + 1} quotes ${what} with no marker in ±${WINDOW} lines: `
            + `"${line.trim().slice(0, 120)}"`);
        }
      }
    });
  }
  assert(hits > 0, 'no marked figure was found at all — this check has gone vacuous');
  assert(violations.length === 0, violations.join('\n'));
  return `${hits} occurrence(s) checked across ${docs.size} documents`;
});

/** Strings that are no longer true anywhere in the public audit set. */
const ABSENT = [
  { s: 'NOT RUN', what: 'a gate status that has since run' },
  { s: 'NOT YET RUN', what: 'a gate status that has since run' },
  { s: 'in progress', what: 'a finding status that is closed or limited, not pending' },
  { s: 'not fixed in v1.5', what: 'a defect that was fixed and regressed' },
  { s: 'v1.3.0 is the newest', what: 'a release-history statement that is now false' },
  { s: 'the v1.4.0 candidate', what: 'the source tree is the v1.5 candidate' },
  { s: 'the v1.4 candidate', what: 'the source tree is the v1.5 candidate' },
  { s: 'READY FOR A SECOND LOCAL AUDIT: NO', what: 'the hand-back state is now YES' },
];
check('no document still asserts a statement the closure made false', () => {
  const violations = [];
  for (const key of docs.keys()) {
    const d = doc(key);
    for (const { s, what } of ABSENT) {
      d.lines.forEach((line, i) => {
        if (line.includes(s)) violations.push(`${d.rel}:${i + 1} still says "${s}" (${what})`);
      });
    }
  }
  assert(violations.length === 0, violations.join('\n'));
  return `${ABSENT.length} retired statements absent from ${docs.size} documents`;
});

/**
 * The current truth, in the documents' own words. Each pin is a phrase a reviewer can
 * check by reading the sentence it sits in; losing one means the claim changed.
 */
const PINS = [
  ['readme', 'v1.4.0 is the newest *published* artifact'],
  ['readme', 'the token-saving headline is WITHDRAWN'],
  ['readme', 'claims no token-saving percentage at all'],
  ['readme', '~438 provider-native tokens'],
  ['readme', 'docs/AUDIT-KIT-1.5.md'],
  ['readme', 'docs/CLAIM-EVIDENCE-MATRIX-1.5.md'],
  ['readme', 'docs/POST-AUDIT-CLOSURE-1.5.md'],
  ['readme', 'docs/BENCHMARK-EVERYDAY-1.5.md'],
  ['readme', 'open and unexplained'],
  ['matrix', 'no everyday token-saving percentage is claimed'],
  ['matrix', 'OPEN / UNEXPLAINED / DID NOT RECUR'],
  ['matrix', '104 PASS / 0 FAIL / 3 SKIP'],
  ['matrix', '1,284 pass, 0 fail, 4 skipped'],
  ['matrix', '1,206 pass, 0 fail, 5 skipped'],
  ['matrix', 'e51b6fc'],
  ['matrix', 'NOT TAGGED, NOT RELEASED, NOT MERGED'],
  ['kit', 'The project currently claims NONE'],
  ['kit', 'START HERE — the Windows descendant sweep'],
  ['kit', 'green ≠ fixed'],
  ['kit', 'NOT TAGGED, NOT RELEASED, NOT MERGED'],  ['closure', 'OPEN / UNEXPLAINED / DID NOT RECUR'],
  ['closure', 'READY FOR A SECOND AUDIT: YES'],
  ['closure', 'NOT TAGGED. NOT RELEASED. NOT MERGED.'],
  ['closure', 'DIAGNOSTIC IMPROVED'],
  ['benchmark', 'no token-saving claim is supported'],
];
check('the current truth is still stated, in every document that must state it', () => {
  const missing = [];
  for (const [key, phrase] of PINS) {
    const d = doc(key);
    // Same normalisation as `flat`: markdown emphasis is not part of what a reader reads.
    const wanted = phrase.replace(/[*`_]/g, '').replace(/\s+/g, ' ');
    if (!d.flat.includes(wanted)) missing.push(`${d.rel} no longer states: "${phrase}"`);
  }
  assert(missing.length === 0, missing.join('\n'));
  return `${PINS.length} pins held`;
});

check('the two COMPLETE runs travel together, in every document that quotes one', () => {
  const violations = [];
  for (const key of docs.keys()) {
    const d = doc(key);
    const hasFirst = d.flat.includes('80.74');
    const hasSecond = d.flat.includes('102.91');
    if (hasFirst !== hasSecond) {
      violations.push(`${d.rel} quotes ${hasFirst ? '80.74' : '102.91'} without the other COMPLETE `
        + 'run — a single ratio reads as a result, and the pair is the finding');
    }
    if (d.flat.includes('83.21') && !/withdrawn/i.test(d.flat)) {
      violations.push(`${d.rel} still quotes the withdrawn headline without withdrawing it`);
    }
  }
  assert(violations.length === 0, violations.join('\n'));
  return 'complete-run pairs and the withdrawal are consistent';
});

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — evidence consistency: `
  + `${failures} failure(s) across ${docs.size} documents`);
process.exit(failures === 0 ? 0 : 1);
