'use strict';
/*
 * How `zn hooks install` and `zn hooks uninstall` write an agent's settings file: backups that never
 * overwrite each other and do not pile up, no lost update when another program writes at the same time,
 * the file's mode, indentation and BOM kept, malformed files refused before anything is written, and
 * clear errors. Every path is inside a temporary fake home; the content is fictitious.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const cfg = require('../lib/agents/config-file');
const claude = require('../lib/agents/claude-code');
const codex = require('../lib/agents/codex');
const cursor = require('../lib/agents/cursor');
const gemini = require('../lib/agents/gemini');
const { dispatch } = require('../lib/broker/cli');

const posix = process.platform !== 'win32';
const notRoot = posix && typeof process.getuid === 'function' && process.getuid() !== 0;

function opts(home, extra = {}) {
  return { home, env: {}, mcp: false, managedDir: path.join(home, 'no-managed-policy'), ...extra };
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const text = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(text(file));
const backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.bak-zn-')).sort();
const settingsOf = (home) => claude.settingsFile(opts(home));
const launcherOf = (home) => path.join(home, '.zn', 'hooks', 'zn-hook-claude-code.sh');
// A plain command that differs on every call, so each install changes the file.
const variant = (i) => ({ command: '/v' + i + '/zn hook claude-code' });

/* ------------------------------- B-747: backups ------------------------------- */

test('backups made in the same second never overwrite each other, so the original survives', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = path.join(h, 'a.json');
  write(file, '{"v":"original"}\n');
  const first = cfg.backup(file);
  write(file, '{"v":"second"}\n');
  const second = cfg.backup(file);
  write(file, '{"v":"third"}\n');
  const third = cfg.backup(file);
  assert.equal(new Set([first, second, third]).size, 3);
  assert.equal(text(first), '{"v":"original"}\n');
  assert.equal(text(second), '{"v":"second"}\n');
  assert.equal(text(third), '{"v":"third"}\n');
});

test('install then uninstall within a second keeps the backup of the original file', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  const original = '{\n  "theme": "dark"\n}\n';
  write(file, original);
  claude.install(opts(h));
  claude.uninstall(opts(h));
  assert.ok(backups(file).some((b) => text(path.join(path.dirname(file), b)) === original), 'the original content is still saved');
});

test('installing again with nothing to change writes no file and no backup', (t) => {
  const h = tempDir(t, 'zn-ws-');
  for (const [name, adapter] of [['claude-code', claude], ['codex', codex], ['cursor', cursor], ['gemini', gemini]]) {
    const o = opts(path.join(h, name));
    const file = adapter.hooksFile ? adapter.hooksFile(o) : adapter.settingsFile(o);
    write(file, '{"theme":"dark"}\n');
    adapter.install(o);
    const after = text(file);
    const stat = fs.statSync(file);
    for (let i = 0; i < 20; i++) {
      const r = adapter.install(o);
      assert.equal(r.backup, null, name);
    }
    assert.equal(text(file), after, name);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs, name + ': not rewritten');
    assert.equal(backups(file).length, 1, name + ': only the backup of the original');
  }
});

test('backups are pruned: the original and the newest few stay', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  const original = '{"theme":"dark"}\n';
  write(file, original);
  for (let i = 0; i < 14; i++) claude.install(opts(h, variant(i)));
  const kept = backups(file);
  assert.ok(kept.length <= cfg.KEEP_BACKUPS + 1, 'at most ' + (cfg.KEEP_BACKUPS + 1) + ' backups, got ' + kept.length);
  assert.ok(kept.length > 1);
  assert.equal(text(path.join(path.dirname(file), kept[0])), original, 'the oldest backup is the original');
});

/* ------------------------------- B-748: concurrent writer ------------------------------- */

/* Runs fn with fs.readFileSync wrapped: after zn reads `file`, onRead(n) may change it, as another program would. */
function withRacingWriter(file, onRead, fn) {
  const real = fs.readFileSync;
  let n = 0;
  fs.readFileSync = function (p, ...rest) {
    const out = real.call(this, p, ...rest);
    if (p === file && typeof rest[0] === 'string') {
      n++;
      onRead(n);
    }
    return out;
  };
  try { return fn(); } finally { fs.readFileSync = real; }
}

