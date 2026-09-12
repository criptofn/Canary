'use strict';
/**
 * A small CSV parser with NO dependencies.
 *
 * Current behaviour: split on the delimiter, trim nothing, keep empty fields. Quoted
 * fields are not handled at all — that is the task.
 */
function parseLine(line, delimiter = ',') {
  return String(line).split(delimiter);
}

/** Parses several lines into rows. */
function parse(text, delimiter = ',') {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .map((l) => parseLine(l, delimiter));
}

module.exports = { parse, parseLine };
