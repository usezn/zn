'use strict';
/*
 * Install and uninstall keep the line endings, the indentation and the byte order mark of the agent config
 * files they edit. Every path is inside a temporary fake home.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const cfg = require('../lib/agents/config-file');
const claude = require('../lib/agents/claude-code');
const cursor = require('../lib/agents/cursor');
const { dispatch } = require('../lib/broker/cli');
const { check } = require('../lib/check');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function opts(home, extra = {}) {
  return { home, env: {}, mcp: false, managedDir: path.join(home, 'no-managed-policy'), ...extra };
}

function put(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

const OTHER = { theme: 'dark', permissions: { allow: ['Bash(ls)'] }, big: 1.5 };

function render(obj, { eol = '\n', indent = 2, bom = false, final = true } = {}) {
  let s = JSON.stringify(obj, null, indent).replace(/\n/g, eol);
  if (final) s += eol;
  return (bom ? '\uFEFF' : '') + s;
}

const STYLES = {
  'CRLF + 4 spaces': { eol: '\r\n', indent: 4 },
  'tabs': { indent: '\t' },
  'BOM + LF': { bom: true },
  'BOM + CRLF + tabs, no final newline': { bom: true, eol: '\r\n', indent: '\t', final: false },
  'LF + 2 spaces': {},
};

for (const [name, style] of Object.entries(STYLES)) {
  test('claude-code: install keeps ' + name + ' and uninstall restores the original bytes', (t) => {
    const home = tempDir(t, 'zn-keepfmt-');
    const file = path.join(home, '.claude', 'settings.json');
    const original = render(OTHER, style);
    put(file, original);
    claude.install(opts(home, { command: 'zn hook claude-code' }));
    const installed = fs.readFileSync(file, 'utf8');
    assert.notEqual(installed, original);
    const body = installed.replace(/^\uFEFF/, '');
    assert.equal(installed.startsWith('\uFEFF'), !!style.bom);
    if ((style.eol || '\n') === '\r\n') assert.ok(!/(?<!\r)\n/.test(body), 'only CRLF line breaks');
    else assert.ok(!body.includes('\r'));
    const lines = body.split(/\r?\n/);
    const indented = lines.find((l) => /^\s+"/.test(l));
    const want = style.indent === '\t' ? '\t' : ' '.repeat(style.indent || 2);
    assert.ok(indented.startsWith(want + '"'), 'indentation kept');
    assert.equal(body.endsWith('\n'), style.final !== false);
    assert.ok(JSON.parse(body).hooks.PreToolUse);
    assert.equal(JSON.parse(body).theme, 'dark');
    claude.uninstall(opts(home));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
}

test('claude-code: a project .mcp.json keeps CRLF and its indentation', (t) => {
  // A project install adds no MCP server; it only removes the bare `zn secrets-mcp` a release candidate wrote.
  const home = tempDir(t, 'zn-keepfmt-');
  const proj = path.join(home, 'proj');
  const file = path.join(proj, '.mcp.json');
  const fmt = { eol: '\r\n', indent: 4 };
  const bare = { command: 'zn', args: ['secrets-mcp', '--agent', 'claude-code'] };
  put(file, render({ mcpServers: { other: { command: 'x' }, secrets: bare } }, fmt));
  claude.install(opts(home, { scope: 'project', projectDir: proj, mcp: true, znBin: '/usr/bin/zn', command: 'zn hook claude-code' }));
  const cleaned = render({ mcpServers: { other: { command: 'x' } } }, fmt);
  assert.equal(fs.readFileSync(file, 'utf8'), cleaned);
  claude.uninstall(opts(home, { scope: 'project', projectDir: proj, mcp: true }));
  assert.equal(fs.readFileSync(file, 'utf8'), cleaned);
});

test('cursor: hooks.json keeps CRLF, tabs and a BOM, and uninstall restores the original bytes', (t) => {
  const home = tempDir(t, 'zn-keepfmt-');
  const file = path.join(home, '.cursor', 'hooks.json');
  const original = render({ version: 1, hooks: { stop: [{ command: 'echo done' }] } }, { eol: '\r\n', indent: '\t', bom: true });
  put(file, original);
  cursor.install(opts(home));
  const installed = fs.readFileSync(file, 'utf8');
  assert.ok(installed.startsWith('\uFEFF{\r\n\t"'));
  assert.ok(!/(?<!\r)\n/.test(installed));
  // The hook command differs per platform (an encoded PowerShell command on Windows), so check the parsed entries.
  const entries = JSON.parse(installed.slice(1)).hooks.preToolUse;
  assert.ok(entries.some((e) => cfg.isOurs(e.command, 'cursor')));
  cursor.uninstall(opts(home));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('a new config file is written the usual way: LF, two spaces, a final newline, no BOM', (t) => {
  const home = tempDir(t, 'zn-keepfmt-');
  claude.install(opts(home, { command: 'zn hook claude-code' }));
  cursor.install(opts(home));
  for (const f of [path.join(home, '.claude', 'settings.json'), path.join(home, '.cursor', 'hooks.json')]) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!s.includes('\r') && !s.startsWith('\uFEFF') && s.endsWith('}\n') && /\n  "/.test(s));
  }
});

test('config-file: a one-line file is written out the usual way and the BOM is still kept', () => {
  const data = cfg.parseJson('\uFEFF{"a":1}');
  assert.equal(cfg.stringifyJson(data), '\uFEFF{\n  "a": 1\n}\n');
  assert.equal(cfg.detectStyle('{\n\t"a": 1\n}').indent, '\t');
});

test('config-file: writeJson keeps the style of what readJson read, through a symlink too', (t) => {
  const home = tempDir(t, 'zn-keepfmt-');
  const real = path.join(home, 'real.json');
  const link = path.join(home, 'link.json');
  put(real, render({ a: 1 }, { eol: '\r\n', indent: 4, bom: true }));
  try { fs.symlinkSync(real, link); } catch (_) { return; }
  const data = cfg.readJson(link);
  data.b = 2;
  cfg.writeJson(link, data);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, 'utf8'), '\uFEFF{\r\n    "a": 1,\r\n    "b": 2\r\n}\r\n');
});

test('check: a settings.json with a BOM that install kept is still read, so zn check reports the hook', async (t) => {
  const home = tempDir(t, 'zn-keepfmt-');
  const file = path.join(home, '.claude', 'settings.json');
  put(file, render(OTHER, { eol: '\r\n', bom: true }));
  claude.install(opts(home, { env: { HOME: home }, nodePath: process.execPath, runnerPath: RUNNER }));
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('\uFEFF'));
  const res = await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-keepfmt-cwd-'), nodeVersion: '22.0.0' });
  const r = res.results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
});

test('uninstall: zn hooks in a project settings.json with a BOM are found and removed', async (t) => {
  const home = tempDir(t, 'zn-keepfmt-');
  const proj = tempDir(t, 'zn-keepfmt-proj-');
  const file = path.join(proj, '.claude', 'settings.json');
  const original = render(OTHER, { eol: '\r\n', bom: true });
  put(file, original);
  const env = { HOME: home, USERPROFILE: home, PATH: '' };
  claude.install({ scope: 'project', projectDir: proj, home, env, command: 'zn hook claude-code', mcp: false, managedDir: path.join(home, 'no-managed-policy') });
  assert.ok(/zn hook claude-code/.test(fs.readFileSync(file, 'utf8')));
  let out = '';
  const o = {
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { out += s; } }, stdin: { isTTY: true },
    env, home, cwd: proj, human: true, claude: null, ancestry: () => null, envList: [], confirm: async () => true,
  };
  assert.equal(await dispatch('uninstall', [], o), 0, out);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
