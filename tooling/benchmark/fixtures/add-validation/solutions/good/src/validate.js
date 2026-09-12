'use strict';
/**
 * KNOWN-GOOD solution for the validation task: every stated rule, in the stated order, with
 * the export shape unchanged.
 */
function validateEmail(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'required' };
  if (/\s/.test(value)) return { ok: false, reason: 'whitespace' };
  const atCount = (value.match(/@/g) ?? []).length;
  if (atCount !== 1) return { ok: false, reason: 'at_sign' };
  const [local, domain] = value.split('@');
  if (local === '' || domain === '') return { ok: false, reason: 'missing_part' };
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => l === '')) return { ok: false, reason: 'bad_domain' };
  return { ok: true, reason: '' };
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

module.exports = { validateEmail, normalizeEmail };