test('a key another program writes while zn is installing is not lost', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '{"theme":"dark"}\n');
  withRacingWriter(file, (n) => {
    if (n === 1) fs.writeFileSync(file, '{"theme":"dark","editor":"vim"}\n');
  }, () => claude.install(opts(h)));
  const data = json(file);
  assert.equal(data.editor, 'vim', 'the other writer\'s key survives');
  assert.ok(data.hooks && data.hooks.PreToolUse, 'zn\'s hooks are there');
});

test('a file that keeps changing is refused and left as the other program wrote it', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '{"theme":"dark"}\n');
  let last;
  assert.throws(() => withRacingWriter(file, (n) => {
    last = '{"theme":"dark","counter":' + n + '}\n';
    fs.writeFileSync(file, last);
  }, () => claude.install(opts(h))), /kept changing.*left unchanged/);
  assert.equal(text(file), last);
  assert.equal(json(file).hooks, undefined);
});

/* ------------------------------- B-749: file mode ------------------------------- */

test('the mode of the settings file is kept', { skip: !posix }, (t) => {
  const h = tempDir(t, 'zn-ws-');
  for (const mode of [0o600, 0o664]) {
    const file = settingsOf(path.join(h, String(mode)));
    write(file, '{"theme":"dark"}\n');
    fs.chmodSync(file, mode);
    claude.install(opts(path.join(h, String(mode))));
    assert.equal(fs.statSync(file).mode & 0o777, mode);
    claude.uninstall(opts(path.join(h, String(mode))));
    assert.equal(fs.statSync(file).mode & 0o777, mode);
  }
});

test('a read-only settings file is refused, not replaced', { skip: !notRoot }, (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '{"theme":"dark"}\n');
  fs.chmodSync(file, 0o444);
  assert.throws(() => claude.install(opts(h)), /read-only.*left unchanged/);
  assert.equal(text(file), '{"theme":"dark"}\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  assert.equal(backups(file).length, 0);
});

/* ------------------------------- B-750: validate first ------------------------------- */

test('a "hooks" string is refused before any backup or launcher is written', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '{"hooks":"nope"}\n');
  assert.throws(() => claude.install(opts(h)), /"hooks".*must be an object.*left unchanged/);
  assert.equal(text(file), '{"hooks":"nope"}\n');
  assert.equal(backups(file).length, 0, 'no backup left behind');
  assert.equal(fs.existsSync(launcherOf(h)), false, 'no launcher left behind');
});

test('a hooks event that is not a list is refused with the file untouched', (t) => {
  const h = tempDir(t, 'zn-ws-');
  for (const [i, bad] of ['{"a":1}', '"text"', 'null', '7'].entries()) {
    const home = path.join(h, String(i));
    const file = settingsOf(home);
    const body = '{"hooks":{"PreToolUse":' + bad + '}}\n';
    write(file, body);
    assert.throws(() => claude.install(opts(home)), /"hooks\.PreToolUse".*must be a list.*left unchanged/, bad);
    assert.equal(text(file), body);
    assert.equal(backups(file).length, 0);
  }
});

test('codex and cursor refuse a hooks event that is not a list too', (t) => {
  const h = tempDir(t, 'zn-ws-');
  for (const [adapter, event] of [[codex, 'PreToolUse'], [cursor, 'preToolUse']]) {
    const o = opts(path.join(h, adapter.id));
    const file = adapter.hooksFile(o);
    const body = '{"hooks":{"' + event + '":{"x":1}}}\n';
    write(file, body);
    assert.throws(() => adapter.install(o), /must be a list.*left unchanged/);
    assert.equal(text(file), body);
  }
});

test('uninstall leaves a hooks event that is not a list alone', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  const body = '{"hooks":{"Notification":"keep me"}}\n';
  write(file, body);
  const r = claude.uninstall(opts(h));
  assert.equal(r.removed, 0);
  assert.equal(text(file), body);
});

/* ------------------------------- B-751: clearer behaviour ------------------------------- */

test('a read-only folder gives a clear error, not a raw EACCES', { skip: !notRoot }, (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '{"theme":"dark"}\n');
  fs.chmodSync(path.dirname(file), 0o555);
  try {
    assert.throws(() => claude.install(opts(h)), (err) => /permission denied/.test(err.message) && /left unchanged/.test(err.message) && !/copyfile|open '/.test(err.message));
    assert.equal(text(file), '{"theme":"dark"}\n');
  } finally {
    fs.chmodSync(path.dirname(file), 0o755);
  }
});

