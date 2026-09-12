'use strict';
/**
 * KNOWN-GOOD solution for the money task: it accepts a decimal string AND keeps every
 * documented behaviour of the integer path.
 */
function parseCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('formatMoney expects a finite number of cents');
    return input;
  }
  if (typeof input === 'string') {
    const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
    if (m === null) throw new TypeError('formatMoney expects a finite number of cents');
    const sign = m[1] === undefined ? 1 : -1;
    const whole = Number(m[2]);
    const frac = Number((m[3] ?? '').padEnd(2, '0'));
    return sign * (whole * 100 + frac);
  }
  throw new TypeError('formatMoney expects a finite number of cents');
}

function formatMoney(input, options = {}) {
  const { symbol = '$', decimals = 2, grouping = true, round = 'half-up' } = options;
  let value = parseCents(input);
  if (round === 'up') value = Math.ceil(value);
  else if (round === 'down') value = Math.floor(value);
  else value = Math.round(value);

  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;

  let wholeText = String(whole);
  if (grouping) wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracText = decimals === 0 ? '' : `.${String(frac).padStart(2, '0').slice(0, decimals)}`;
  return `${negative ? '-' : ''}${symbol}${wholeText}${fracText}`;
}

module.exports = { formatMoney };
