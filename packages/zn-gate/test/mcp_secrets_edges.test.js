'use strict';
// Edge cases of the MCP configuration credential check: broken files, empty
// input, nested blocks, odd paths (Windows and POSIX shapes built with
// path.win32 / path.posix, so the result does not depend on the host OS), and
// masking. Every value is invented and assembled at run time. The shared
// samples in fixtures/mcp_config_secret_samples.json are checked by
// mcp_config_secrets.test.js; this file covers what they do not.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const mcp = require('../lib/mcp-secrets');

const FAKE = 'ZNTESTFAKE' + 'q8v3Lm9x2W';

function kinds(text, file) {
  return mcp.findMcpConfigSecrets(text, file === undefined ? {} : { file }).map((f) => [f.line, f.kind, f.name]);
}

test('empty and whitespace-only input report nothing and mask to the same text', () => {
  for (const text of ['', '\n\n', '   ', '\r\r\r', '{', '}', '"', '=', ':']) {
    assert.deepEqual(mcp.findMcpConfigSecrets(text), [], JSON.stringify(text));
    assert.equal(mcp.maskMcpValues(text, mcp.findMcpConfigSecretSpans(text)), text);
  }
});

test('no options object and an empty file name are the same as no file', () => {
  const text = '{"BRAVE_API_KEY": "' + FAKE + '"}';
  assert.deepEqual(mcp.findMcpConfigSecrets(text), mcp.findMcpConfigSecrets(text, {}));
  assert.deepEqual(mcp.findMcpConfigSecrets(text, { file: '' }), mcp.findMcpConfigSecrets(text));
});

test('a broken JSON comment does not stop the check of the lines after it', () => {
  const text = ['{ /* unterminated', '  "BRAVE_API_KEY": "' + FAKE + '"', '}'].join('\n');
  assert.deepEqual(kinds(text), [[2, 'environment variable', 'BRAVE_API_KEY']]);
});

test('an empty env, null headers and an empty args array hold nothing', () => {
  const text = '{ "s": { "env": {}, "headers": null, "args": [] } }';
  assert.deepEqual(kinds(text), []);
});

test('a credential-looking name with an empty or one-character value is not reported', () => {
  assert.deepEqual(kinds('{"BRAVE_API_KEY": "", "NOTION_TOKEN": "x"}'), []);
});

test('a flag as the last argument with no value is not reported', () => {
  assert.deepEqual(kinds('{"args": ["--api-key"]}'), []);
});

test('a flag followed by a reference is not reported, and the next real value is still found', () => {
  const text = '{"args": ["--token", "${TOKEN}", "--password", "' + FAKE + '"]}';
  assert.deepEqual(kinds(text), [[1, 'argument', 'password']]);
});

test('credentials at any depth keep their own line and name', () => {
  const text = [
    '{',
    '  "a": { "b": { "c": { "d": { "E_TOKEN": "' + FAKE + '" } } } },',
    '  "f": { "g": [ { "H_SECRET": "' + FAKE + '" } ] }',
    '}',
  ].join('\n');
  assert.deepEqual(kinds(text), [[2, 'environment variable', 'E_TOKEN'], [3, 'environment variable', 'H_SECRET']]);
});

test('a credential name written in lower case is a setting, not an environment variable', () => {
  assert.deepEqual(kinds('{"apiKey": "' + FAKE + '"}'), [[1, 'setting', 'apiKey']]);
});

test('masking keeps the text around each value and replaces only the values', () => {
  const text = '{"A_TOKEN": "' + FAKE + '", "B": "keep"}';
  const out = mcp.maskMcpValues(text, mcp.findMcpConfigSecretSpans(text));
  assert.equal(out, '{"A_TOKEN": "[REDACTED_MCP]", "B": "keep"}');
  assert.ok(!out.includes(FAKE));
});

test('masking with overlapping spans replaces each character once', () => {
  const spans = [{ start: 2, end: 6 }, { start: 4, end: 8 }, { start: 2, end: 4 }];
  assert.equal(mcp.maskMcpValues('0123456789', spans), '01[REDACTED_MCP]6789');
});

test('offsets are UTF-16 units: masking is right after an emoji key on the same line', () => {
  const text = '{"\u{1F4C1}": "x", "BRAVE_API_KEY": "' + FAKE + '"}';
  const spans = mcp.findMcpConfigSecretSpans(text);
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), FAKE);
  assert.equal(mcp.maskMcpValues(text, spans), '{"\u{1F4C1}": "x", "BRAVE_API_KEY": "[REDACTED_MCP]"}');
});

test('a Windows CRLF file keeps the same line numbers as the LF file', () => {
  const lf = '{\n"A_TOKEN": "' + FAKE + '",\n"B_TOKEN": "' + FAKE + '"\n}';
  assert.deepEqual(kinds(lf.replace(/\n/g, '\r\n')), kinds(lf));
});

test('Windows paths are MCP configs when built with path.win32 (no host dependency)', () => {
  const home = 'C:\\Users\\Ana María';
  for (const p of [
    path.win32.join(home, '.claude.json'),
    path.win32.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    path.win32.join(home, '.codex', 'config.toml'),
    path.win32.join('D:\\work', '.gemini', 'settings.json'),
  ]) {
    assert.equal(mcp.isMcpConfigPath(p), true, p);
  }
  for (const p of [
    path.win32.join(home, 'mcp.json.bak'),
    path.win32.join(home, '.codex', 'other.toml'),
    path.win32.join(home, 'settings.json'),
    'C:\\',
  ]) {
    assert.equal(mcp.isMcpConfigPath(p), false, p);
  }
});

test('POSIX paths with spaces and non-ASCII names are MCP configs when built with path.posix', () => {
  assert.equal(mcp.isMcpConfigPath(path.posix.join('/home/u', 'proyecto ñandú', '.mcp.json')), true);
  assert.equal(mcp.isMcpConfigPath(path.posix.join('/home/u', '日本', '.codex', 'config.toml')), true);
  assert.equal(mcp.isMcpConfigPath(path.posix.join('/home/u', 'My Dir', 'mcp.json.bak')), false);
});

test('the login key is left alone in a Windows-style ~/.claude.json, and reported elsewhere', () => {
  const text = '{"primaryApiKey": "' + FAKE + '"}';
  const home = path.win32.join('C:\\Users\\Ana María', '.claude.json');
  assert.deepEqual(kinds(text, home), []);
  assert.deepEqual(kinds(text, path.win32.join('C:\\Users\\Ana María', 'settings.json')), [[1, 'setting', 'primaryApiKey']]);
});

test('a credential nested under a secret-named object is reported (known gap)', { todo: 'known gap: a value under a secret-named object key is not reported; no product decision yet' }, () => {
  const text = '{"API_TOKEN": {"value": "' + FAKE + '"}}';
  assert.deepEqual(kinds(text), [[1, 'environment variable', 'API_TOKEN']]);
});
