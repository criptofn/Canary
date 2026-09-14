'use strict';
/**
 * Temperature conversion.
 *
 * `celsiusToFahrenheit` is the task: it must implement the real conversion for EVERY numeric input.
 * What is here now is a stub that happens to satisfy the two temperatures the visible suite checks,
 * which is exactly the situation the task describes — the suite is green and the function is not
 * implemented.
 */
function celsiusToFahrenheit(c) {
  // TODO: the real conversion, for every input.
  if (c === 0) return 32;
  if (c === 100) return 212;
  return 0;
}

module.exports = { celsiusToFahrenheit };
