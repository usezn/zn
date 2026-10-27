'use strict';

// A project plugin starts `zn` by name. A program named zn in a PATH entry inside the project (which an agent can write
// to), in a node_modules folder, or a zn that links into the project must never be started. Values are fake.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const opencode = require('../lib/agents/opencode');

const posix = process.platform !== 'win32';
let n = 0;

function makeBin(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'zn');
  fs.writeFileSync(file, '#!/bin/sh\nread -r _line\necho started > "' + marker + '"\necho \'{"action":"none"}\'\n', { mode: 0o755 });
  return file;
}

// Loads the project plugin and fires one hook with the given PATH, from the given folder (the project by default).
async function fireHook(project, pathValue, directory = project) {
  const plugin = opencode.pluginSource({ scope: 'project' });
  const file = path.join(project, 'plugin' + (n++) + '.mjs');
  fs.writeFileSync(file, plugin);
  const saved = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    const mod = await import(pathToFileURL(file).href);
    const hooks = await mod.ZnGate({ directory });
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1' }, { args: { command: 'echo hi' } });
  } catch (_) {
    // A blocked call is fine here; only the marker matters.
  } finally {
    process.env.PATH = saved;
  }
}

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-oc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  return { root, project };
}

test('project plugin starts zn from a PATH entry outside the project', { skip: !posix }, async (t) => {
  const { root, project } = setup(t);
  const marker = path.join(root, 'outside-marker');
  makeBin(path.join(root, 'tools'), marker);
  await fireHook(project, path.join(root, 'tools'));
  assert.ok(fs.existsSync(marker), 'the harness starts a zn from PATH');
});

test('project plugin never starts zn from a PATH entry inside the project', { skip: !posix }, async (t) => {
  const { root, project } = setup(t);
  const marker = path.join(root, 'inside-marker');
  makeBin(path.join(project, 'bin'), marker);
  await fireHook(project, path.join(project, 'bin'));
  assert.ok(!fs.existsSync(marker), 'a zn from the project bin/ was started');
});

test('project plugin never starts zn from node_modules, through a link into the project, or from the git work tree above', { skip: !posix }, async (t) => {
  const { root, project } = setup(t);
  const marker = path.join(root, 'marker');
  // node_modules outside the project.
  makeBin(path.join(root, 'elsewhere', 'node_modules', '.bin'), marker);
  await fireHook(project, path.join(root, 'elsewhere', 'node_modules', '.bin'));
  assert.ok(!fs.existsSync(marker), 'a zn from node_modules was started');
  // A folder outside the project that links to the project's bin.
  const inside = makeBin(path.join(project, 'tools'), marker);
  fs.symlinkSync(path.dirname(inside), path.join(root, 'linked-dir'));
  await fireHook(project, path.join(root, 'linked-dir'));
  assert.ok(!fs.existsSync(marker), 'a zn reached through a linked folder was started');
  // A zn outside the project that is a link to the project's zn.
  fs.mkdirSync(path.join(root, 'out'));
  fs.symlinkSync(inside, path.join(root, 'out', 'zn'));
  await fireHook(project, path.join(root, 'out'));
  assert.ok(!fs.existsSync(marker), 'a zn that links into the project was started');
  // OpenCode opened in a sub-folder: the git work tree around it is the project.
  const sub = path.join(project, 'pkg');
  fs.mkdirSync(sub);
  await fireHook(project, path.join(project, 'tools'), sub);
  assert.ok(!fs.existsSync(marker), 'a zn from the work tree above the folder was started');
});

test('project plugin: a trusted zn after an untrusted one on the PATH is the one started', { skip: !posix }, async (t) => {
  const { root, project } = setup(t);
  const bad = path.join(root, 'bad-marker');
  const good = path.join(root, 'good-marker');
  makeBin(path.join(project, 'bin'), bad);
  makeBin(path.join(root, 'tools'), good);
  await fireHook(project, path.join(project, 'bin') + ':' + path.join(root, 'tools'));
  assert.ok(!fs.existsSync(bad), 'the project zn was started');
  assert.ok(fs.existsSync(good), 'the zn outside the project was not started');
});
