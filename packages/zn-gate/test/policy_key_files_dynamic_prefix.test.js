'use strict';

// A key file (.pem, .key, .p8) behind a prefix the shell builds while the command runs is refused by its name, like a .env.
// Names and values are fake; nothing outside a temp folder is touched.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function project() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-keydyn-'));
  created.push(home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'nothing here\n');
  fs.writeFileSync(path.join(proj, 'cert.pem'), '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n');
  return { home, proj, opts: { home, cwd: proj, env: { HOME: home, PWD: proj, PATH: '/usr/bin:/bin' } } };
}

const PREFIXES = ['$(pwd)/', '`pwd`/', '${HOME%/}/', '${HOME#}/', '${HOME/x/y}/', '${HOME:-}/x/../', '${UNSETVAR}/', '$UNSETVAR/', '$(echo app)/'];
const KEYS = ['server.pem', 'server.key', 'AuthKey.p8', 'proj/server.pem', 'proj/AuthKey.p8'];
const DENIED = /builds the path of a private key file|was not read because/;

test('a key file name behind a path built at run time is refused, with or without a file on disk', () => {
  const { opts } = project();
  for (const pre of PREFIXES) {
    for (const key of KEYS) {
      for (const cmd of ['cat ' + pre + key, 'head -n1 ' + pre + key, 'cat "' + pre + key + '"', 'cp ' + pre + key + ' x']) {
        assert.match(policy.bashDenial(cmd, opts) || '', DENIED, cmd);
      }
    }
  }
});

test('the same prefixes before an ordinary name stay allowed', () => {
  const { opts } = project();
  for (const pre of PREFIXES) {
    for (const name of ['notes.txt', 'proj/notes.txt', 'README.md', 'cert.crt']) {
      assert.equal(policy.bashDenial('cat ' + pre + name, opts), null, pre + name);
    }
  }
});

test('key files named plainly, and a known variable before a certificate, behave as before', () => {
  const { home, proj, opts } = project();
  fs.writeFileSync(path.join(proj, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n');
  assert.match(policy.bashDenial('cat server.pem', opts) || '', DENIED);
  assert.match(policy.bashDenial('cat ${HOME}/proj/server.pem', opts) || '', DENIED);
  assert.equal(policy.bashDenial('cat cert.pem', opts), null);
  assert.equal(policy.bashDenial('cat ${HOME}/proj/cert.pem', opts), null);
  assert.equal(policy.bashDenial('cat missing.pem', opts), null);
  assert.ok(home);
});

test('a .env behind the same prefixes is still refused', () => {
  const { opts } = project();
  for (const pre of PREFIXES) assert.match(policy.bashDenial('cat ' + pre + '.env', opts) || '', /\.env|was not read because/, pre);
});
