# flag-clusters

A small argv parser.

```
parseFlags(argv) -> options object
```

## Contract

| input | result |
|---|---|
| `--name=value` | `{ name: 'value' }` — the string, not coerced |
| `--name value` | `{ name: 'value' }` — the following argument, when it is not a flag |
| `--name` | `{ name: true }` |
| `-a` | `{ a: true }` |
| a combined short-flag argument | each flag in order set to `true`, so `-abc` → `{ a: true, b: true, c: true }` |
| `-a=b` | `{ a: 'b' }` — the **flag name** keeps its short form |
| an unknown `--` option | throws, naming the option |

A `--long` option is **never** split into single letters. A bare argument that follows no flag is
ignored rather than treated as an option.

## Tests

```
node run-tests.js
```
