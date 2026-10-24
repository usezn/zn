'use strict';
/*
 * lib/agents/config-file.js: read, write and update of JSON config files, the style detection,
 * and the files that are missing, empty or invalid. The module reads and writes JSON only.
 * Every path is inside a temporary fake home.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const cfg = require('../lib/agents/config-file');

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = (file) => fs.readFileSync(file, 'utf8');

test('detectStyle: empty text and one-line text give the usual style', () => {
  const usual = { eol: '\n', indent: 2, bom: false, trailingNewline: true };
  assert.deepEqual(cfg.detectStyle(''), usual);
  assert.deepEqual(cfg.detectStyle('{"a":1}'), usual);
});

test('detectStyle: finds CRLF, indentation, a final newline and a BOM', () => {
  assert.deepEqual(cfg.detectStyle('{\r\n    "a": 1\r\n}\r\n'), { eol: '\r\n', indent: 4, bom: false, trailingNewline: true });
  assert.deepEqual(cfg.detectStyle('﻿{\n\t"a": 1\n}'), { eol: '\n', indent: '\t', bom: true, trailingNewline: false });
  assert.equal(cfg.detectStyle('{\n "a": 1\n}\n').indent, 1);
});

test('detectStyle: indentation is capped at ten spaces and a flat file keeps two', () => {
  assert.equal(cfg.detectStyle('{\n' + ' '.repeat(16) + '"a": 1\n}').indent, 10);
  assert.equal(cfg.detectStyle('{\n}\n').indent, 2);
});

test('formatJson: default style, CRLF with tabs, and no final newline', () => {
  assert.equal(cfg.formatJson({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}\n');
  assert.equal(cfg.formatJson({ a: 1 }, { eol: '\r\n', indent: '\t', bom: false, trailingNewline: true }), '{\r\n\t"a": 1\r\n}\r\n');
  assert.equal(cfg.formatJson({ a: 1 }, { eol: '\n', indent: 2, bom: false, trailingNewline: false }), '{\n  "a": 1\n}');
});

test('parseJson and stringifyJson: a file without a final newline stays without one', () => {
  const data = cfg.parseJson('{\n    "a": 1\n}');
  data.b = 2;
  assert.equal(cfg.stringifyJson(data), '{\n    "a": 1,\n    "b": 2\n}');
});

test('stringifyJson: data that was not parsed gets the usual style', () => {
  assert.equal(cfg.stringifyJson({ a: 1 }), '{\n  "a": 1\n}\n');
});

test('parseJson: invalid text throws a SyntaxError', () => {
  assert.throws(() => cfg.parseJson('{ nope'), SyntaxError);
});

test('readJson: a file with only a BOM reads as an empty object', (t) => {
  const file = path.join(tempDir(t, 'zn-cfgfile-'), 'bom.json');
  put(file, '﻿');
  assert.deepEqual(cfg.readJson(file), {});
});

test('readJson: a number, a string and a boolean are refused and the file is left unchanged', (t) => {
  const h = tempDir(t, 'zn-cfgfile-');
  for (const [text, what] of [['5', 'number'], ['"x"', 'string'], ['true', 'boolean']]) {
    const file = path.join(h, what + '.json');
    put(file, text);
    assert.throws(() => cfg.readJson(file), new RegExp('must hold a JSON object, not ' + what));
    assert.equal(read(file), text);
  }
});

test('readJson: invalid JSON behind a BOM names the file in the error', (t) => {
  const file = path.join(tempDir(t, 'zn-cfgfile-'), 'bad.json');
  put(file, '﻿{ "a": ');
  assert.throws(() => cfg.readJson(file), (err) => err.message.includes('cannot parse ' + file) && /\(left unchanged\)$/.test(err.message));
});

test('update: read, change and write keeps CRLF, tabs and the BOM, and other keys in order', (t) => {
  const file = path.join(tempDir(t, 'zn-cfgfile-'), 'settings.json');
  put(file, '﻿{\r\n\t"z": 1,\r\n\t"a": {\r\n\t\t"b": true\r\n\t}\r\n}\r\n');
  const data = cfg.readJson(file);
  data.a.c = 'new';
  cfg.writeJson(file, data);
  assert.equal(read(file), '﻿{\r\n\t"z": 1,\r\n\t"a": {\r\n\t\t"b": true,\r\n\t\t"c": "new"\r\n\t}\r\n}\r\n');
});

test('update: a missing file is created in the usual style, then updated in place', (t) => {
  const file = path.join(tempDir(t, 'zn-cfgfile-'), 'sub', 'config.json');
  const first = cfg.readJson(file);
  first.a = 1;
  cfg.writeJson(file, first);
  assert.equal(read(file), '{\n  "a": 1\n}\n');
  const second = cfg.readJson(file);
  second.b = 2;
  cfg.writeJson(file, second);
  assert.equal(read(file), '{\n  "a": 1,\n  "b": 2\n}\n');
});

test('update: a blank file is replaced by the usual style', (t) => {
  const file = path.join(tempDir(t, 'zn-cfgfile-'), 'blank.json');
  put(file, '\r\n\r\n');
  const data = cfg.readJson(file);
  data.a = 1;
  cfg.writeJson(file, data);
  assert.equal(read(file), '{\n  "a": 1\n}\n');
});

test('writeJson: an existing file keeps its permissions; a new file is not world-writable', { skip: process.platform === 'win32' }, (t) => {
  const h = tempDir(t, 'zn-cfgfile-');
  const file = path.join(h, 'private.json');
  put(file, '{}');
  fs.chmodSync(file, 0o600);
  cfg.writeJson(file, { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const fresh = path.join(h, 'fresh.json');
  cfg.writeJson(fresh, { a: 1 });
  assert.equal(fs.statSync(fresh).mode & 0o022, 0);
});

test('backup: copies the bytes of a CRLF file with a BOM exactly', (t) => {
  const file = path.join(tempDir(t, 'zn-cfgfile-'), 'hooks.json');
  const original = '﻿{\r\n  "a": 1\r\n}\r\n';
  put(file, original);
  const dest = cfg.backup(file);
  assert.equal(read(dest), original);
  assert.equal(read(file), original);
});
