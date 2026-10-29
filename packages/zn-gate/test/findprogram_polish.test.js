'use strict';

// findProgram and the claude lookup of the Claude Code adapter: a program whose real file is in the home folder's
// node_modules, or in the project, is never the one zn starts, even from a PATH folder outside the project. Fake files only.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findProgram } = require('../lib/exe');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';

function script(p, marker) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n' + (marker ? 'echo ran >> ' + JSON.stringify(marker) + '\n' : '') + 'exit 0\n', { mode: 0o755 });
  return p;
}

test('findProgram: a link into the home folder node_modules is not found, also when zn runs in the home folder', { skip: !posix }, (t) => {
  const home = fs.realpathSync(tempDir(t, 'zn-fpp-home-'));
  script(path.join(home, 'node_modules', 'evil', 'cli.js'));
  const bin = path.join(fs.realpathSync(tempDir(t, 'zn-fpp-bin-')), 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(home, 'node_modules', 'evil', 'cli.js'), path.join(bin, 'claude'));
  const env = { PATH: bin, HOME: home };
  assert.equal(findProgram('claude', env, home), null);
  // A global install under a prefix in the home folder (~/.npm-global) is still found.
  const prefix = path.join(home, '.npm-global');
  script(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(prefix, 'bin', 'npm'));
  assert.equal(findProgram('npm', { PATH: path.join(prefix, 'bin'), HOME: home }, home), path.join(prefix, 'bin', 'npm'));
});

test('Claude Code install and uninstall do not run a claude that links into the project', { skip: !posix }, (t) => {
  const project = fs.realpathSync(tempDir(t, 'zn-fpp-proj-'));
  fs.mkdirSync(path.join(project, '.git'));
  const marker = path.join(fs.realpathSync(tempDir(t, 'zn-fpp-mark-')), 'ran');
  script(path.join(project, 'tools', 'claude'), marker);
  const bin = path.join(fs.realpathSync(tempDir(t, 'zn-fpp-bin2-')), 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(project, 'tools', 'claude'), path.join(bin, 'claude'));
  const home = fs.realpathSync(tempDir(t, 'zn-fpp-home2-'));
  const env = { PATH: bin, HOME: home, CLAUDE_PROJECT_DIR: project };
  const cc = getAdapter('claude-code');
  const rep = cc.install({ scope: 'user', home, env, runnerPath: '/opt/zn/lib/hooks/runner.js' });
  assert.ok(rep.warnings.some((w) => /`claude` CLI not found/.test(w)), rep.warnings.join(' | '));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { secrets: { command: process.execPath, args: [path.join(__dirname, '..', 'bin', 'cli.js'), 'secrets-mcp'] } } }));
  cc.uninstall({ scope: 'user', home, env });
  assert.equal(fs.existsSync(marker), false, 'the project claude ran');
});
