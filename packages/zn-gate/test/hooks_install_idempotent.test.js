'use strict';
// `hooks install` run twice leaves the agent's settings file byte for byte as the first run left it.
// The CLI refuses `hooks install` without an interactive terminal (exit 77, docs/cli.md), so the test
// calls the adapter directly, the same way hooks_install_uninstall_roundtrip.test.js does.
// Every path is inside temporary folders; no real config is read.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const USER_SETTINGS = '{\n  "theme": "example-theme",\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "echo example-user-hook" }] }]\n  }\n}\n';

function machine(t) {
  const home = tempDir(t, 'zn-idem-home-');
  const cwd = tempDir(t, 'zn-idem-cwd-');
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: '' } };
}

function install(m, scope) {
  return getAdapter('claude-code').install({
    scope, projectDir: m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false,
  });
}

for (const scope of ['user', 'project']) {
  test('hooks install claude-code (' + scope + ') run twice leaves the settings file byte-identical', (t) => {
    const m = machine(t);
    const file = path.join(scope === 'project' ? m.cwd : m.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, USER_SETTINGS);

    const first = install(m, scope);
    assert.equal(first.settings, file);
    const afterFirst = fs.readFileSync(file);
    assert.notEqual(afterFirst.toString('utf8'), USER_SETTINGS, 'the first install changed the file');

    install(m, scope);
    assert.ok(fs.readFileSync(file).equals(afterFirst), 'the second install changed the file');
  });
}
