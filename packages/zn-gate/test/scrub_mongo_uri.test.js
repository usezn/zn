'use strict';

// A MongoDB connection string's password is redacted for both mongodb:// and
// mongodb+srv://, while the user name, host, port and database stay visible.
// Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

const PW = 'ZnFakePw_77x';
const REDACTED = '[REDACTED_DB_PASSWORD]';

test('mongodb:// connection string keeps host, port and database, redacts the password', () => {
  const input = `mongodb://app_user:${PW}@db.example.com:27017/appdb`;
  const { sanitized } = redactSecrets(input);
  assert.equal(sanitized, `mongodb://app_user:${REDACTED}@db.example.com:27017/appdb`);
  assert.ok(!sanitized.includes(PW));
});

test('mongodb+srv:// connection string keeps host, database and options, redacts the password', () => {
  const input = `mongodb+srv://app_user:${PW}@cluster0.example.com/appdb?retryWrites=true&w=majority`;
  const { sanitized } = redactSecrets(input);
  assert.equal(sanitized, `mongodb+srv://app_user:${REDACTED}@cluster0.example.com/appdb?retryWrites=true&w=majority`);
  assert.ok(!sanitized.includes(PW));
});

test('mongodb:// URI embedded in a log line keeps the documentation IP host and port', () => {
  const input = `mongo uri: mongodb://admin:${PW}@192.0.2.10:27017/app`;
  const { sanitized } = redactSecrets(input);
  assert.equal(sanitized, `mongo uri: mongodb://admin:${REDACTED}@192.0.2.10:27017/app`);
  assert.ok(!sanitized.includes(PW));
});
