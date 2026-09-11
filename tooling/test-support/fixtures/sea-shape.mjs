/** Capability check: how does `node:sea` expose its API on this Node build?
 *  Needed to import it correctly in the CLI (namespace vs named vs default).
 *  Prints keys and the plausible access forms, then exits. */
import * as ns from 'node:sea';

console.log(`namespace keys: ${JSON.stringify(Object.keys(ns).sort())}`);
console.log(`typeof ns.isSea: ${typeof ns.isSea}`);
console.log(`typeof ns.default: ${typeof ns.default}`);
if (ns.default !== undefined) console.log(`default keys: ${JSON.stringify(Object.keys(ns.default).sort())}`);
console.log(`isSea() via namespace: ${typeof ns.isSea === 'function' ? String(ns.isSea()) : 'unavailable'}`);
console.log(`isSea() via default: ${typeof ns.default?.isSea === 'function' ? String(ns.default.isSea()) : 'unavailable'}`);
