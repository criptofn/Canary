'use strict';
/**
 * Validation helpers. `validateEmail` currently only rejects an empty value — the
 * rest of the rules are the task.
 *
 * The contract it must keep:
 *   validateEmail(value) -> { ok: boolean, reason: string }
 *   reason is '' when ok is true, and a short snake_case token otherwise.
 */
function validateEmail(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'required' };
  return { ok: true, reason: '' };
}

/** Trims and lowercases a value for storage. */
function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

module.exports = { validateEmail, normalizeEmail };
