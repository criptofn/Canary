import assert from 'node:assert/strict';
import { quantizeSymmetric, buildMatrixNormBriefing } from './matrixNormCore.mjs';
for(const bits of [0,1,1.5,17,NaN,Infinity,'4',null]) assert.throws(()=>quantizeSymmetric([[1,-1]],bits),TypeError); for(let bits=2;bits<=16;bits++){const q=quantizeSymmetric([[0,1,-1],[0.5,-0.5,0]],bits); assert.ok(q.flat().every(Number.isFinite));} assert.equal(buildMatrixNormBriefing('matrixnorm').simulation.length,8); console.log('PASS H3 independent bit-width range contract');
