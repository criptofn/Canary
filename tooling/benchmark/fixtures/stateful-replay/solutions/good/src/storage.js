exports.key = (tenant, id) => JSON.stringify([tenant, id]);
exports.create = () => new Map();
