'use strict';
// `zn-gate hooks uninstall <agent>` on a machine whose agent config holds no zn entry changes no file.
// The CLI refuses hooks uninstall without an interactive terminal (docs/cli.md: "It needs an interactive
// terminal", exit 77 "refused on purpose"), so a piped run must exit 77 and touch nothing, in the user
// scope and in the project scope. Every path is inside temporary folders; no real config is read.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

// The user's own agent settings, with no zn hook in them.
const USER_SETTINGS = '{\n  "theme": "example-theme",\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "echo example-user-hook" }] }]\n  }\n}\n';
const PROJECT_SETTINGS = '{"permissions":{"allow":["Read"]}}\n';

// Every file under home and cwd, as its bytes.
function snapshot(dirs) {
  const out = {};
  const walk = (root, dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(root, p);
      else out[path.relative(root, p) + '@' + root] = fs.readFileSync(p).toString('base64');
    }
  };
  for (const d of dirs) walk(d, d);
  return out;
}

function seedMachine(t) {
  const home = tempDir(t, 'zn-hooks-noop-home-');
  const cwd = tempDir(t, 'zn-hooks-noop-cwd-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), USER_SETTINGS);
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), PROJECT_SETTINGS);
  return { home, cwd };
}

function runUninstall(m, extra) {
  return spawnSync(process.execPath, [CLI, 'hooks', 'uninstall', 'claude-code', ...extra], {
    cwd: m.cwd,
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env: { HOME: m.home, USERPROFILE: m.home, PATH: process.env.PATH, ZN_STATS: 'off', NO_COLOR: '1' },
  });
}

for (const extra of [[], ['--project']]) {
  const label = extra.length ? '--project' : 'user';
  test('hooks uninstall claude-code (' + label + ') with no zn entry refuses without a terminal and changes no file', (t) => {
    const m = seedMachine(t);
    const before = snapshot([m.home, m.cwd]);
    const r = runUninstall(m, extra);
    assert.equal(r.status, 77, 'docs: 77 = refused on purpose (no interactive terminal)');
    assert.match(r.stderr, /interactive terminal/);
    assert.deepEqual(snapshot([m.home, m.cwd]), before);
  });
}