test('a failed install does not leave its launcher behind, and keeps one that was already there', { skip: !notRoot }, (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.chmodSync(path.dirname(file), 0o555);
  try {
    assert.throws(() => claude.install(opts(h)), /permission denied/);
    assert.equal(fs.existsSync(launcherOf(h)), false, 'created by the failed install: removed');
    fs.mkdirSync(path.dirname(launcherOf(h)), { recursive: true });
    fs.writeFileSync(launcherOf(h), '#!/bin/sh\n# earlier install\n');
    assert.throws(() => claude.install(opts(h)), /permission denied/);
    assert.equal(fs.existsSync(launcherOf(h)), true, 'a launcher that was already there is not removed');
  } finally {
    fs.chmodSync(path.dirname(file), 0o755);
  }
});

test('a UTF-8 BOM is accepted and kept', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '﻿{"theme":"dark"}\n');
  claude.install(opts(h));
  assert.equal(text(file).charCodeAt(0), 0xFEFF);
  assert.equal(JSON.parse(text(file).slice(1)).theme, 'dark');
  assert.ok(JSON.parse(text(file).slice(1)).hooks.PreToolUse);
  assert.equal(cfg.readJson(file).theme, 'dark');
});

test('the Claude Code parse error says the file is left unchanged', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '{ "hooks": ');
  assert.throws(() => claude.install(opts(h)), /cannot parse .*\(left unchanged\)/);
  assert.throws(() => claude.uninstall(opts(h)), /cannot parse .*\(left unchanged\)/);
  assert.equal(text(file), '{ "hooks": ');
});

test('uninstall says when nothing was installed', async (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  write(file, '{"theme":"dark"}\n');
  const run = async (args) => {
    let out = '';
    const stdout = { write: (s) => { out += s; return true; } };
    const code = await dispatch('hooks', args, { human: true, home: h, env: {}, cwd: h, stdout, stderr: { write() { return true; } } });
    return { code, out };
  };
  let r = await run(['uninstall', 'claude-code', '--no-mcp']);
  assert.equal(r.code, 0);
  assert.match(r.out, /No zn hooks were installed for claude-code/);
  assert.doesNotMatch(r.out, /Removed zn hooks/);
  assert.equal(text(file), '{"theme":"dark"}\n');
  await run(['install', 'claude-code', '--no-mcp']);
  r = await run(['uninstall', 'claude-code', '--no-mcp']);
  assert.match(r.out, /Removed zn hooks for claude-code/);
});

test('install and uninstall keep the indentation, line endings and final newline of the file', (t) => {
  const h = tempDir(t, 'zn-ws-');
  const cases = [
    ['four', '{\n    "theme": "dark"\n}\n', '    '],
    ['tab', '{\n\t"theme": "dark"\n}\n', '\t'],
    ['two-nonl', '{\n  "theme": "dark"\n}', '  '],
  ];
  for (const [name, body, indent] of cases) {
    const home = path.join(h, name);
    const file = settingsOf(home);
    write(file, body);
    claude.install(opts(home));
    assert.ok(text(file).includes('\n' + indent + '"theme"'), name + ' install');
    claude.uninstall(opts(home));
    assert.equal(text(file), body, name + ' uninstall gives the file back as it was');
  }
  const home = path.join(h, 'crlf');
  const file = settingsOf(home);
  write(file, '{\r\n  "theme": "dark"\r\n}\r\n');
  claude.install(opts(home));
  assert.equal(text(file).replace(/\r\n/g, '').includes('\n'), false, 'every line ends with CRLF');
  claude.uninstall(opts(home));
  assert.equal(text(file), '{\r\n  "theme": "dark"\r\n}\r\n');
});

test('a symlinked settings file is written through: the link stays, the backup sits next to the target', { skip: !posix }, (t) => {
  const h = tempDir(t, 'zn-ws-');
  const file = settingsOf(h);
  const real = path.join(h, 'dotfiles', 'claude-settings.json');
  write(real, '{"theme":"dark"}\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(real, file);
  claude.install(opts(h));
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'still a link');
  assert.ok(json(real).hooks.PreToolUse, 'the target holds the hooks');
  assert.equal(backups(file).length, 0, 'no backup next to the link');
  assert.equal(backups(real).length, 1, 'backup next to the target');
  claude.uninstall(opts(h));
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.equal(json(real).hooks, undefined);
});
