'use strict';
/*
 * lib/config-parse.js and its callers: a config file that JSON does not accept
 * gets one plain sentence (comments, a byte order mark, or the line of the
 * syntax error), says it was left unchanged, and says what to do. A BOM is
 * kept when zn-gate wraps an MCP config and put back when it writes it.
 * Every path is inside a temporary fake home.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { configParseError, hasComments, errorLine } = require('../lib/config-parse');
const claude = require('../lib/agents/claude-code');
const { configureEnvironments } = require('../lib/init');

// realpath: on macOS os.tmpdir() is under /var, a link to /private/var.
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-parse-msg-')));
const cleanup = [];
process.on('exit', () => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// A fake home folder for the home-scope rules of lib/init.js (it reads HOME / USERPROFILE on each call).
const HOME = tmp();
cleanup.push(HOME);
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const MCP = { mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } };

test('hasComments: finds // and slash-star comments outside strings only', () => {
  assert.equal(hasComments('{\n  // note\n  "a": 1\n}'), true);
  assert.equal(hasComments('{ /* note */ "a": 1 }'), true);
  assert.equal(hasComments('{"url": "https://example.invalid/a/*b"}'), false);
  assert.equal(hasComments('{"a": "quote \\" then // text"}'), false);
  assert.equal(hasComments('{"a": 1}'), false);
});

test('errorLine: uses the line from the message, or the position, or nothing', () => {
  assert.equal(errorLine('', new SyntaxError('Expected , at position 5 (line 7 column 2)')), 7);
  assert.equal(errorLine('a\nb\nc', new SyntaxError('Unexpected token at position 3')), 2);
  assert.equal(errorLine('{}', new SyntaxError('Unexpected token')), null);
});

test('configParseError: a byte order mark is named when the rest is valid JSON', () => {
  const msg = configParseError('/x/claude.json', '﻿{"a":1}', new SyntaxError('Unexpected token'));
  assert.match(msg, /^cannot parse \/x\/claude\.json: the file starts with a byte order mark \(BOM\)/);
  assert.match(msg, /UTF-8 without BOM/);
  assert.doesNotMatch(msg, /comments/);
  assert.match(msg, /\(left unchanged\)$/);
});

test('configParseError: comments are named, with the fix', () => {
  const msg = configParseError('/x/settings.json', '{\n  // zn\n  "a": 1\n}', new SyntaxError('Unexpected token /'));
  assert.match(msg, /^cannot parse \/x\/settings\.json: the file has comments \(JSONC\)/);
  assert.match(msg, /Remove the comments and any trailing commas/);
  assert.match(msg, /add the zn-gate hooks by hand \(see docs\/by-agent\.md\)/);
  assert.match(msg, /\(left unchanged\)$/);
});

test('configParseError: other syntax errors give the line, and the fix can be replaced', () => {
  const text = '{\n  "a": 1\n  "b": 2\n}';
  const msg = configParseError('/x/mcp.json', text, new SyntaxError('Expected , at position 16'));
  assert.match(msg, /is not valid JSON at line 3\. Fix the syntax there/);
  assert.match(msg, /\(left unchanged\)$/);
  const custom = configParseError('/x/mcp.json', text, new SyntaxError('x at position 16'), 'wrap it by hand');
  assert.match(custom, /or wrap it by hand\. \(left unchanged\)$/);
});

test('claude-code install: a settings file with comments is refused with the plain message, unchanged', (t) => {
  const home = tmp();
  cleanup.push(home);
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = '{\n  // my settings\n  "hooks": {}\n}\n';
  fs.writeFileSync(file, text);
  const opts = { home, env: {}, mcp: false, managedDir: path.join(home, 'no-managed-policy') };
  assert.throws(() => claude.install(opts), (err) => /^cannot parse .*settings\.json: the file has comments \(JSONC\)/.test(err.message) && /\(left unchanged\)$/.test(err.message));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('claude-code install: a settings file that starts with a BOM is installed and keeps the BOM', (t) => {
  const home = tmp();
  cleanup.push(home);
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '﻿{\n  "theme": "dark"\n}\n');
  const opts = { home, env: {}, mcp: false, managedDir: path.join(home, 'no-managed-policy') };
  claude.install(opts);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after.charCodeAt(0), 0xFEFF);
  assert.equal(JSON.parse(after.slice(1)).theme, 'dark');
});

test('wrap-mcp: a config with a BOM is wrapped, keeps its BOM, and revert gives back the same bytes', () => {
  const file = path.join(HOME, 'claude-bom.json');
  const original = Buffer.from('﻿' + JSON.stringify(MCP, null, 2) + '\n', 'utf8');
  fs.writeFileSync(file, original);
  const envList = [{ name: 'Claude Code', id: 'claude-code', filePath: file, key: 'mcpServers', format: 'mcpServers-json' }];

  const wrapped = configureEnvironments({ envList });
  assert.equal(wrapped.actions[0].status, 'shielded');
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after.charCodeAt(0), 0xFEFF);
  assert.equal(JSON.parse(after.slice(1)).mcpServers.fetch.command, 'npx');

  const back = configureEnvironments({ envList, revert: true });
  assert.equal(back.actions[0].status, 'reverted');
  assert.deepEqual(fs.readFileSync(file), original);
});

test('wrap-mcp: a config with comments is listed as manual_required with the plain message', () => {
  const file = path.join(HOME, 'claude-jsonc.json');
  const text = '{\n  // servers\n  "mcpServers": {}\n}\n';
  fs.writeFileSync(file, text);
  const envList = [{ name: 'Claude Code', id: 'claude-code', filePath: file, key: 'mcpServers', format: 'mcpServers-json' }];
  const r = configureEnvironments({ envList });
  assert.equal(r.actions[0].status, 'manual_required');
  assert.match(r.actions[0].error, /the file has comments \(JSONC\)/);
  assert.match(r.actions[0].error, /wrap the MCP servers by hand with zn-gate shield \(see docs\/shield\.md\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});
