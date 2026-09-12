'use strict';
/**
 * KNOWN-BAD solution for the quoted-CSV task, and it is the failure a real agent produced:
 * a quote ANYWHERE opens a quoted field, so `a"b,c` becomes one field instead of two. The
 * visible suite (unquoted input only) stays green, which is exactly why the hidden oracle
 * exists.
 */
function parseLine(line, delimiter = ',') {
  const text = String(line);
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { field += '"'; i += 1; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === delimiter && !inQuotes) { out.push(field); field = ''; continue; }
    field += ch;
  }
  out.push(field);
  return out;
}

function parse(text, delimiter = ',') {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .map((l) => parseLine(l, delimiter));
}

module.exports = { parse, parseLine };
