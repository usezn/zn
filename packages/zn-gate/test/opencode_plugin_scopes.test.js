'use strict';
process.env.ZN_STATS = 'off';

// pluginPath and pluginSource for the user scope and the project scope: an explicit project folder,
// a relative one and none. The two scopes name a different program to start.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const opencode = require('../lib/agents/opencode');
const { tempDir } = require('./helpers/tmp');

const USER = { nodePath: '/usr/bin/node', runnerPath: '/opt/zn/lib/hooks/runner.js' };

test('pluginPath: an explicit project folder gives its .opencode/plugins file', (t) => {
  const dir = tempDir(t, 'zn-oc-scope-');
  assert.equal(opencode.pluginPath({ scope: 'project', projectDir: dir }), path.join(dir, '.opencode', 'plugins', 'zn-gate.js'));
});

test('pluginPath: a relative project folder is resolved against the current directory', () => {
  const file = opencode.pluginPath({ scope: 'project', projectDir: path.join('some', 'project') });
  assert.equal(file, path.join(process.cwd(), 'some', 'project', '.opencode', 'plugins', 'zn-gate.js'));
  assert.ok(path.isAbsolute(file));
});

test('pluginPath: no project folder means the current directory', () => {
  const expected = path.join(path.resolve(process.cwd()), '.opencode', 'plugins', 'zn-gate.js');
  assert.equal(opencode.pluginPath({ scope: 'project' }), expected);
  assert.equal(opencode.pluginPath({ scope: 'project', projectDir: '' }), expected);
});

test('pluginPath: the user scope is the default and ignores the project folder', (t) => {
  const home = tempDir(t, 'zn-oc-home-');
  const proj = tempDir(t, 'zn-oc-proj-');
  const env = {};
  const expected = path.join(home, '.config', 'opencode', 'plugins', 'zn-gate.js');
  assert.equal(opencode.pluginPath({ home, env }), expected);
  assert.equal(opencode.pluginPath({ scope: 'user', home, env, projectDir: proj }), expected);
  assert.notEqual(opencode.pluginPath({ scope: 'project', home, env, projectDir: proj }), expected);
});

test('pluginSource: the project scope starts zn from PATH, with or without a project folder', (t) => {
  const dir = tempDir(t, 'zn-oc-scope-');
  for (const o of [{ scope: 'project', projectDir: dir }, { scope: 'project', projectDir: 'relative/dir' }, { scope: 'project' }]) {
    const src = opencode.pluginSource({ ...USER, ...o });
    assert.match(src, /const NODE = "zn";/);
    assert.match(src, /\["hook", "opencode"\]/);
    assert.ok(!src.includes(USER.nodePath));
    assert.ok(!src.includes(USER.runnerPath));
  }
});

test('pluginSource: the user scope starts the given node with the given runner', () => {
  for (const o of [{ scope: 'user' }, {}]) {
    const src = opencode.pluginSource({ ...USER, ...o });
    assert.match(src, /const NODE = "\/usr\/bin\/node";/);
    assert.match(src, /const RUNNER = "\/opt\/zn\/lib\/hooks\/runner\.js";/);
    assert.ok(!/const NODE = "zn";/.test(src));
  }
});

test('pluginSource: the two scopes name a different program to start', () => {
  const user = opencode.pluginSource({ ...USER, scope: 'user' });
  const project = opencode.pluginSource({ ...USER, scope: 'project' });
  assert.notEqual(user, project);
  assert.equal(user.match(/const NODE = [^\n]*/)[0] === project.match(/const NODE = [^\n]*/)[0], false);
});
