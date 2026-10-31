'use strict';

// Direct tests of three small helpers: the generic tool event of the Claude Code adapter, the phone check of the
// scrubber, and the check's hook start timeout. Fake values only.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { unknownToolEvent } = require('../lib/agents/claude-code');
const { phoneValid } = require('../lib/scrub/patterns');
const { _internal } = require('../lib/check');

const base = { event: 'pre_tool', cwd: '/p' };

test('unknownToolEvent: a command key gives the shell checks', () => {
  for (const key of ['command', 'cmd', 'Command', 'script']) {
    const ev = unknownToolEvent(base, 'view', { [key]: 'ls -la' });
    assert.equal(ev.tool, 'bash');
    assert.equal(ev.toolName, 'view');
    assert.deepEqual(ev.input, { command: 'ls -la', texts: [] });
    assert.equal(ev.cwd, '/p');
  }
});

test('unknownToolEvent: paths give the file access checks', () => {
  const one = unknownToolEvent(base, 'read_file', { filePath: '/etc/example.conf' });
  assert.equal(one.tool, 'fileaccess');
  assert.equal(one.input.path, '/etc/example.conf');
  assert.deepEqual(one.input.paths, ['/etc/example.conf']);
  const two = unknownToolEvent(base, 'read_file', { filePath: '/a', paths: ['/b'] });
  assert.deepEqual(two.input.paths, ['/a', '/b']);
});

test('unknownToolEvent: a patch is a write that names its files', () => {
  const patch = '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch';
  const ev = unknownToolEvent(base, 'apply_patch', { input: patch });
  assert.equal(ev.tool, 'write');
  assert.deepEqual(ev.input.paths, ['note.txt']);
  assert.equal(ev.input.unparsed, false);
  assert.equal(ev.input.texts[0].value, patch);
});

test('unknownToolEvent: no command and no path gives no opinion', () => {
  assert.equal(unknownToolEvent(base, 'x', {}), null);
  assert.equal(unknownToolEvent(base, 'x', { note: 'hello' }), null);
});

test('unknownToolEvent: an empty command stays a shell event with no command', () => {
  const ev = unknownToolEvent(base, 'x', { wrapper: { command: '' } });
  assert.equal(ev.tool, 'bash');
  assert.deepEqual(ev.input, { texts: [] });
});

test('phoneValid: real-looking numbers (compact and separated)', () => {
  for (const v of ['+34600123456', '+34 600123456', '+1 202 555 0143', '+44 20 7946 0958']) assert.equal(phoneValid(v), true, v);
});

test('phoneValid: dates, dotted addresses, digit lists, unknown country and bare plus are not phones', () => {
  for (const v of ['+2024-01-15', '+1.2.3.4', '+1 2 3', '+999 123456789', '+34 60', '+']) assert.equal(phoneValid(v), false, v);
});

test('hookTimeout: the default stays unless a test passes a longer one', () => {
  const t = _internal.hookTimeout;
  assert.equal(t({}, 15000), 15000);
  assert.equal(t(null, 15000), 15000);
  assert.equal(t({ hookTimeoutMs: 60000 }, 15000), 60000);
});

test('hookTimeout: never shorter than its own, never above the ceiling, bad values ignored', () => {
  const t = _internal.hookTimeout;
  assert.equal(t({ hookTimeoutMs: 5000 }, 15000), 15000);
  assert.equal(t({ hookTimeoutMs: 999999 }, 15000), _internal.HOOK_TIMEOUT_CEILING_MS);
  for (const bad of [-1, 0, '9', NaN, null]) assert.equal(t({ hookTimeoutMs: bad }, 15000), 15000, String(bad));
  assert.equal(t({ hookTimeoutMs: 60000 }, undefined), 60000);
});
