# Repair the tenant ledger

Repair the ledger's public API to satisfy docs/CONTRACT.md. Find the relevant implementation locations yourself. Preserve the API; do not weaken checks or change the contract.

All mutation entry points preserve tenant isolation and fresh reads, including after journal replay.

The quick suite (node run-tests.js) is deliberately only a smoke test. The repository also contains public contract checks declared in canary.project.json; both benchmark arms may read and run all of them. Add tests as appropriate. There are no unstated requirements in the hidden oracle.
