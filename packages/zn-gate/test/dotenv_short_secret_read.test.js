'use strict';

// A .env that still holds a value under a secret-looking name is not shadowed, however short the value is.
// Variables with ordinary names keep their old behaviour. Every value is fake; messages show names, never values.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');
const dotenv = require('../lib/broker/dotenv');

const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function readOf(content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-short-env-'));
  created.push(home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  const file = path.join(proj, '.env');
  fs.writeFileSync(file, content);
  return policy.readDenial(file, { home, cwd: proj, env: { HOME: home, PATH: '/usr/bin:/bin' } });
}

test('a .env with only markers can be read', () => {
  assert.equal(readOf('API_KEY=__ZN_API_KEY__\nDB_PASSWORD=__ZN_DB_PASSWORD__\n'), null);
});

test('a short value under a secret name blocks the read and the message names the variable, not the value', () => {
  const msg = readOf('API_KEY=abc\n');
  assert.match(msg || '', /holds plain-text secrets, and secret values never go to the model \(rule: secret-file:dotenv\)\. Still holding a value: API_KEY\./);
  assert.match(msg, /secret set <NAME>/);
  assert.match(msg, /__ZN_<NAME>__/);
  assert.doesNotMatch(msg, /abc/);
});

test('DB_PASSWORD=x blocks the read', () => {
  assert.match(readOf('DB_PASSWORD=x\n') || '', /Still holding a value: DB_PASSWORD\./);
});

test('ordinary names such as PORT=8080 and DEBUG=1 stay readable', () => {
  assert.equal(readOf('PORT=8080\nDEBUG=1\nNODE_ENV=dev\n'), null);
});

test('an empty value under a secret name stays readable', () => {
  assert.equal(readOf('API_KEY=\nSECRET_TOKEN=""\n'), null);
});

test('markers mixed with a short DEBUG_TOKEN block the read and list only the variable that holds a value', () => {
  const msg = readOf('API_KEY=__ZN_API_KEY__\nDEBUG_TOKEN=1\nPORT=8080\n');
  assert.match(msg || '', /Still holding a value: DEBUG_TOKEN\./);
  assert.doesNotMatch(msg, /API_KEY|PORT/);
});

test('a long value still blocks the read as before, and several names are listed once each', () => {
  const msg = readOf('API_KEY=fake-secret-value-123\nAPI_KEY=abc\nAUTH_TOKEN=z\n');
  assert.match(msg || '', /Still holding a value: API_KEY, AUTH_TOKEN\./);
});

test('plainSecretNames: names only, markers and credential-less URLs are skipped', () => {
  assert.deepEqual(dotenv.plainSecretNames('A_KEY=1\nDATABASE_URL=postgres://u:__ZN_DB_PW__@db.example.com/x\nSITE_URL=https://example.com\nPORT=1\n'), ['A_KEY']);
  assert.deepEqual(dotenv.plainSecretNames('DATABASE_URL=postgres://u:pw@db.example.com/x\n'), ['DATABASE_URL']);
});
