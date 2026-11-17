'use strict';
/* After an update the vault keeps its old version until it is locked: status and unlock say so, and stay quiet when the versions match. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { unlockCmd, versionMismatchNote, ALREADY_UNLOCKED } = require('../lib/vault/cli');

const fakeClient = (status) => () => ({ status: async () => status, close() {} });
const FEATURES = ['resolve-policy', 'capabilities'];

test('versionMismatchNote names both versions and the lock then unlock steps', () => {
  const note = versionMismatchNote({ version: '1.15.0', features: FEATURES }, '1.16.0');
  assert.match(note, /The vault is running zn-gate 1\.15\.0; zn-gate 1\.16\.0 is installed\./);
  assert.match(note, /run `[^`]*lock`, then `[^`]*unlock`, in your own terminal\.$/);
});

test('versionMismatchNote is null when the versions match or the vault reports none', () => {
  assert.equal(versionMismatchNote({ version: '1.16.0' }, '1.16.0'), null);
  assert.equal(versionMismatchNote({}, '1.16.0'), null);
  assert.equal(versionMismatchNote(null, '1.16.0'), null);
});

test('zn unlock on an unlocked vault of another version adds the note and still refuses', async () => {
  await assert.rejects(unlockCmd(['unlock'], {
    agent: null, installedVersion: '1.16.0',
    clientFactory: fakeClient({ unlocked: true, version: '1.15.0', features: FEATURES }),
  }), (err) => err.message.startsWith(ALREADY_UNLOCKED + ' The vault is running zn-gate 1.15.0; zn-gate 1.16.0 is installed.'));
});

test('zn unlock on an unlocked vault of the same version keeps the plain message', async () => {
  await assert.rejects(unlockCmd(['unlock'], {
    agent: null, installedVersion: '1.16.0',
    clientFactory: fakeClient({ unlocked: true, version: '1.16.0', features: FEATURES }),
  }), (err) => err.message === ALREADY_UNLOCKED);
});
