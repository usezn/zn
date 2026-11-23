'use strict';
process.env.ZN_STATS = 'off';

// On case-insensitive file systems (macOS, Windows) Node_Modules/.BIN is the same folder as node_modules/.bin. The project
// hook guard and the OpenCode project plugin must refuse a zn whose real path is in such a folder, whatever the case.
// The planted zn only writes a marker file; nothing destructive is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const launcher = require('../lib/agents/launcher');
const opencode = require('../lib/agents/opencode');
const { tempDir } = require('./helpers/tmp');

const skip = { skip: process.platform === 'win32' ? 'POSIX links and sh; the Windows guard checks only the path text (see the threat model)' : false };

function whichSh() {
  for (const d of String(process.env.PATH || '').split(':')) {
    const f = path.join(d, 'sh');
    if (d && fs.existsSync(f)) return fs.realpathSync(f);
  }
  return '/bin/sh';
}

/* proj/<Node_Modules>/<.BIN>/zn (mixed case) and, outside the project, tools/zn linked to it and tools/node. */
function layout(t, nm, bin) {
  const root = fs.realpathSync(tempDir(t, 'zn-guard-case-'));
  const proj = path.join(root, 'proj');
  const planted = path.join(proj, nm, bin);
  fs.mkdirSync(planted, { recursive: true });
  const marker = path.join(root, 'marker');
  const zn = path.join(planted, 'zn');
  fs.writeFileSync(zn, '#!' + whichSh() + '\necho ran > ' + marker + '\nexit 0\n');
  fs.chmodSync(zn, 0o755);
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools);
  fs.symlinkSync(zn, path.join(tools, 'zn'));
  fs.symlinkSync(process.execPath, path.join(tools, 'node'));
  return { proj, tools, marker };
}

const forms = {
  'sh -c': () => {
    const script = launcher.projectShCommand('claude-code', 'PreToolUse').slice(6).replace(/^'|'$/g, '').replace(/'\\''/g, "'");
    return ['-c', script];
  },
  'split-on-spaces (Antigravity)': () => launcher.projectShCommand('antigravity').split(' ').slice(1),
};

for (const [name, args] of Object.entries(forms)) {
  for (const [nm, bin] of [['Node_Modules', '.BIN'], ['NODE_MODULES', '.Bin']]) {
    test('project guard, ' + name + ': a zn linked into ' + nm + '/' + bin + ' (any case) is not trusted', skip, (t) => {
      const l = layout(t, nm, bin);
      // The project folder is not the working folder here, so only the node_modules/.bin rule can refuse it.
      const r = spawnSync(whichSh(), args(), { input: '{}', encoding: 'utf8', env: { PATH: l.tools + ':/usr/bin:/bin', HOME: '/nonexistent-home' }, cwd: '/' });
      assert.equal(fs.existsSync(l.marker), false, 'the planted zn ran: ' + r.stderr);
    });
  }
}

test('OpenCode project plugin: a PATH folder whose zn really is in Node_Modules/.BIN is dropped', skip, (t) => {
  const l = layout(t, 'Node_Modules', '.BIN');
  const src = opencode.pluginSource({ scope: 'project' });
  const m = src.match(/function projectEnv\(\) \{[\s\S]*?\n\}\n/)[0];
  const env = new Function('process', 'realpathSync', 'existsSync', 'homedir', m + '; return projectEnv();')(
    { platform: 'linux', cwd: () => '/', env: { PATH: [l.tools, '/usr/bin'].join(':') } },
    fs.realpathSync, fs.existsSync, () => '/nonexistent-home');
  assert.equal(env.PATH, '/usr/bin');
});
