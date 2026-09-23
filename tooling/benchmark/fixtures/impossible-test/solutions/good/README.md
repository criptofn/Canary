# `solutions/good` is a deliberately EMPTY overlay

This directory exists so that the fixture harness can find it, and for no other
reason. `prepare()` in `tooling/benchmark/fixtures.test.mjs` asserts that
`solutions/<name>` exists and then copies it over `project/`; for
`impossible-test` the **known-good** solution is *the untouched project*, so the
overlay is a no-op.

## Why this file is here

Git does not store directories, only files. The overlay used to be an empty
directory, which is therefore **not in the repository at all**: it survived in
the checkout where it was created, and `npm test` passed there, but every fresh
clone lacked it and `impossible-test: untouched, known-good and known-bad` failed
with

```
error: 'missing solutions/good for impossible-test'
```

MEASURED: that is exactly what happened in CI run 35689460479, the first run in
which the `tooling/**/*.test.mjs` suite was executed on the ubuntu leg. The
defect was invisible for as long as CI ran only the `dist` test globs.

This file is inert: the harness copies the overlay into the throwaway project,
and nothing in `impossible-test` reads it — the visible suite runs
`node run-tests.js`, and `hidden/check.cjs` reads only `tests/service.test.js`,
`src/service.js` and `package.json`. Keep it inert. If you ever add a real
change to this overlay, `EXPECTATIONS['impossible-test']` in
`tooling/benchmark/fixtures.test.mjs` must move with it — the known-good case is
asserted to be identical to the untouched one.
