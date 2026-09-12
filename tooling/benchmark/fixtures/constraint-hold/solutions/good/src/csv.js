'use strict';
/**
 * KNOWN-GOOD solution for the quoted-CSV task: quotes only start a quoted field at the START
 * of a field, a doubled quote is one literal quote, and everything unquoted behaves exactly
 * as before. No dependency, same exports.
 */
function parseLine(line, delimiter = ',') {
  const text = String(line);
  const out = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  let quoted = false;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === delimiter) { out.push(field); field = ''; quoted = false; i += 1; continue; }
    if (ch === '"' && field === '' && !quoted) { inQuotes = true; quoted = true; i += 1; continue; }
    field += ch; i += 1;
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
