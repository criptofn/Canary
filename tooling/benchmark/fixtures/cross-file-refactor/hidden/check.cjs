'use strict';
/**
 * THE HIDDEN ORACLE for the currency task: the cross-file refactor the task states in
 * prose, plus the cases where a plausible implementation goes WRONG rather than merely
 * incomplete — `format` that stops accepting numeric strings, an `index.js` that drops
 * the old `formatMoney` export, and an unknown currency that silently falls back to `$`
 * instead of throwing.
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const eq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const fnOf = (value, label) => {
  if (typeof value !== 'function') throw new Error(`${label} is not a function (got ${typeof value})`);
};

const load = (rel) => require(path.join(projectDir, rel));

/** Run `fn` and return the error it threw, or null. Used for the throwing contract. */
const caught = (fn) => {
  try { fn(); return null; }
  catch (e) { return e; }
};

let currency;
let money;
let index;
let cartModule;
try {
  currency = load('src/currency.js');
  money = load('src/money.js');
  index = load('src/index.js');
  cartModule = load('src/cart.js');
} catch (e) {
  // The summary line is printed even here: a verdict that a trial runner cannot parse is
  // an unusable trial, and the harness reads usability from the summary, not from the exit.
  console.log(`FAIL the project modules could not be loaded: ${e && e.message ? e.message : e}`);
  console.log('hidden oracle: 0/1 behaviour checks passed');
  process.exit(1);
}

check('src/currency.js exports format', () => fnOf(currency.format, 'format'));

// the currency table: USD, EUR and GBP, each in its own symbol, two decimals
check("format(12.35, 'USD') -> $12.35", () => eq(currency.format(12.35, 'USD'), '$12.35', 'USD'));
check("format(12.35, 'EUR') -> \u20ac12.35", () => eq(currency.format(12.35, 'EUR'), '\u20ac12.35', 'EUR'));
check("format(12.35, 'GBP') -> \u00a312.35", () => eq(currency.format(12.35, 'GBP'), '\u00a312.35', 'GBP'));
check("format(13, 'EUR') pads to two decimals", () => eq(currency.format(13, 'EUR'), '\u20ac13.00', 'EUR'));
check("format(0, 'GBP') -> \u00a30.00", () => eq(currency.format(0, 'GBP'), '\u00a30.00', 'GBP'));
check("format(1200, 'USD') -> $1200.00 (no thousands separator)", () => eq(currency.format(1200, 'USD'), '$1200.00', 'USD'));
check("format(-0.5, 'USD') -> $-0.50", () => eq(currency.format(-0.5, 'USD'), '$-0.50', 'USD'));

// the compatibility contract: formatMoney keeps working EXACTLY as before
check('formatMoney is still exported by src/money.js', () => fnOf(money.formatMoney, 'formatMoney'));
check('formatMoney(12.35) -> $12.35', () => eq(money.formatMoney(12.35), '$12.35', 'formatMoney(12.35)'));
check('formatMoney(0) -> $0.00', () => eq(money.formatMoney(0), '$0.00', 'formatMoney(0)'));
check('formatMoney(13) -> $13.00', () => eq(money.formatMoney(13), '$13.00', 'formatMoney(13)'));
check('formatMoney("12.35") still accepts a numeric string', () => eq(money.formatMoney('12.35'), '$12.35', 'formatMoney("12.35")'));
check('formatMoney("1235") still accepts a numeric string', () => eq(money.formatMoney('1235'), '$1235.00', 'formatMoney("1235")'));

// format is the currency-aware replacement and inherits the same input tolerance
check('format("12.35", "EUR") accepts a numeric string', () => eq(currency.format('12.35', 'EUR'), '\u20ac12.35', 'format("12.35", "EUR")'));
// NOTE: the task does not state a default currency for `format` itself — only that an
// UNKNOWN code throws — so `format(12.35)` with no currency is deliberately not checked.
// A solution that validates its second argument strictly is correct either way.

// the public surface of the package
check('src/index.js exports formatMoney', () => fnOf(index.formatMoney, 'index.formatMoney'));
check('src/index.js exports format', () => fnOf(index.format, 'index.format'));
check('src/index.js exports Cart', () => fnOf(index.Cart, 'index.Cart'));
check('index.formatMoney is the same USD behaviour', () => eq(index.formatMoney('12.35'), '$12.35', 'index.formatMoney("12.35")'));
check("index.format(12.35, 'GBP') -> \u00a312.35", () => eq(index.format(12.35, 'GBP'), '\u00a312.35', 'index.format'));

// the cart is currency-aware, and its default is unchanged US dollars
check('src/cart.js exports Cart', () => fnOf(cartModule.Cart, 'Cart'));
const cartWith = (lines) => {
  const cart = new index.Cart();
  for (const [name, cents] of lines) cart.add(name, cents);
  return cart;
};
check('Cart.items() still lists what was added', () => {
  const cart = cartWith([['book', 1250], ['pen', 250]]);
  const items = cart.items();
  if (!Array.isArray(items)) throw new Error(`items() should be an array, got ${typeof items}`);
  eq(items.length, 2, 'items().length');
  eq(items[0].name, 'book', 'items()[0].name');
  eq(items[1].priceCents, 250, 'items()[1].priceCents');
});
check('Cart.total() still defaults to USD', () => eq(cartWith([['book', 1250], ['pen', 250]]).total(), '$15.00', 'total()'));
check("Cart.total('USD') -> $15.00", () => eq(cartWith([['book', 1250], ['pen', 250]]).total('USD'), '$15.00', "total('USD')"));
check("Cart.total('EUR') -> \u20ac15.00", () => eq(cartWith([['book', 1250], ['pen', 250]]).total('EUR'), '\u20ac15.00', "total('EUR')"));
check("Cart.total('GBP') -> \u00a315.00", () => eq(cartWith([['book', 1250], ['pen', 250]]).total('GBP'), '\u00a315.00', "total('GBP')"));
check('an empty cart totals $0.00', () => eq(cartWith([]).total(), '$0.00', 'empty total()'));

// an unknown currency must throw an Error naming the bad code — from both entries
check("format(1, 'XYZ') throws an Error naming XYZ", () => {
  const err = caught(() => currency.format(1, 'XYZ'));
  if (err === null) throw new Error('it did not throw');
  if (!(err instanceof Error)) throw new Error(`it threw a ${typeof err}, not an Error`);
  if (!String(err.message).includes('XYZ')) throw new Error(`the message does not contain the bad code: "${err.message}"`);
});
check("formatMoney with an unknown currency (via format) throws an Error naming the code", () => {
  const err = caught(() => index.format(1, 'nope'));
  if (err === null) throw new Error('it did not throw');
  if (!(err instanceof Error)) throw new Error(`it threw a ${typeof err}, not an Error`);
  if (!String(err.message).includes('nope')) throw new Error(`the message does not contain the bad code: "${err.message}"`);
});
check("Cart.total('XYZ') throws an Error naming XYZ", () => {
  const err = caught(() => cartWith([['book', 1250]]).total('XYZ'));
  if (err === null) throw new Error('it did not throw');
  if (!(err instanceof Error)) throw new Error(`it threw a ${typeof err}, not an Error`);
  if (!String(err.message).includes('XYZ')) throw new Error(`the message does not contain the bad code: "${err.message}"`);
});

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
