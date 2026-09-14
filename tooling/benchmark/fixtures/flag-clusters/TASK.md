# Task: short-flag clusters in `parseFlags`

`parseFlags(argv)` in `src/flags.js` turns an argument list into an options object. It already
handles single flags, `--name=value`, and values in the following argument.

It does **not** handle short-flag clusters. Add them, honouring this requirement:

> a combined short-flag argument is split into its individual flags, in order, and each one is set
> to `true`; a `--long` option is never split; and `-a=b` keeps its `-a` flag name with the value `b`.

Concretely, `parseFlags(['-abc'])` must return `{ a: true, b: true, c: true }`, and
`parseFlags(['-ab', 'value', '--long'])` must set `a`, `b` and `long` while leaving `value` unset.

Keep the existing behaviour for everything else: unknown `--` options throw an error naming the
option, `--name=value` stores the string `value`, and a flag immediately followed by a non-flag
argument still takes that argument as its value.

`README.md` states the same contract.
