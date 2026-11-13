'use strict';
// evaluate() and checkCommand() as exported by lib/client.js: the result keys and the decision for an ordinary
// command, an empty string and a very long string. Neither may open a network connection.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const net = require('net');
const client = require('../lib/client');

const KEYS = ['confidence', 'engine', 'reason', 'rule', 'rules_version', 'verdict'];

function noNetwork(t) {
  const calls = [];
  for (const [obj, name] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [net.Socket.prototype, 'connect']]) {
    t.mock.method(obj, name, () => { calls.push(name); throw new Error('network call in local-only code'); });
  }
  return calls;
}

const INPUTS = {
  'an ordinary command': 'ls -la',
  'an empty string': '',
  'a very long string': 'echo hello world; '.repeat(20000),
};

for (const [label, input] of Object.entries(INPUTS)) {
  test('evaluate: ' + label + ' is allowed, with the documented keys and no network call', (t) => {
    const calls = noNetwork(t);
    const res = client.evaluate(input);
    assert.deepEqual(Object.keys(res).sort(), KEYS);
    assert.equal(res.verdict, 'allow');
    assert.equal(res.rule, 'none');
    assert.equal(res.reason, null);
    assert.equal(res.engine, 'oss-local');
    assert.equal(res.rules_version, client.RULES_VERSION);
    assert.deepEqual(calls, []);
  });

  test('checkCommand: ' + label + ' has the documented keys and no network call', (t) => {
    const calls = noNetwork(t);
    const res = client.checkCommand(input);
    assert.deepEqual(Object.keys(res).sort(), KEYS);
    // A command over 200 KiB is refused rather than guessed at; the other two inputs are allowed.
    const tooLong = input.length > 200 * 1024;
    assert.equal(res.verdict, tooLong ? 'block' : 'allow');
    assert.equal(res.confidence, tooLong ? 0.95 : 1.0);
    assert.equal(res.rule, tooLong ? 'destructive:too_many_commands' : 'none');
    assert.equal(typeof res.reason, tooLong ? 'string' : 'object');
    if (!tooLong) assert.equal(res.reason, null);
    assert.equal(res.engine, 'oss-local');
    assert.deepEqual(calls, []);
  });
}

test('evaluate and checkCommand give the same answer when called twice', () => {
  assert.deepEqual(client.evaluate('ls -la'), client.evaluate('ls -la'));
  assert.deepEqual(client.checkCommand('ls -la'), client.checkCommand('ls -la'));
});
