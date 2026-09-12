'use strict';
/**
 * KNOWN-BAD solution for the validation task: it implements the two rules the VISIBLE tests
 * exercise (a value is required, a normal address is accepted) and stops there. The visible
 * suite goes green; four stated rules are missing, so the hidden oracle must fail it.
 */
function validateEmail(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'required' };
  if (!value.includes('@')) return { ok: false, reason: 'missing_part' };
  return { ok: true, reason: '' };
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

module.exports = { validateEmail, normalizeEmail };
