exports.replay = (events, apply) => events.filter(e => e.op === 'put').forEach(apply);
