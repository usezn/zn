'use strict';

process.env.ZN_STATS = 'off';

// ZCode adapter: configFile, commandText and configWarnings with no config, an empty config and a damaged
// config, in a temporary home. Each gives a plain result and never throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const zc = require('../lib/agents').getAdapter('zcode');
const { tempDir } = require('./helpers/tmp');

function writeConfig(home, text) {
  const file = zc.configFile({ home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('configFile: points at .zcode/cli/config.json under the given home', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  assert.equal(zc.configFile({ home }), path.join(home, '.zcode', 'cli', 'config.json'));
  assert.equal(zc.configFile({ home }), zc.hooksFile({ home }));
  assert.equal(typeof zc.configFile(), 'string');
});

test('configWarnings: no config file gives empty problems and notes', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  const w = zc.configWarnings({ home });
  assert.deepEqual(w.problems, []);
  assert.deepEqual(w.notes, []);
  assert.equal(typeof w.fix, 'string');
});

test('configWarnings: an empty file is reported as unreadable in a note only', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  for (const text of ['', '   \n']) {
    writeConfig(home, text);
    let w;
    assert.doesNotThrow(() => { w = zc.configWarnings({ home }); });
    assert.deepEqual(w.problems, [], JSON.stringify(text));
    assert.equal(w.notes.length, 1, JSON.stringify(text));
  }
});

test('configWarnings: valid JSON that is not an object says nothing wrong', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  for (const text of ['null', '[]', '42', '"text"']) {
    writeConfig(home, text);
    let w;
    assert.doesNotThrow(() => { w = zc.configWarnings({ home }); });
    assert.deepEqual(w.problems, [], text);
    assert.deepEqual(w.notes, [], text);
  }
});

test('configWarnings: an empty object says hooks are not enabled', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  const file = writeConfig(home, '{}');
  const w = zc.configWarnings({ home });
  assert.equal(w.problems.length, 1);
  assert.match(w.problems[0], /"hooks\.enabled" is not set/);
  assert.ok(w.problems[0].includes(file));
});

test('configWarnings: a damaged config gives one note and no problem', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  for (const text of ['{', '{"hooks": ', 'not json', '{"hooks": {"enabled": true,}}']) {
    const file = writeConfig(home, text);
    let w;
    assert.doesNotThrow(() => { w = zc.configWarnings({ home }); });
    assert.deepEqual(w.problems, [], text);
    assert.equal(w.notes.length, 1, text);
    assert.ok(w.notes[0].includes(file), text);
  }
});

test('configWarnings: odd shapes inside an enabled config do not throw', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  const shapes = [
    { hooks: { enabled: true } },
    { hooks: { enabled: true, events: null } },
    { hooks: { enabled: true, events: { PreToolUse: 'x' } } },
    { hooks: { enabled: true, events: { PreToolUse: [null, 3, { hooks: 'x' }, { hooks: [null, 'x'] }] } } },
    { hooks: [], features: 'x' },
  ];
  for (const data of shapes) {
    writeConfig(home, JSON.stringify(data));
    let w;
    assert.doesNotThrow(() => { w = zc.configWarnings({ home }); });
    assert.ok(Array.isArray(w.problems) && Array.isArray(w.notes));
  }
  writeConfig(home, JSON.stringify(shapes[0]));
  assert.deepEqual(zc.configWarnings({ home }).problems, []);
});

test('configWarnings: a leading byte order mark is ignored', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  writeConfig(home, '﻿{"hooks":{"enabled":true}}');
  const w = zc.configWarnings({ home });
  assert.deepEqual(w.problems, []);
  assert.deepEqual(w.notes, []);
});

test('configWarnings: a directory in place of the file gives a note, not an error', (t) => {
  const home = tempDir(t, 'zn-zc-edge-');
  fs.mkdirSync(zc.configFile({ home }), { recursive: true });
  let w;
  assert.doesNotThrow(() => { w = zc.configWarnings({ home }); });
  assert.deepEqual(w.problems, []);
  assert.equal(w.notes.length, 1);
});

test('commandText: missing or empty entries give an empty string', () => {
  for (const h of [undefined, null, {}, { type: 'process' }, { command: 42 }, { type: 'process', command: 42 }, { command: '' }]) {
    assert.equal(zc.commandText(h), '', JSON.stringify(h));
  }
});

test('commandText: a plain command string is returned as it is', () => {
  assert.equal(zc.commandText({ type: 'command', command: 'echo hi' }), 'echo hi');
});

test('commandText: a process entry joins its program and arguments', () => {
  assert.equal(zc.commandText({ type: 'process', command: '/opt/example/tool', args: ['a', 2, 'b'] }), '/opt/example/tool a 2 b');
  assert.equal(zc.commandText({ type: 'process', command: '/opt/example/tool' }), '/opt/example/tool');
  assert.equal(zc.commandText({ type: 'process', command: '/opt/example/tool', args: 'x' }), '/opt/example/tool');
});
