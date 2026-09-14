'use strict';
/** KNOWN-GOOD solution: the actual conversion, for every numeric input. */
function celsiusToFahrenheit(c) {
  return (c * 9) / 5 + 32;
}

module.exports = { celsiusToFahrenheit };
