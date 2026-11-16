'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../lib/broker/dotenv');

test('text with only comments and blank lines has no entries', () => {
  const samples = [
    '# only a comment\n\n# another\n',
    '# a\r\n\r\n  # indented comment\r\n\t# tab comment\r\n',
    '   \n\t\n',
    '',
  ];
  for (const text of samples) {
    assert.deepEqual(d.parseDotenv(text).entries, [], JSON.stringify(text));
  }
});
