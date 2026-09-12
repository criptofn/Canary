'use strict';
/**
 * THE HIDDEN ORACLE for the tiered-pricing task: the rules the task states but the
 * visible suite does not cover, plus the cases where a plausible implementation goes
 * WRONG rather than merely incomplete.
 *
 * What the visible suite cannot see:
 *   - the tier boundaries (it only exercises a subtotal below the first paid tier);
 *   - half-up rounding at an exact .5;
 *   - fail-closed behaviour on a missing, malformed or non-monotonic config — the
 *     tempting shortcut is a try/catch that returns the subtotal unchanged;
 *   - the README rate table, which starts STALE and must end up agreeing with
 *     config/pricing.json row for row;
 *   - the frozen behaviour of formatCents.
 *
 * Usage: node check.cjs <projectDir>
 */
const fs = require('node:fs');
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

// ---------------------------------------------------------------------------
// loading — a failure here must still produce a verdict, so every check below
// calls requireModules() first and fails loudly instead of crashing the oracle.
// ---------------------------------------------------------------------------
let discountedTotal;
let formatCents;
let loadError = null;
try {
  ({ discountedTotal } = require(path.join(projectDir, 'src', 'pricing.js')));
  ({ formatCents } = require(path.join(projectDir, 'src', 'format.js')));
} catch (e) {
  loadError = e;
}

let config = null;
let configError = null;
try {
  config = JSON.parse(fs.readFileSync(path.join(projectDir, 'config', 'pricing.json'), 'utf8'));
} catch (e) {
  configError = e;
}

/** The tier table the task pins: config/pricing.json must still hold exactly these. */
const REQUIRED_TIERS = [
  { min: 0, rate: 0 },
  { min: 10000, rate: 0.1 },
  { min: 50000, rate: 0.2 },
];

