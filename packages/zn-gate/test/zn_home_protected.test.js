'use strict';

// zn's state folder is protected where ZN_HOME puts it, as well as in <home>/.zn.
// Values are fake: the folder below does not exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const policy = require('../lib/hooks/policy');
const { znHomeDir } = require('../lib/zn-home');

const STATE = path.resolve('/srv/example/zn-state');
const opts = (env) => ({ home: path.resolve('/home/example'), cwd: path.resolve('/srv/example/proj'), env });

test('znHomeDir follows ZN_HOME, and falls back to <home>/.zn', () => {
  assert.equal(znHomeDir({ ZN_HOME: STATE }, '/home/example'), STATE);
  assert.equal(znHomeDir({}, '/home/example'), path.join('/home/example', '.zn'));
});

test('a read of a file in the ZN_HOME folder is classified as zn state', () => {
  const c = policy.classifyPath(path.join(STATE, 'audit.jsonl'), opts({ ZN_HOME: STATE }));
  assert.equal(c && c.kind, 'zn_state');
  assert.match(policy.readDenial(path.join(STATE, 'audit.jsonl'), opts({ ZN_HOME: STATE })) || '', /zn/);
});

test('a write into the ZN_HOME folder is denied, and <home>/.zn stays protected too', () => {
  const o = opts({ ZN_HOME: STATE });
  assert.ok(policy.writeDenial(path.join(STATE, 'config.json'), o), 'ZN_HOME folder');
  assert.ok(policy.writeDenial(path.join(o.home, '.zn', 'config.json'), o), 'default folder');
  assert.equal(policy.classifyPath(path.join(path.resolve('/srv/example'), 'zn-state-other', 'x'), o), null);
});
