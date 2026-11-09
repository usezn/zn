'use strict';
/*
 * Two agents installed in the same temporary home: uninstalling one removes only its own entry. The other agent's
 * hook file must come back byte for byte as it was before the uninstall. Adapter-level calls, as in
 * hooks_install_uninstall_roundtrip.test.js (the CLI needs a terminal). Every path is inside temporary folders.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
// Every zn hook command points into zn's own folder (.zn/hooks), whatever the agent.
const ZN_HOOK = /\.zn[\\/]hooks[\\/]/;

function machine(t) {
  const home = tempDir(t, 'zn-iso-home-');
  const cwd = tempDir(t, 'zn-iso-cwd-');
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: '' } };
}

function call(m, id, fn) {
  return getAdapter(id)[fn]({ scope: 'user', projectDir: m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
}

// The agent's settings file as a path relative to the home folder: found by a scratch install, as the roundtrip test does.
function relativeSettings(t, id) {
  const probe = machine(t);
  return path.relative(probe.home, call(probe, id, 'install').settings);
}

test('uninstalling codex leaves the claude-code hook file byte-identical', (t) => {
  const ccRel = relativeSettings(t, 'claude-code');
  const cxRel = relativeSettings(t, 'codex');
  assert.notEqual(ccRel, cxRel, 'the two agents have separate settings files');

  const m = machine(t);
  const ccFile = path.join(m.home, ccRel);
  const cxFile = path.join(m.home, cxRel);

  // Both agents installed in the same home.
  call(m, 'claude-code', 'install');
  call(m, 'codex', 'install');
  assert.ok(fs.existsSync(ccFile), 'claude-code settings written');
  assert.ok(ZN_HOOK.test(fs.readFileSync(cxFile, 'utf8')), 'codex entry present before the uninstall');

  const ccBefore = fs.readFileSync(ccFile);
  const rep = call(m, 'codex', 'uninstall');
  assert.ok(rep.removed > 0, 'the codex entry was removed');

  assert.ok(fs.readFileSync(ccFile).equals(ccBefore), 'claude-code hook file is byte-identical after the codex uninstall');
  const cxAfter = fs.existsSync(cxFile) ? fs.readFileSync(cxFile, 'utf8') : '';
  assert.ok(!ZN_HOOK.test(cxAfter), 'no zn hook left in the codex file');
});

test('uninstalling claude-code leaves the codex hook file byte-identical', (t) => {
  const ccRel = relativeSettings(t, 'claude-code');
  const cxRel = relativeSettings(t, 'codex');
  const m = machine(t);
  const ccFile = path.join(m.home, ccRel);
  const cxFile = path.join(m.home, cxRel);

  call(m, 'claude-code', 'install');
  call(m, 'codex', 'install');
  const cxBefore = fs.readFileSync(cxFile);

  const rep = call(m, 'claude-code', 'uninstall');
  assert.ok(rep.removed > 0, 'the claude-code entry was removed');

  assert.ok(fs.readFileSync(cxFile).equals(cxBefore), 'codex hook file is byte-identical after the claude-code uninstall');
  assert.ok(!ZN_HOOK.test(fs.existsSync(ccFile) ? fs.readFileSync(ccFile, 'utf8') : ''), 'no zn hook left in the claude-code file');
});
