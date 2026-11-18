'use strict';

// `zn why` reads the evidence log from its end in blocks. These tests check that the answer does
// not depend on where the block edges fall, that it matches the answer of a whole-file read on
// small logs, and that a log larger than a Node string can hold is read without throwing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runWhy, scanTail } = require('../lib/why');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-why-tail-'));
  return { dir, file: path.join(dir, 'evidence.jsonl') };
}

function rec(id, verdict, extra = {}) {
  return JSON.stringify({
    id,
    timestamp: '2026-11-18T10:00:00Z',
    agent_environment: 'claude-code',
    phase: 'hook-pre_tool',
    tool_name: 'Bash',
    payload_sha256: 'ab',
    payload_preview: 'ls -la é 中 🙂',
    verdict,
    rule: verdict === 'block' ? 'hook-pre_tool-secret' : null,
    reason: 'secret kinds: aws_access_key, café 中',
    engine: 'zn-hook',
    ...extra,
  });
}

function run(file, argv = [], extra = {}) {
  let out = '';
  let errOut = '';
  const code = runWhy(argv, {
    file,
    stdout: (s) => { out += s; },
    stderr: (s) => { errOut += s; },
    znCommand: (c) => 'zn ' + c,
    ...extra,
  });
  return { code, out, err: errOut };
}

const LINES = [
  rec('a1', 'allow'),
  rec('b2', 'block'),
  rec('c3', 'allow'),
  rec('d4', 'allow', { reason: 'long reason '.repeat(20) + 'é中🙂' }),
  rec('e5', 'block'),
  rec('f6', 'allow'),
];

const CASES = {
  lf: LINES.join('\n') + '\n',
  crlf: LINES.join('\r\n') + '\r\n',
  noTrailingNewline: LINES.join('\n'),
  blankAndSpacedLines: ['', LINES[0], '   ', LINES[1], '', LINES[2], '\t', LINES[3], LINES[4], '', LINES[5], ''].join('\n'),
};

const BLOCK_SIZES = [];
for (let b = 1; b <= 40; b++) BLOCK_SIZES.push(b);
BLOCK_SIZES.push(64 * 1024);

test('the answer does not depend on where the block edges fall', () => {
  for (const [name, text] of Object.entries(CASES)) {
    const { dir, file } = setup();
    fs.writeFileSync(file, text);
    const baseline = run(file);
    assert.equal(baseline.code, 0, name + ': ' + baseline.err);
    assert.match(baseline.out, /Record: +e5/, name);
    for (const blockBytes of BLOCK_SIZES) {
      const got = run(file, [], { blockBytes });
      assert.deepEqual(got, baseline, name + ' block ' + blockBytes);
    }
    for (const id of ['a1', 'b2', 'c3', 'd4', 'e5', 'f6']) {
      const want = run(file, [id]);
      for (const blockBytes of BLOCK_SIZES) {
        assert.deepEqual(run(file, [id], { blockBytes }), want, name + ' id ' + id + ' block ' + blockBytes);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a multi-byte character cut by a block edge is decoded whole', () => {
  const { dir, file } = setup();
  // Every block size from 1 to 40 cuts the 4-byte emoji and the 3-byte CJK characters somewhere.
  fs.writeFileSync(file, rec('mb1', 'block', { reason: '🙂🙂中中é' }) + '\n');
  for (const blockBytes of BLOCK_SIZES) {
    const got = run(file, [], { blockBytes });
    assert.equal(got.code, 0, 'block ' + blockBytes + ': ' + got.err);
    assert.match(got.out, /Record: +mb1/);
    assert.doesNotMatch(got.out, /�/, 'block ' + blockBytes);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('damaged lines are counted exactly when no match ends the read early', () => {
  const { dir, file } = setup();
  fs.writeFileSync(file, [rec('a1', 'allow'), '{not json', rec('b2', 'allow'), '[1,2]', rec('c3', 'allow')].join('\n') + '\n');
  const baseline = run(file, ['nope']);
  assert.equal(baseline.code, 1);
  assert.match(baseline.err, /no record with the id "nope".* 2 line\(s\) of the log could not be read/);
  for (const blockBytes of BLOCK_SIZES) {
    assert.deepEqual(run(file, ['nope'], { blockBytes }), baseline, 'block ' + blockBytes);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty log and a log with no records say so', () => {
  const { dir, file } = setup();
  fs.writeFileSync(file, '');
  let r = run(file);
  assert.equal(r.code, 1);
  assert.match(r.err, /the evidence log is empty/);
  fs.writeFileSync(file, '\n\n  \n');
  r = run(file, [], { blockBytes: 2 });
  assert.equal(r.code, 1);
  assert.match(r.err, /the evidence log is empty/);
  fs.writeFileSync(file, rec('a1', 'allow') + '\n');
  r = run(file);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block is recorded in the evidence log/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing log is reported as before', () => {
  const { dir, file } = setup();
  const r = run(file);
  assert.equal(r.code, 1);
  assert.match(r.err, /there is no evidence log yet/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanTail visits the records from the last line to the first, whatever the block size', () => {
  const { dir, file } = setup();
  fs.writeFileSync(file, LINES.join('\n') + '\n');
  for (const blockBytes of BLOCK_SIZES) {
    const ids = [];
    const stats = scanTail(file, (r) => { ids.push(r.id); return false; }, { blockBytes });
    assert.deepEqual(ids, ['f6', 'e5', 'd4', 'c3', 'b2', 'a1'], 'block ' + blockBytes);
    assert.deepEqual({ count: stats.count, damaged: stats.damaged, stopped: stats.stopped }, { count: 6, damaged: 0, stopped: false });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a line over the length limit is counted as damaged and does not stop the read', () => {
  const { dir, file } = setup();
  fs.writeFileSync(file, [rec('long', 'allow', { reason: 'x'.repeat(500) }), rec('ok', 'block')].join('\n') + '\n');
  for (const blockBytes of BLOCK_SIZES) {
    const ids = [];
    const stats = scanTail(file, (r) => { ids.push(r.id); return false; }, { blockBytes, maxLineBytes: 400 });
    assert.deepEqual(ids, ['ok'], 'block ' + blockBytes);
    assert.equal(stats.damaged, 1, 'block ' + blockBytes);
  }
  const kept = [];
  scanTail(file, (r) => { kept.push(r.id); return false; }, { maxLineBytes: 100000 });
  assert.deepEqual(kept, ['ok', 'long']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a log larger than 512 MB is read from its end without throwing', { skip: process.platform === 'win32' && 'needs sparse files' }, () => {
  const { dir, file } = setup();
  const size = 600 * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  try {
    // Zeros, stored sparsely on Linux and macOS: nothing is written before the end.
    fs.ftruncateSync(fd, size);
    const tail = '\n' + rec('big-1', 'allow') + '\n' + rec('big-2', 'block') + '\n';
    fs.writeSync(fd, tail, size);
  } finally {
    fs.closeSync(fd);
  }
  const found = run(file);
  assert.equal(found.code, 0, found.err);
  assert.match(found.out, /Record: +big-2/);
  const byId = run(file, ['big-1']);
  assert.equal(byId.code, 0, byId.err);
  assert.match(byId.out, /Record: +big-1/);
  // A full read: the zeros before the first newline are one damaged line.
  const missing = run(file, ['nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no record with the id "nope".* 1 line\(s\) of the log could not be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});
