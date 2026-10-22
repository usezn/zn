'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

// Fictitious value: machine-looking, not a real credential.
const V = 'Zq8vK2mXp9Lw4Rt7';
const R = '[REDACTED_SECRET]';

test('inline credential assignment before a command is redacted, relative paths included', () => {
  const commands = ['npm test', 'node app.js', './run', '../bin/run', './scripts/x.sh', '~/bin/run', '/usr/local/bin/run'];
  for (const name of ['password', 'PASSWORD', 'secret', 'token', 'Passphrase']) {
    for (const cmd of commands) {
      const out = redactSecrets(`${name}=${V} ${cmd}`);
      assert.equal(out.sanitized, `${name}=${R} ${cmd}`, `${name} before ${cmd}`);
      assert.equal(out.detections[0].rule, 'secret:inline_credential');
    }
  }
});

test('inline credential assignment after other assignments or env is redacted', () => {
  assert.equal(redactSecrets(`env FOO=bar password=${V} ./run --flag`).sanitized, `env FOO=bar password=${R} ./run --flag`);
  assert.equal(redactSecrets(`A=1 B=2 token=${V} ../bin/run`).sanitized, `A=1 B=2 token=${R} ../bin/run`);
});

test('non-secret names and arguments stay untouched', () => {
  for (const s of [
    `a=${V} ./run`,
    `name=${V} ../bin/run`,
    `./run password=${V}`,
    `./run --opt password=${V}`,
    `password=${V}`,
    'password=changeme-please ./run',
    'password=short ./run',
    'password=$PASSWORD_FROM_ENV ./run',
  ]) {
    assert.equal(redactSecrets(s).sanitized, s, s);
  }
});
