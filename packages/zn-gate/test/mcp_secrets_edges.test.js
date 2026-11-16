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

test('a credential nested under a secret-named object is reported', () => {
  assert.deepEqual(kinds('{"API_TOKEN": {"value": "' + FAKE + '"}}'), [[1, 'environment variable', 'API_TOKEN']]);
  assert.deepEqual(kinds('{"env": {"DB_PASSWORD": {"default": "' + FAKE + '"}}}'), [[1, 'environment variable', 'DB_PASSWORD']]);
  assert.deepEqual(kinds('env = { API_TOKEN = { value = "' + FAKE + '" } }'), [[1, 'environment variable', 'API_TOKEN']]);
});

test('a nested value is found across lines, masked, and arrays under a secret key are read', () => {
  const text = '{\n "apiKey": {\n  "type": "string",\n  "value": "' + FAKE + '"\n },\n "other": {"value": "' + FAKE + '"}\n}';
  assert.deepEqual(kinds(text), [[4, 'setting', 'apiKey']]);
  assert.equal(mcp.maskMcpValues(text, mcp.findMcpConfigSecretSpans(text)).split(FAKE).length - 1, 1);
  assert.deepEqual(kinds('{"A_TOKEN": ["' + FAKE + '"], "B_TOKEN": ["--x", "' + FAKE + '"]}').map((k) => k[2]), ['A_TOKEN', 'B_TOKEN']);
});

test('references, placeholders, empty values and other keys are not reported under a secret key', () => {
  for (const v of ['${API_TOKEN}', '<key>', 'YOUR_KEY', '__ZN_API_TOKEN__', '$API_TOKEN', '', 'true']) {
    assert.deepEqual(kinds('{"API_TOKEN": {"value": "' + v + '", "default": "' + v + '"}}'), [], v);
  }
  assert.deepEqual(kinds('{"auth": {"client_id": "' + FAKE + '", "type": "oauth"}}'), []);
  assert.deepEqual(kinds('{"API_TOKEN": {"description": "' + FAKE + '"}}'), []);
  assert.deepEqual(kinds('{"API_TOKEN": {"a": {"b": ["' + FAKE + '"]}}, "LOG": {"value": "' + FAKE + '"}}'), []);
  assert.deepEqual(kinds('{"auth": {"scopes": [["read", "write"]], "type": "oauth"}}'), []);
  assert.deepEqual(kinds('{"API_TOKEN": ' + '['.repeat(100) + '"${API_TOKEN}", "<key>"' + ']'.repeat(100) + '}'), []);
  for (const t of ['{"API_TOKEN": {"value": ', '{"API_TOKEN": [[[[[[[[[[["' + FAKE + '"']) mcp.findMcpConfigSecrets(t);
});

test('offsets count UTF-16 code units, so an emoji before a credential counts as two', () => {
  const text = '{"\u{1F4C1}": "x", "BRAVE_API_KEY": "' + FAKE + '"}';
  const [sp] = mcp.findMcpConfigSecretSpans(text);
  assert.equal(text.slice(sp.start, sp.end), FAKE);
});


test('an argument longer than 4096 characters is still checked', () => {
  const long = 'sk-test-FAKE' + FAKE.repeat(400);
  const flag = '{"args": ["--api-key=' + long + '"]}';
  assert.deepEqual(kinds(flag), [[1, 'argument', 'api-key']]);
  const [sp] = mcp.findMcpConfigSecretSpans(flag);
  assert.equal(flag.slice(sp.start, sp.end), long);
  for (const arg of ['Authorization: Bearer ' + long, '--header=Authorization: Bearer ' + long, 'X-Api-Key: ' + long]) {
    const text = '{"args": ["' + arg + '"]}';
    assert.deepEqual(kinds(text).map((k) => k[1]), ['header'], arg.slice(0, 30));
    assert.ok(!mcp.maskMcpValues(text, mcp.findMcpConfigSecretSpans(text)).includes(FAKE));
  }
  for (const arg of ['--verbose=' + 'x'.repeat(6000), '--name=' + 'word '.repeat(2000), 'Authorization: ${TOKEN}' + ' '.repeat(6000), 'a'.repeat(9000)]) {
    assert.deepEqual(kinds('{"args": ["' + arg + '"]}'), [], arg.slice(0, 20));
  }
});

