# Ledger contract

The public API is require('./src/api').open(history = []). Values are strings; tenant and id are arbitrary strings (including punctuation). Events are {op:'put',tenant,id,value} or {op:'delete',tenant,id}.

- put, remove and batch apply mutations in call order. batch accepts an array of events.
- get returns the latest value, or undefined for an absent/deleted pair. Cached hits AND cached misses must be fresh after all mutation paths.
- Equal ids in different tenants are independent. Keys must not collide even when tenant/id strings contain delimiters.
- exportJournal returns a detached array of detached event objects in mutation order. Mutating its result must not affect current state or later exports.
- open(exportJournal()) recreates the same observable state, including deletions, and preserves the history for subsequent exports and mutations. Repeated replay must remain equivalent.
- Inputs are valid, operations synchronous; persistence to disk, concurrency, nested object values and malformed-input handling are outside scope.
