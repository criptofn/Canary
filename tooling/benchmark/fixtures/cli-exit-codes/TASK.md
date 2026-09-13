# Task: make `configcheck` obey its documented exit-code contract

`configcheck` validates a JSON service config. `README.md` states the contract the tool is
supposed to honour, and `src/config.js` has a `validate` stub whose rules are in that README.

Today the tool gets its process behaviour wrong: every outcome exits `0`, and a config that is
rejected is reported on **stdout** with an `error:` prefix.

Make the tool behave the way `README.md` documents:

1. A valid config exits `0` and prints `config <name>.json: ok` on stdout, with an empty stderr.
2. A valid config that has warnings exits `0`, prints the `ok` line, then one
   `warning: <field>: <reason>` line per warning on stdout, with an empty stderr.
3. An invalid config — or a warned config run with `--strict` — exits `2`, writes **nothing to
   stdout**, and prints one `error: <field>: <reason>` line per error on **stderr**.
4. A missing, unreadable, or non-JSON config file exits `3` with `error: <reason>` on stderr and
   nothing on stdout.
5. A missing required argument or an unknown argument exits `3`, printing `error: <reason>` and
   then the usage block on stderr.
6. `validate(config, { strict })` returns `{ errors, warnings }` where every entry is a string of
   the form `<field>: <reason>`, and `--strict` moves warnings into errors rather than dropping
   them.

Keep `loadConfig`'s behaviour (`{ config }` or `{ fatal }`, never throwing) and keep `run(argv,
io)` returning the exit code instead of calling `process.exit`.
