'use strict';
const { normalize } = require('../src/text.js');

module.exports = {
  'the identity case is unchanged': () => {
    if (normalize('ada') !== 'ada') throw new Error(`expected "ada", got ${JSON.stringify(normalize('ada'))}`);
  },
};
