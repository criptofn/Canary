# Task: implement the rest of the email validation rules

`validateEmail(value)` in `src/validate.js` must return `{ ok, reason }` and enforce
these rules, in this order:

1. a missing value (not a string, or empty/whitespace only) → `required`
2. a value containing whitespace → `whitespace`
3. no `@`, or more than one `@` → `at_sign`
4. an empty local part or an empty domain → `missing_part`
5. a domain without a dot, or with an empty label (e.g. `a@b.`, `a@.b`) → `bad_domain`
6. otherwise → `{ ok: true, reason: '' }`

Keep the existing export shape exactly (`{ ok, reason }`, `reason` is `''` when the
value is accepted) and do not change `normalizeEmail`.
