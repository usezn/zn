'use strict';
/**
 * Tests for the streaming scrubber (lib/scrub/stream.js).
 *
 * Covers secrets split across chunk boundaries at every position, a partial
 * line that is cut before its newline, multibyte characters at a chunk edge,
 * the final flush, empty chunks and text without secrets.
 *
 * Every key here is a made-up value with a public prefix; none is a credential.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createStream, MAX_LINE, WINDOW_MIN } = require('../lib/scrub/stream');

const CTX = { project: os.tmpdir(), agent: 'stream', tool: 'stream', destination: 'assistant', vault: null };

const KEYS = {
  aws: 'AKIAQ7XK2MZP4RWT9VNB',
  anthropic: 'sk-ant-api03-FAKE9xQ2mLpT7vRbN4wZk8YdHs3JcA6uE1gXoI5nPq0rT',
  github: 'ghp_FAKE8kQ2mXp7ZrT4vNbW9yLdHs3JcA6uE1gX',
  openai: 'sk-test-FAKE9xQ2mLpT7vRbN4wZk8YdHs3JcA6uE1gXoI5n',
};

function collector() {
  const out = [];
  return { out, write: (t) => out.push(t), text: () => out.join('') };
}

async function feed(chunks, opts) {
  const flushBetween = !!(opts && opts.flushBetween);
  const c = collector();
  const s = createStream({ ctx: CTX, write: c.write });
  for (const ch of chunks) {
    await s.push(ch);
    if (flushBetween) await s.flushPartial();
  }
  await s.end();
  return c.text();
}

function assertScrubbed(out, key, label) {
  assert.ok(!out.includes(key), label + ': the key came through');
  assert.match(out, /__ZN_REDACTED_[A-Z_]+__/, label + ': no redaction marker');
}

for (const [name, key] of Object.entries(KEYS)) {
  test('key split at every position is redacted: ' + name, async () => {
    const line = 'export TOKEN=' + key + ' # trailing\n';
    for (let i = 0; i <= line.length; i++) {
      const out = await feed([line.slice(0, i), line.slice(i)]);
      assertScrubbed(out, key, 'split ' + i);
      assert.ok(out.startsWith('export TOKEN='), 'split ' + i + ': text before the key changed');
      assert.ok(out.endsWith(' # trailing\n'), 'split ' + i + ': text after the key changed');
    }
  });

  test('key split at every position with a flush between chunks: ' + name, async () => {
    const line = 'token ' + key + ' end\n';
    for (let i = 0; i <= line.length; i++) {
      const out = await feed([line.slice(0, i), line.slice(i)], { flushBetween: true });
      assertScrubbed(out, key, 'split ' + i);
    }
  });

  test('key fed one character at a time is redacted: ' + name, async () => {
    const line = 'a ' + key + ' b\n';
    const out = await feed(line.split(''), { flushBetween: true });
    assertScrubbed(out, key, 'per char');
    assert.equal(out.replace(/__ZN_REDACTED_[A-Z_]+__/, 'K'), 'a K b\n');
  });
}

test('key on the cut of a long partial line is not split', async () => {
  const key = KEYS.github;
  // The scrubber holds back the last WINDOW_MIN characters of a partial line
  // longer than MAX_LINE; the key is placed over that cut at several offsets.
  const total = MAX_LINE + 500;
  const cut = total - WINDOW_MIN;
  for (let back = 1; back < key.length; back += 3) {
    const start = cut - back;
    const text = 'x'.repeat(start - 1) + ' ' + key + ' ' + 'y'.repeat(total - start - key.length - 1);
    const c = collector();
    const s = createStream({ ctx: CTX, write: c.write });
    await s.push(text);
    assert.ok(!/ghp_/.test(c.text()), 'back ' + back + ': a piece of the key was written early');
    await s.end();
    assertScrubbed(c.text(), key, 'back ' + back);
    assert.equal(c.text().length, total - key.length + '__ZN_REDACTED_GITHUB_TOKEN__'.length);
  }
});

test('a long partial line is written up to the held-back window', async () => {
  const c = collector();
  const s = createStream({ ctx: CTX, write: c.write });
  const text = 'z'.repeat(MAX_LINE + 10);
  await s.push(text);
  const early = c.text();
  assert.ok(early.length > 0, 'nothing was written for a line past MAX_LINE');
  assert.ok(early.length <= text.length - WINDOW_MIN);
  await s.end();
  assert.equal(c.text(), text);
});

test('flushPartial writes nothing for a short partial line, end writes it', async () => {
  const c = collector();
  const s = createStream({ ctx: CTX, write: c.write });
  await s.push('partial output without newline');
  await s.flushPartial();
  assert.equal(c.text(), '');
  await s.end();
  assert.equal(c.text(), 'partial output without newline');
});

test('end scrubs a final line that has no newline', async () => {
  const out = await feed(['key=', KEYS.aws]);
  assertScrubbed(out, KEYS.aws, 'final line');
  assert.ok(!out.endsWith('\n'));
});

test('end twice does not repeat output', async () => {
  const c = collector();
  const s = createStream({ ctx: CTX, write: c.write });
  await s.push('one\ntwo');
  await s.end();
  await s.end();
  assert.equal(c.text(), 'one\ntwo');
});

test('empty chunks change nothing', async () => {
  const line = 'k ' + KEYS.openai + ' z\n';
  const half = Math.floor(line.length / 2);
  const out = await feed(['', line.slice(0, half), '', '', line.slice(half), '']);
  assertScrubbed(out, KEYS.openai, 'empty chunks');
  assert.equal(await feed(['', '', '']), '');
  assert.equal(await feed([]), '');
});

test('text without a secret passes through unchanged', async () => {
  const text = 'building project\nstep 1/3 ok\n\n  indented line\r\nsee https://example.com/a?b=1 host 192.0.2.10\nlast line';
  for (let i = 0; i <= text.length; i += 7) {
    assert.equal(await feed([text.slice(0, i), text.slice(i)]), text);
  }
  assert.equal(await feed(text.split('')), text);
});

test('several lines in one chunk are each scrubbed and kept in order', async () => {
  const out = await feed(['first ' + KEYS.aws + '\nmiddle\nlast ' + KEYS.github + '\n']);
  assert.ok(!out.includes(KEYS.aws) && !out.includes(KEYS.github));
  const lines = out.split('\n');
  assert.ok(lines[0].startsWith('first ') && lines[1] === 'middle' && lines[2].startsWith('last '));
});

test('multibyte characters in a long partial line survive the cut', async () => {
  // Characters of one and two UTF-16 units are mixed, so the cut falls on
  // each kind at some shift.
  const unit = 'é日😀';
  const total = MAX_LINE + 600;
  const body = unit.repeat(Math.ceil(total / unit.length)).slice(0, total);
  for (let shift = 0; shift < unit.length; shift++) {
    const text = 'a'.repeat(shift) + body;
    const out = await feed([text.slice(0, MAX_LINE + 1), text.slice(MAX_LINE + 1)]);
    assert.equal(out, text, 'shift ' + shift);
    assert.ok(!out.includes('�'));
  }
});

test('a cut inside a surrogate pair never writes half of a character', async () => {
  const total = MAX_LINE + 600;
  const cut = total - WINDOW_MIN;
  // The first half of the emoji is the last unit before the cut.
  const text = 'a'.repeat(cut - 1) + '😀' + 'b'.repeat(total - cut - 1);
  const c = collector();
  const s = createStream({ ctx: CTX, write: c.write });
  await s.push(text);
  await s.end();
  for (const piece of c.out) {
    assert.equal(Buffer.from(piece, 'utf8').toString('utf8'), piece, 'a piece was cut inside a surrogate pair');
  }
  assert.equal(c.text(), text);
});

function runCli(chunks, delayMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'scrub', 'stream.js')], {
      cwd: os.tmpdir(),
      env: Object.assign({}, process.env, { ZN_AGENT: 'stream-test' }),
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return child.stdin.end();
      child.stdin.write(chunks[i++]);
      setTimeout(next, delayMs);
    };
    next();
  });
}

test('command line: a multibyte character split between two writes is kept whole', async () => {
  const want = 'café 日本 😀 ok\n';
  const bytes = Buffer.from(want, 'utf8');
  // Offsets inside 2, 3 and 4 byte characters.
  for (const i of [4, 5, 7, 8, 11, 12, 13, 14]) {
    const out = await runCli([bytes.subarray(0, i), bytes.subarray(i)], 30);
    assert.equal(out, want, 'byte offset ' + i);
  }
});

test('command line: a key split between two writes is redacted', async () => {
  const line = 'k=' + KEYS.anthropic + '\n';
  const out = await runCli([line.slice(0, 20), line.slice(20)], 400);
  assertScrubbed(out, KEYS.anthropic, 'cli');
});