test('crafted arguments of 200k characters finish in under a second', () => {
  const n = 200000;
  const args = {
    'flag value': '--api-key=' + 'a'.repeat(n),
    'flag then equals': '--x' + '='.repeat(n),
    dashes: '--' + '-'.repeat(n),
    'spaces after header name': 'authorization' + ' '.repeat(n) + 'x',
    colons: 'cookie:' + ' :'.repeat(n / 2),
    'tabs after colon': 'x-api-key:' + '\t'.repeat(n),
    'url params': 'https://h.example.com/?' + '&token='.repeat(Math.floor(n / 7)),
  };
  for (const [name, arg] of Object.entries(args)) {
    const text = JSON.stringify({ args: [arg] });
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      mcp.findMcpConfigSecretSpans(text);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e9);
    }
    assert.ok(best < 1, `${name}: ${best.toFixed(3)} s`);
  }
});

test('deep objects, long blocks and arrays of arrays under a secret key are followed to their end', () => {
  const deep = '{"API_TOKEN": ' + '{"x": '.repeat(10) + '{"value": "' + FAKE + '"}' + '}'.repeat(11);
  assert.deepEqual(kinds(deep), [[1, 'environment variable', 'API_TOKEN']]);
  assert.deepEqual(kinds('{"API_TOKEN": {' + '\n'.repeat(300) + '"value": "' + FAKE + '"\n}}'), [[301, 'environment variable', 'API_TOKEN']]);
  const lines = ['{"api_key": {'];
  for (let i = 0; i < 500; i++) lines.push(`  "note${i}": "text",`);
  lines.push('  "value": "' + FAKE + '"', '}}');
  assert.deepEqual(kinds(lines.join('\n')), [[502, 'setting', 'api_key']]);
  assert.deepEqual(kinds('{"api_key": [["' + FAKE + '"]]}'), [[1, 'setting', 'api_key']]);
  assert.deepEqual(kinds('{"api_key": [[["name", "' + FAKE + '"]]]}'), [[1, 'setting', 'api_key']]);
  assert.deepEqual(kinds('{"api_key": [\n [\n  "' + FAKE + '"\n ]\n]}'), [[3, 'setting', 'api_key']]);
  for (const text of [
    '{"API_TOKEN": ' + '['.repeat(100) + '"' + FAKE + '"' + ']'.repeat(100) + '}',
    '{"API_TOKEN": ' + '{"x": '.repeat(100) + '"' + FAKE + '"' + '}'.repeat(100) + '}',
    '{"API_TOKEN": {"a": ' + '['.repeat(100) + ']'.repeat(100) + ', "value": "' + FAKE + '"}}',
  ]) {
    assert.deepEqual(kinds(text), [[1, 'environment variable', 'API_TOKEN']], text.slice(0, 40));
    assert.ok(!mcp.maskMcpValues(text, mcp.findMcpConfigSecretSpans(text)).includes(FAKE));
  }
  assert.deepEqual(kinds('{"API_TOKEN": {"value": "${A}"}}\n{"other": {"value": "' + FAKE + '"}}'), []);
  for (const t of ['{"API_TOKEN": ' + ']}'.repeat(50), '{"API_TOKEN": ' + '['.repeat(100) + ']'.repeat(200) + '"' + FAKE + '"']) mcp.findMcpConfigSecrets(t);
});

test('crafted nesting under a secret key finishes in under a second', () => {
  const cases = {
    '200k open brackets': '{"API_TOKEN": ' + '['.repeat(200000),
    '200k open braces': '{"API_TOKEN": ' + '{"x":'.repeat(40000),
    'open and close': '{"API_TOKEN": ' + '[]'.repeat(100000) + '}',
    '20k lines in a block': '{"API_TOKEN": {\n' + '"a": [["x"]],\n'.repeat(20000) + '}}',
    'deep strings': '{"API_TOKEN": ' + '['.repeat(100) + '"a",'.repeat(40000),
  };
  for (const [name, text] of Object.entries(cases)) {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      mcp.findMcpConfigSecretSpans(text);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e9);
    }
    assert.ok(best < 1, `${name}: ${best.toFixed(3)} s`);
  }
});
