# configcheck

`configcheck` validates a JSON service config and reports what is wrong with it.

```
node bin/configcheck.js --config <path> [--strict]
```

## The config file

A JSON object with these fields:

| field  | rule                                                                    |
|--------|-------------------------------------------------------------------------|
| `name` | a non-empty string                                                       |
| `port` | an integer between 1024 and 65535 (inclusive) — a float is not an integer |
| `mode` | exactly one of `dev`, `prod`, `test`                                     |

`port: 8080` is a **warning**, not an error: it is accepted, but it collides with the
dev server of several other tools.

## The contract (this is the requirement)

| outcome | exit code | stdout | stderr |
|---|---|---|---|
| the config is valid | **0** | `config <name>.json: ok` | empty |
| the config is valid but has warnings (and `--strict` was **not** passed) | **0** | `config <name>.json: ok`, then one `warning: <field>: <reason>` line per warning | empty |
| the config is invalid (or has warnings and `--strict` **was** passed) | **2** | empty | one `error: <field>: <reason>` line per error |
| the file is missing, unreadable, or not valid JSON | **3** | empty | `error: <reason>` |
| a required argument is missing, or an unknown argument was given | **3** | empty | `error: <reason>`, then the usage block |

Rules the table implies and the tests check:

- `validate(config, { strict })` returns `{ errors, warnings }`, and **every entry is a string of
  the form `<field>: <reason>`** (for example `port: must be an integer between 1024 and 65535`).
- `--strict` turns every warning into an error: it moves the entries between the two arrays, so
  `errors.length + warnings.length` is the same with and without it.
- A rejected config writes **nothing** to stdout; a rejected run's exit code is **2**, never 0.
- `loadConfig` already returns `{ config }` or `{ fatal }` and never throws.
- `--help` prints the usage block on stdout and exits 0.

## Tests

```
node run-tests.js
```