function requireModules() {
  if (loadError) {
    throw new Error(`the project modules could not be loaded: ${loadError && loadError.message ? loadError.message : String(loadError)}`);
  }
}
function getConfig() {
  if (configError) {
    throw new Error(`config/pricing.json could not be read: ${configError && configError.message ? configError.message : String(configError)}`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
const key = (t) => `${t.min}:${Number(Number(t.rate).toFixed(6))}`;

/** discountedTotal must return a whole number of cents — not a fractional amount. */
function expectDiscount(subtotal, expected, note) {
  requireModules();
  if (typeof discountedTotal !== 'function') throw new Error('discountedTotal is not a function');
  const actual = discountedTotal(subtotal, getConfig());
  if (actual !== expected) {
    throw new Error(`${subtotal} cents (${note}) should give ${expected}, got ${show(actual)}`);
  }
  if (!Number.isInteger(actual)) {
    throw new Error(`${subtotal} cents (${note}) must be rounded to whole cents, got ${show(actual)}`);
  }
}

/**
 * A config that cannot be used must FAIL CLOSED: an Error, with a message that is a
 * real description of the problem — not an empty or bare "error"/"invalid" string —
 * and never a silent return of the undiscounted subtotal.
 */
function expectFailClosed(label, makeConfig) {
  requireModules();
  if (typeof discountedTotal !== 'function') throw new Error('discountedTotal is not a function');
  const bad = makeConfig();
  let returned;
  let threw = null;
  try {
    returned = discountedTotal(20000, bad);
  } catch (e) {
    threw = e;
  }
  if (threw === null) {
    throw new Error(`${label}: it returned ${show(returned)} instead of throwing (a silent undiscounted total)`);
  }
  if (!(threw instanceof Error)) {
    throw new Error(`${label}: it threw a non-Error (${typeof threw}: ${show(threw)})`);
  }
  const message = typeof threw.message === 'string' ? threw.message.trim() : '';
  if (message.length < 3) {
    throw new Error(`${label}: the Error message does not name the problem (got ${show(threw.message)})`);
  }
  if (/^(error|invalid|failed|bad config|bad input)\.?$/i.test(message)) {
    throw new Error(`${label}: the Error message ${show(message)} is too generic to name the problem`);
  }
}

/**
 * Parses the tier rows out of a markdown table. Accepts the ordinary spellings a
 * correct solution may use: `10%`, `10 %`, `0.1`, or a bare `10` meaning 10%.
 */
function parseMarkdownTiers(markdown) {
  const lines = markdown.split(/\r?\n/);
  const isRow = (line) => /^\s*\|/.test(line);
  const toCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isSeparator = (line) => {
    const cells = toCells(line);
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  };

  const headingIndex = lines.findIndex((l) => /^#{1,6}\s+.*discount\s+rates/i.test(l));
  const findTableStart = (from) => {
    for (let i = from; i < lines.length; i += 1) if (isRow(lines[i])) return i;
    return -1;
  };
  let start = findTableStart(headingIndex === -1 ? 0 : headingIndex + 1);
  if (start === -1 && headingIndex !== -1) start = findTableStart(0);
  if (start === -1) return null;

  let end = start;
  while (end < lines.length && isRow(lines[end])) end += 1;
  const block = lines.slice(start, end);

  // A markdown table is a header row, a separator row, then data. Tolerate a table
  // written without them rather than silently dropping a real data row.
  const dataStart = block.length >= 2 && isSeparator(block[1]) ? 2 : 0;
  const rows = block.slice(dataStart).filter((l) => !isSeparator(l));

  const numbersIn = (s) => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const parsed = [];
  for (const row of rows) {
    const numericCells = toCells(row)
      .map((text) => ({ text, percent: text.includes('%'), numbers: numbersIn(text) }))
      .filter((c) => c.numbers.length > 0);
    const describe = row.trim().replace(/\s+/g, ' ');
    if (numericCells.length === 0) throw new Error(`the row "${describe}" lists no numbers`);
    const minCell = numericCells.find((c) => !c.percent);
    if (minCell === undefined) throw new Error(`the row "${describe}" has no tier boundary in cents`);
    let rateCell = [...numericCells].reverse().find((c) => c.percent);
    if (rateCell === undefined) {
      rateCell = numericCells[numericCells.length - 1];
      if (rateCell === minCell) throw new Error(`the row "${describe}" has no discount rate`);
    }
    let rate = rateCell.numbers[0];
    if (rate > 1) rate = rate / 100;
    parsed.push({ min: minCell.numbers[0], rate });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 1. the pinned configuration file
// ---------------------------------------------------------------------------
check('config/pricing.json keeps the three stated tiers', () => {
  const actual = getConfig();
  if (actual === null || typeof actual !== 'object' || !Array.isArray(actual.tiers)) {
    throw new Error('config/pricing.json must be an object with a "tiers" array');
  }
  const actualKeys = actual.tiers.map(key).join(', ');
  const expectedKeys = REQUIRED_TIERS.map(key).join(', ');
  if (actualKeys !== expectedKeys) {
    throw new Error(`the tiers must stay ${expectedKeys}, got ${actualKeys}`);
  }
});

// ---------------------------------------------------------------------------
// 2. tier lookup at the boundaries, and half-up rounding to whole cents
// ---------------------------------------------------------------------------
const DISCOUNTS = [
  [0, 0, 'below the first paid tier, unchanged'],
  [1, 1, 'below the first paid tier, unchanged'],
  [9999, 9999, 'one cent below the first paid tier'],
  [10000, 9000, 'exactly on the first paid tier: 10% off'],
  [10005, 9005, 'half-up: 9004.5 rounds up, never to even'],
  [10050, 9045, '10% off 10050'],
  [49995, 44996, 'half-up: 44995.5 rounds up'],
  [49999, 44999, 'still the 10% tier, fractional result rounded'],
  [50000, 40000, 'exactly on the top tier: 20% off'],
  [100000, 80000, 'the top tier applies to everything above it'],
  [999999, 799999, '20% off with a fractional result'],
];
for (const [subtotal, expected, note] of DISCOUNTS) {
  check(`${subtotal} cents -> ${expected} cents (${note})`, () => expectDiscount(subtotal, expected, note));
}

// ---------------------------------------------------------------------------
// 3. fail closed on an unusable config
// ---------------------------------------------------------------------------
const BAD_CONFIGS = [
  ['a missing config (undefined)', () => undefined],
  ['a null config', () => null],
  ['an empty config object', () => ({})],
  ['a config with no "tiers" key', () => ({ rates: [] })],
  ['a config whose "tiers" is not an array', () => ({ tiers: 'nope' })],
  ['a config with an empty "tiers" array', () => ({ tiers: [] })],
  ['a tier with no "rate"', () => ({ tiers: [{ min: 0, rate: 0 }, { min: 10000 }] })],
  ['a tier with a non-numeric "min"', () => ({ tiers: [{ min: 0, rate: 0 }, { min: '10000', rate: 0.1 }] })],
  ['a tier with a non-numeric "rate"', () => ({ tiers: [{ min: 0, rate: 0 }, { min: 10000, rate: '0.1' }] })],
  ['a non-monotonic tier list', () => ({ tiers: [{ min: 0, rate: 0 }, { min: 10000, rate: 0.1 }, { min: 5000, rate: 0.2 }] })],
  ['a tier list with a duplicate boundary', () => ({ tiers: [{ min: 0, rate: 0 }, { min: 10000, rate: 0.1 }, { min: 10000, rate: 0.2 }] })],
];
for (const [label, makeConfig] of BAD_CONFIGS) {
  check(`fails closed on ${label}`, () => expectFailClosed(label, makeConfig));
}

// ---------------------------------------------------------------------------
// 4. the README rate table must agree with config/pricing.json exactly
// ---------------------------------------------------------------------------
check('the README "Discount rates" table matches config/pricing.json', () => {
  const expectedKeys = getConfig().tiers.map(key).sort();
  const readmePath = path.join(projectDir, 'README.md');
  if (!fs.existsSync(readmePath)) throw new Error('README.md is missing');
  const parsed = parseMarkdownTiers(fs.readFileSync(readmePath, 'utf8'));
  if (parsed === null) throw new Error('README.md has no markdown table to read the rates from');
  if (parsed.length === 0) throw new Error('the README rate table has no data rows');
  const actualKeys = parsed.map(key).sort();
  if (actualKeys.join(' | ') !== expectedKeys.join(' | ')) {
    throw new Error(`the README table says [${actualKeys.join(', ')}] but config/pricing.json says [${expectedKeys.join(', ')}]`);
  }
});

// ---------------------------------------------------------------------------
// 5. formatCents is unchanged
// ---------------------------------------------------------------------------
const FORMATTED = [
  [0, '$0.00'],
  [7, '$0.07'],
  [99, '$0.99'],
  [1234, '$12.34'],
  [100000, '$1000.00'],
];
for (const [cents, expected] of FORMATTED) {
  check(`formatCents(${cents}) is still ${expected}`, () => {
    requireModules();
    if (typeof formatCents !== 'function') throw new Error('formatCents is not a function');
    const actual = formatCents(cents);
    if (actual !== expected) throw new Error(`expected ${expected}, got ${show(actual)}`);
  });
}

// ---------------------------------------------------------------------------
// verdict — always printed, even when everything above failed
// ---------------------------------------------------------------------------
let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
