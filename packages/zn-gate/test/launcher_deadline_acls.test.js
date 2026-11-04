'use strict';

// launcherDeadlineS (the launcher's own deadline from the host timeout) and parseWinAcls (the line format of the
// Windows ACL script) on edge input. Values are fake; nothing is written and no PowerShell is started.

const test = require('node:test');
const assert = require('node:assert/strict');

const { launcherDeadlineS, parseWinAcls } = require('../lib/agents/launcher');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const ME = 'S-1-5-21-1-2-3-1001';

test('launcherDeadlineS keeps a normal timeout two seconds short', () => {
  assert.equal(launcherDeadlineS(10), 8);
  assert.equal(launcherDeadlineS(30), 28);
});

test('launcherDeadlineS never goes below one second for zero or negative timeouts', () => {
  assert.equal(launcherDeadlineS(0), 1);
  assert.equal(launcherDeadlineS(-1), 1);
  assert.equal(launcherDeadlineS(-600), 1);
  assert.equal(launcherDeadlineS(1), 1);
  assert.equal(launcherDeadlineS(3), 1);
  assert.equal(launcherDeadlineS(4), 2);
});

test('launcherDeadlineS rounds a fractional timeout down before it subtracts', () => {
  assert.equal(launcherDeadlineS(0.5), 1);
  assert.equal(launcherDeadlineS(2.9), 1);
  assert.equal(launcherDeadlineS(5.9), 3);
  assert.equal(launcherDeadlineS(10.999), 8);
  assert.equal(launcherDeadlineS(-0.5), 1);
});

test('launcherDeadlineS passes a very large timeout through, minus two seconds', () => {
  assert.equal(launcherDeadlineS(86400), 86398);
  assert.equal(launcherDeadlineS(1e9), 1e9 - 2);
  assert.equal(launcherDeadlineS(2 ** 31), 2 ** 31 - 2);
  assert.equal(launcherDeadlineS(Infinity), Infinity);
});

test('parseWinAcls refuses empty and blank text', () => {
  for (const text of ['', '\n', '\r\n', '\r\n\r\n', '   ', undefined]) {
    assert.throws(() => parseWinAcls(text), /unreadable answer/, JSON.stringify(text));
  }
});

test('parseWinAcls reads CRLF output the same as LF output', () => {
  const lines = ['U\t' + ME, 'E\t' + b64('C:\\example\\a') + '\t' + ME + '\t1\t0', 'A\t' + ME + '\t2032127\tAllow\t0\t3', 'Z'];
  const lf = parseWinAcls(lines.join('\n') + '\n');
  const crlf = parseWinAcls(lines.join('\r\n') + '\r\n');
  assert.deepEqual(crlf, lf);
  assert.equal(crlf.entries[0].path, 'C:\\example\\a');
  assert.equal(crlf.entries[0].aces.length, 1);
});

test('parseWinAcls accepts CRLF with blank lines between records and no final newline', () => {
  const doc = parseWinAcls('U\t' + ME + '\r\n\r\nZ');
  assert.deepEqual(doc, { user: ME, entries: [] });
});

test('parseWinAcls reads one entry per line with its rules below it', () => {
  const text = [
    'U\t' + ME,
    'E\t' + b64('C:\\example') + '\t' + ME + '\t1\t0',
    'A\t' + ME + '\t2032127\tAllow\t0\t3',
    'E\t' + b64('C:\\example\\b') + '\tS-1-5-18\t1\t1',
    'E\t' + b64('C:\\example\\c.txt') + '\tS-1-5-32-544\t0\t0',
    'A\tS-1-1-0\t278\tDeny\t1\t0',
    'A\tS-1-5-18\t-1\tAllow\t0\t1',
    'Z',
    '',
  ].join('\n');
  const doc = parseWinAcls(text);
  assert.equal(doc.user, ME);
  assert.deepEqual(doc.entries.map((e) => e.path), ['C:\\example', 'C:\\example\\b', 'C:\\example\\c.txt']);
  assert.deepEqual(doc.entries.map((e) => e.aces.length), [1, 0, 2]);
  assert.deepEqual(doc.entries.map((e) => e.dir), [true, true, false]);
  assert.deepEqual(doc.entries.map((e) => e.reparse), [false, true, false]);
  assert.equal(doc.entries[2].aces[1].rights, -1);
});

test('parseWinAcls refuses text after the end line and an unfinished answer', () => {
  assert.throws(() => parseWinAcls('U\t' + ME + '\nZ\nZ\n'), /unreadable answer/);
  assert.throws(() => parseWinAcls('U\t' + ME + '\nZ\nE\t' + b64('C:\\x') + '\t' + ME + '\t1\t0\n'), /unreadable answer/);
  assert.throws(() => parseWinAcls('U\t' + ME + '\r\nE\t' + b64('C:\\x') + '\t' + ME + '\t1\t0\r\n'), /unreadable answer/);
});
