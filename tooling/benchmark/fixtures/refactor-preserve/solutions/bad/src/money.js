'use strict';
/**
 * KNOWN-BAD solution for the money task: string support works, but the refactor routes
 * everything through one formatter that ALWAYS emits two decimals, so the documented
 * `decimals: 0` behaviour is lost. The visible suite does not cover it, so the suite stays
 * green — this is the preservation failure the fixture is for.
 */
function parseCents(input) {
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
    if (m === null) throw new TypeError('formatMoney expects a finite number of cents');
    const sign = m[1] === undefined ? 1 : -1;
    return sign * (Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0')));
  }
  throw new TypeError('formatMoney expects a finite number of cents');
}

function formatMoney(input, options = {}) {
  const { symbol = '$', grouping = true } = options;
  const value = parseCents(input);
  const negative = value < 0;
  const abs = Math.abs(value);
  let wholeText = String(Math.floor(abs / 100));
  if (grouping) wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracText = `.${String(abs % 100).padStart(2, '0')}`;
  return `${negative ? '-' : ''}${symbol}${wholeText}${fracText}`;
}

module.exports = { formatMoney };
