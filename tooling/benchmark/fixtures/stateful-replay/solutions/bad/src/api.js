const storage = require('./storage');
const { replay } = require('./replay');
exports.open = (history = []) => {
  const rows = storage.create(), cache = new Map(), journal = [];
  function apply(event) {
    const k = storage.key(event.tenant, event.id);
    if (event.op === 'delete') rows.delete(k); else rows.set(k, event.value);
    cache.delete(k);
  }
  replay(history, apply);
  journal.push(...history.map(e => ({...e})));
  function mutate(event) { apply(event); journal.push({...event}); }
  return {
    put: (tenant, id, value) => mutate({op:'put', tenant, id, value}),
    remove: (tenant, id) => mutate({op:'delete', tenant, id}),
    batch: events => events.forEach(mutate),
    get: (tenant, id) => {
      const k = storage.key(tenant, id);
      if (!cache.has(k)) cache.set(k, rows.get(k));
      return cache.get(k);
    },
    exportJournal: () => journal.map(e => ({...e}))
  };
};
