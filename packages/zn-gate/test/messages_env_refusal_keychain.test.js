'use strict';
/* Checks stable parts of environmentRefusal and disconnectKeychainLeft in lib/messages.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { environmentRefusal, disconnectKeychainLeft } = require('../lib/messages');

test('environmentRefusal starts with the variable name', () => {
  assert.ok(environmentRefusal('EXAMPLE_KEY', 'reason here', false).startsWith('EXAMPLE_KEY'));
});

test('environmentRefusal says the saved key only when saved is true', () => {
  assert.ok(environmentRefusal('EXAMPLE_KEY', 'r', true).includes('the saved key'));
  const plain = environmentRefusal('EXAMPLE_KEY', 'r', false);
  assert.ok(plain.includes('the key'));
  assert.ok(!plain.includes('saved'));
});

test('environmentRefusal includes the reason', () => {
  assert.ok(environmentRefusal('EXAMPLE_KEY', 'a distinct reason', true).includes('a distinct reason'));
});

test('environmentRefusal gives unset instructions for each shell', () => {
  const text = environmentRefusal('EXAMPLE_KEY', 'r', false);
  assert.ok(text.includes('unset EXAMPLE_KEY'));
  assert.ok(text.includes('macOS'));
  assert.ok(text.includes('Linux'));
  assert.ok(text.includes('Remove-Item Env:EXAMPLE_KEY'));
  assert.ok(text.includes('PowerShell'));
});

test('disconnectKeychainLeft includes the reason and names the zn-cloud item', () => {
  const text = disconnectKeychainLeft('keychain is locked', 'https://dashboard.example.com', true);
  assert.ok(text.includes('keychain is locked'));
  assert.ok(text.includes('zn-cloud'));
});

test('disconnectKeychainLeft without revoke gives the dashboard and the key warning', () => {
  const text = disconnectKeychainLeft('r', 'https://dashboard.example.com', false);
  assert.ok(text.includes('https://dashboard.example.com'));
  assert.ok(text.includes('still works until you revoke it'));
});

test('disconnectKeychainLeft with revoke omits the key warning', () => {
  const text = disconnectKeychainLeft('r', 'https://dashboard.example.com', true);
  assert.ok(!text.includes('still works until you revoke it'));
  assert.ok(!text.includes('https://dashboard.example.com'));
});
