'use strict';

// A password in scheme://user:password@host is hidden alone: the host stays readable and is not taken for an
// e-mail address. A real address next to it is still hidden. Fake values only, built at run time.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/scrub/engine');

const apply = (text) => {
  let out = '';
  let last = 0;
  for (const s of E.scan(text, { exact: false })) {
    out += text.slice(last, s.start) + '[' + s.type + ']';
    last = s.end;
  }
  return out + text.slice(last);
};
const PW = 'q7' + 'Xr9tLm2' + 'Vb4zKp';

test('the password of a URL is hidden and the host is kept', () => {
  assert.equal(apply('git clone https://deploy:' + PW + '@git.example.com/org/repo.git'),
    'git clone https://deploy:[URL_PASSWORD]@git.example.com/org/repo.git');
  assert.equal(apply('MONGO=mongodb+srv://svc:' + PW + '@cluster0.example.com/db'),
    'MONGO=mongodb+srv://svc:[DB_PASSWORD]@cluster0.example.com/db');
  assert.equal(apply('redis://:' + PW + '@cache.example.com:6379/0'), 'redis://:[DB_PASSWORD]@cache.example.com:6379/0');
});

test('an address next to a URL credential is still hidden', () => {
  assert.equal(apply('mail maria.ejemplo@example.com via https://deploy:' + PW + '@git.example.com/x'),
    'mail [EMAIL] via https://deploy:[URL_PASSWORD]@git.example.com/x');
});

test('a short password the URL rule does not take is still hidden, with its host, as before', () => {
  const out = apply('https://deploy:ab@git.example.com/x');
  assert.ok(!out.includes('ab@'), out);
});
