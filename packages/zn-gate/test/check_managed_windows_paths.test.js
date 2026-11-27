'use strict';

// zn-gate check reads the managed files at the per-OS system paths for Windows too (Cursor and Codex: the
// ProgramData folder). The platform is simulated through the injected `platform` and `ProgramData`, so no test
// reads a real system folder, and a managed file that turns hooks off is a finding, not a "protected".

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { managedInstall } = require('../lib/agents/managed-policy');
const { check: realCheck } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const check = (opts) => realCheck({ nodeVersion: '22.0.0', live: false, ...opts });
const FIX = path.join(__dirname, 'fixtures', 'managed-config');
const byId = (res, id) => res.results.find((r) => r.id === id);

function binWithZn(t) {
  const bin = tempDir(t, 'zn-mw-bin-');
  for (const f of ['zn', 'zn.cmd']) fs.writeFileSync(path.join(bin, f), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

/* A stand-in %ProgramData% holding the printed Windows file at <vendor folder>/<file>. */
function programData(t, parts, fixture, edit) {
  const pd = tempDir(t, 'zn-mw-pd-');
  const file = path.join(pd, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.readFileSync(path.join(FIX, fixture), 'utf8');
  if (edit) text = edit(text);
  fs.writeFileSync(file, text);
  return { pd, file };
}

test('Cursor on Windows: the enterprise hooks.json under %ProgramData%\Cursor is read and counts as installed', async (t) => {
  const { pd, file } = programData(t, ['Cursor', 'hooks.json'], 'cursor-windows.json');
  const m = managedInstall('cursor', { platform: 'win32', env: { ProgramData: pd } });
  assert.deepEqual(m.files, [file]);
  const home = tempDir(t, 'zn-mw-home-');
  const res = await check({ home, env: { HOME: home, PATH: binWithZn(t), ProgramData: pd }, cwd: home, cursorPolicy: { platform: 'win32' } });
  const r = byId(res, 'cursor');
  assert.equal(r.state, 'protected', JSON.stringify(r));
  assert.equal(r.via, 'managed');
  assert.equal(r.managed, file);
  assert.deepEqual(r.notes.filter((n) => /failClosed/.test(n)), []);
});

test('Codex on Windows: requirements.toml under %ProgramData%\OpenAI\Codex is read and counts as installed', async (t) => {
  const { pd, file } = programData(t, ['OpenAI', 'Codex', 'requirements.toml'], 'codex-windows.toml');
  const m = managedInstall('codex', { platform: 'win32', env: { ProgramData: pd } });
  assert.deepEqual(m.files, [file]);
  const home = tempDir(t, 'zn-mw-home-');
  const res = await check({ home, env: { HOME: home, PATH: binWithZn(t), ProgramData: pd }, cwd: home, codexPolicy: { platform: 'win32' } });
  const r = byId(res, 'codex');
  assert.equal(r.state, 'protected', JSON.stringify(r));
  assert.equal(r.via, 'managed');
  assert.equal(r.managed, file);
});

test('Windows managed files in the wrong folder, or with ProgramData pointing elsewhere, are not found', async (t) => {
  const { pd } = programData(t, ['Cursor', 'hooks.json'], 'cursor-windows.json');
  const other = tempDir(t, 'zn-mw-other-');
  assert.equal(managedInstall('cursor', { platform: 'win32', env: { ProgramData: other } }), null);
  assert.equal(managedInstall('codex', { platform: 'win32', env: { ProgramData: pd } }), null);
  const home = tempDir(t, 'zn-mw-home-');
  const res = await check({ home, env: { HOME: home, PATH: binWithZn(t), ProgramData: other }, cwd: home, cursorPolicy: { platform: 'win32' }, codexPolicy: { platform: 'win32' } });
  assert.equal(byId(res, 'cursor').state, 'not-set-up');
  assert.equal(byId(res, 'codex').state, 'not-set-up');
});

test('Cursor on Windows: zn in the enterprise file without failClosed is protected but check says so', async (t) => {
  const { pd } = programData(t, ['Cursor', 'hooks.json'], 'cursor-windows.json', (s) => s.replace(/"failClosed": true/g, '"failClosed": false'));
  const home = tempDir(t, 'zn-mw-home-');
  const r = byId(await check({ home, env: { HOME: home, PATH: binWithZn(t), ProgramData: pd }, cwd: home, cursorPolicy: { platform: 'win32' } }), 'cursor');
  assert.equal(r.via, 'managed');
  assert.ok(r.notes.some((n) => /failClosed/.test(n)), JSON.stringify(r.notes));
});

test('Codex on Windows: a managed requirements.toml that has zn and turns hooks off is a finding', async (t) => {
  const { pd } = programData(t, ['OpenAI', 'Codex', 'requirements.toml'], 'codex-windows.toml', (s) => (/hooks\s*=\s*true/.test(s) ? s.replace(/hooks\s*=\s*true/, 'hooks = false') : '[features]\nhooks = false\n\n' + s));
  const home = tempDir(t, 'zn-mw-home-');
  const r = byId(await check({ home, env: { HOME: home, PATH: binWithZn(t), ProgramData: pd }, cwd: home, codexPolicy: { platform: 'win32' } }), 'codex');
  assert.equal(r.state, 'not-protected', JSON.stringify(r));
  assert.match(r.problem, /turn hooks off/);
});

test('Claude Code: a managed-settings.json that has zn and sets disableAllHooks is a finding', async (t) => {
  const root = tempDir(t, 'zn-mw-root-');
  const data = JSON.parse(fs.readFileSync(path.join(FIX, 'claude-code-windows.json'), 'utf8'));
  data.disableAllHooks = true;
  fs.writeFileSync(path.join(root, 'managed-settings.json'), JSON.stringify(data));
  const home = tempDir(t, 'zn-mw-home-');
  const r = byId(await check({ home, env: { HOME: home, PATH: binWithZn(t) }, cwd: home, claudePolicy: { managedDir: root } }), 'claude-code');
  assert.equal(r.state, 'not-protected', JSON.stringify(r));
  assert.match(r.problem, /disableAllHooks/);
});
