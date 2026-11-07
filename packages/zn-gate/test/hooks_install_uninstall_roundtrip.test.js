'use strict';
/*
 * Install then uninstall, for every adapter in lib/agents/index.js, over a machine that already holds
 * the user's own hooks: the user's config must come back byte for byte (same key order, indent, line
 * endings, BOM, final newline), for the user install and the project install. Also: installing twice
 * and uninstalling once leaves no zn entry; uninstalling with nothing installed changes nothing.
 *
 * Config files are strict JSON (they are read with JSON.parse and written back in the style they were
 * read in), so a file with comments cannot be edited: the install refuses it and leaves it unchanged.
 * That is asserted below instead of byte-identity through a rewrite.
 * Every path is inside temporary folders; no real user config is read.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter, AGENT_IDS } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const USER_CMD = 'echo example-user-hook';

const grp = (extra = {}) => ({ matcher: 'Bash', hooks: [{ type: 'command', command: USER_CMD }], ...extra });

// The user's own config for each agent: their hooks (in events zn also uses and in others it does not),
// settings that have nothing to do with hooks before and after "hooks", and keys in no particular order.
const DOCS = {
  'claude-code': () => ({ zeta: { b: 1, a: [3, 2, 1] }, hooks: { Notification: [grp()], PreToolUse: [grp()], Stop: [{ hooks: [{ type: 'command', command: USER_CMD }] }] }, theme: 'example-theme', alpha: null }),
  codex: () => ({ zeta: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: USER_CMD }] }], PreToolUse: [grp()] }, alpha: 'x' }),
  cursor: () => ({ extra: 1, version: 1, hooks: { afterFileEdit: [{ command: USER_CMD }], beforeShellExecution: [{ command: USER_CMD, timeout: 5 }] }, zeta: [] }),
  antigravity: () => ({ 'my-hooks': { enabled: true, PreToolUse: [grp({ matcher: '*' })] }, zeta: 1 }),
  copilot: () => ({ extra: 1, version: 1, hooks: { sessionStart: [{ type: 'command', bash: USER_CMD }], preToolUse: [{ type: 'command', bash: USER_CMD, timeoutSec: 5 }] }, zeta: 'z' }),
  gemini: () => ({ zeta: 1, hooks: { AfterTool: [grp()], BeforeTool: [{ hooks: [{ name: 'mine', type: 'command', command: USER_CMD }] }] }, theme: 'example-theme' }),
  zcode: () => ({ zeta: 1, hooks: { events: { Notification: [{ hooks: [{ type: 'process', command: 'echo', args: ['example-user-hook'] }] }], PreToolUse: [{ hooks: [{ type: 'process', command: 'echo', args: ['x'] }] }] } }, alpha: { x: 1 } }),
};

// How the same data is written on disk by different editors.
const STYLES = {
  'two spaces, LF, final newline': (d) => JSON.stringify(d, null, 2) + '\n',
  'four spaces, CRLF, final newline': (d) => JSON.stringify(d, null, 4).replace(/\n/g, '\r\n') + '\r\n',
  'tabs, LF, no final newline': (d) => JSON.stringify(d, null, '\t'),
  'two spaces, CRLF, BOM, no final newline': (d) => '﻿' + JSON.stringify(d, null, 2).replace(/\n/g, '\r\n'),
};

function machine(t) {
  const home = tempDir(t, 'zn-rt-home-');
  const cwd = tempDir(t, 'zn-rt-cwd-');
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: '' } };
}

function call(m, id, fn, scope, extra = {}) {
  return getAdapter(id)[fn]({ scope, projectDir: m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false, ...extra });
}

// Where the agent's file is: found by installing in a scratch machine (the adapters know their own paths).
function target(t, id, scope) {
  const probe = machine(t);
  const file = call(probe, id, 'install', scope).settings;
  return path.relative(scope === 'project' ? probe.cwd : probe.home, file);
}

// Every file under home and cwd except zn's own folder and the timestamped backups an edit leaves next to a file.
function snapshot(m) {
  const out = {};
  const walk = (root, tag, dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (rel === '.zn' || /\.bak-zn-/.test(e.name)) continue;
      if (e.isDirectory()) walk(root, tag, p);
      else out[tag + '/' + rel.split(path.sep).join('/')] = fs.readFileSync(p).toString('latin1');
    }
  };
  walk(m.home, 'home', m.home);
  walk(m.cwd, 'cwd', m.cwd);
  return out;
}

function seed(m, scope, rel, text) {
  const file = path.join(scope === 'project' ? m.cwd : m.home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

for (const id of AGENT_IDS) {
  if (id === 'opencode') continue; // no JSON file to edit: covered below
  for (const scope of ['user', 'project']) {
    if (id === 'zcode' && scope === 'project') continue; // ZCode ignores project hooks: asserted below
    for (const [styleName, render] of Object.entries(STYLES)) {
      const label = id + ' ' + scope + ' [' + styleName + ']';

      test('roundtrip: ' + label + ': install then uninstall restores the user\'s file byte for byte', (t) => {
        const m = machine(t);
        const original = render(DOCS[id]());
        const file = seed(m, scope, target(t, id, scope), original);
        const before = snapshot(m);
        const rep = call(m, id, 'install', scope);
        assert.equal(rep.settings, file);
        assert.notEqual(fs.readFileSync(file, 'utf8'), original, 'the install changed the file');
        assert.match(fs.readFileSync(file, 'utf8'), /example-user-hook/, 'the user\'s hook is still there');
        call(m, id, 'uninstall', scope);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
        assert.deepEqual(snapshot(m), before);
      });

      test('roundtrip: ' + label + ': install twice, uninstall once leaves no zn entry', (t) => {
        const m = machine(t);
        const original = render(DOCS[id]());
        const file = seed(m, scope, target(t, id, scope), original);
        const before = snapshot(m);
        call(m, id, 'install', scope);
        call(m, id, 'install', scope);
        call(m, id, 'uninstall', scope);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
        assert.deepEqual(snapshot(m), before);
      });

      test('roundtrip: ' + label + ': uninstall with nothing installed changes nothing', (t) => {
        const m = machine(t);
        seed(m, scope, target(t, id, scope), render(DOCS[id]()));
        const before = snapshot(m);
        const rep = call(m, id, 'uninstall', scope);
        assert.equal(rep.removed, 0);
        assert.deepEqual(snapshot(m), before);
      });
    }

    test('roundtrip: ' + id + ' ' + scope + ': uninstall with no config at all creates nothing', (t) => {
      const m = machine(t);
      const before = snapshot(m);
      call(m, id, 'uninstall', scope);
      assert.deepEqual(snapshot(m), before);
    });

    test('roundtrip: ' + id + ' ' + scope + ': a config with comments is refused and left unchanged', (t) => {
      const m = machine(t);
      const commented = '// my own notes\n' + JSON.stringify(DOCS[id](), null, 2) + '\n';
      const file = seed(m, scope, target(t, id, scope), commented);
      const before = snapshot(m);
      assert.throws(() => call(m, id, 'install', scope), /left unchanged|cannot parse/);
      assert.deepEqual(snapshot(m), before);
      assert.equal(fs.readFileSync(file, 'utf8'), commented);
    });
  }
}

test('roundtrip: zcode refuses a project install and changes nothing', (t) => {
  const m = machine(t);
  const before = snapshot(m);
  assert.throws(() => call(m, 'zcode', 'install', 'project'), /project/);
  call(m, 'zcode', 'uninstall', 'project');
  assert.deepEqual(snapshot(m), before);
});

// OpenCode keeps no hooks in a JSON file: zn writes its own plugin file next to the user's plugins and config.
for (const scope of ['user', 'project']) {
  test('roundtrip: opencode ' + scope + ': the user\'s plugins and config are untouched; their own zn-gate.js is refused', (t) => {
    const m = machine(t);
    const rel = target(t, 'opencode', scope);
    const cfgRel = scope === 'project' ? 'opencode.json' : path.join('.config', 'opencode', 'opencode.json');
    seed(m, scope, path.join(path.dirname(rel), 'my-plugin.js'), '// mine\r\nexport default {};\r\n');
    seed(m, scope, cfgRel, '{\r\n  // comments are fine here: zn never reads this file\r\n  "theme": "example-theme",\r\n}\r\n');
    const before = snapshot(m);
    call(m, 'opencode', 'install', scope);
    call(m, 'opencode', 'install', scope);
    call(m, 'opencode', 'uninstall', scope);
    assert.deepEqual(snapshot(m), before);
    // A file of that name that zn did not write is never overwritten or deleted.
    const own = seed(m, scope, rel, '// the user\'s own plugin\n');
    assert.throws(() => call(m, 'opencode', 'install', scope), /not written by zn/);
    call(m, 'opencode', 'uninstall', scope);
    assert.equal(fs.readFileSync(own, 'utf8'), '// the user\'s own plugin\n');
  });
}

// A user's empty "hooks" container: an uninstall cannot tell it from a "hooks" object that the install created, and
// removes it (the common case, a file with no "hooks" at all, must come back without one). So this is the one case
// compared by meaning, not by bytes: the same data and no zn entry.
for (const id of ['claude-code', 'codex', 'gemini', 'cursor', 'copilot', 'zcode']) {
  test('roundtrip: ' + id + ': a user\'s empty "hooks" object comes back equal in meaning (other settings intact)', (t) => {
    const m = machine(t);
    const versioned = id === 'cursor' || id === 'copilot';
    const doc = versioned ? { version: 1, hooks: {}, theme: 'x' } : { hooks: {}, theme: 'x' };
    const original = JSON.stringify(doc, null, 2) + '\n';
    const file = seed(m, 'user', target(t, id, 'user'), original);
    call(m, id, 'install', 'user');
    call(m, id, 'uninstall', 'user');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (after.hooks !== undefined) assert.deepEqual(after.hooks, {});
    delete after.hooks;
    const expected = { ...doc };
    delete expected.hooks;
    assert.deepEqual(after, expected);
  });
}
