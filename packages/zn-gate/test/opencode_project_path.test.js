'use strict';
process.env.ZN_STATS = 'off';

// The OpenCode project plugin is shared through the repository and starts `zn` from the PATH. OpenCode runs in the project
// folder, which could hold a zn of its own: the plugin passes `zn` a PATH with only the absolute entries, so a relative or
// empty entry never selects it, and the node that zn starts is looked up the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { tempDir } = require('./helpers/tmp');

const skip = { skip: process.platform === 'win32' };

// A project folder with a zn and a node of its own (in the folder and in its bin/) that write a marker when they run, a
// "real" zn outside the project, and the project plugin loaded with OpenCode's current directory set to the project.
async function setup(t) {
  const src = require('../lib/agents/opencode').pluginSource({ scope: 'project' });
  const dir = tempDir(t, 'zn-oc-path-');
  const file = path.join(dir, 'zn-gate.mjs');
  fs.writeFileSync(file, src);
  const work = tempDir(t, 'zn-oc-work-');
  const marker = path.join(work, 'planted-ran');
  fs.mkdirSync(path.join(work, 'bin'));
  for (const d of [work, path.join(work, 'bin')]) {
    for (const n of ['zn', 'node']) fs.writeFileSync(path.join(d, n), '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\necho \'{"action":"none"}\'\n', { mode: 0o755 });
  }
  // The real zn: prints its PATH back as the deny message, so the test sees what it was given (builtins only: that PATH has no /bin).
  const safe = tempDir(t, 'zn-oc-safe-');
  fs.writeFileSync(path.join(safe, 'zn'), '#!/bin/sh\nwhile IFS= read -r _; do :; done\nprintf \'{"action":"deny","message":"%s"}\' "$PATH"\n', { mode: 0o755 });
  const { ZnGate } = await import(pathToFileURL(file).href);
  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  t.after(() => { process.env.PATH = oldPath; process.chdir(oldCwd); });
  process.chdir(work);
  return { ZnGate, work, marker, safe };
}

// Runs one bash tool call with the given PATH: the real zn must answer, with a PATH of only `safe`, and the marker stays absent.
async function expectSafeZn({ ZnGate, work, marker, safe }, PATH) {
  process.env.PATH = PATH;
  const hooks = await ZnGate({ directory: work });
  await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's' }, { args: { command: 'ls' } }), (err) => {
    assert.equal(err.message, safe, PATH);
    return true;
  });
  assert.equal(fs.existsSync(marker), false, PATH + ': a planted program ran');
}

test('the project plugin never starts a zn or node from a relative or empty PATH entry', skip, async (t) => {
  const s = await setup(t);
  for (const PATH of ['.:' + s.safe, 'bin:' + s.safe, ':' + s.safe, s.safe + ':']) await expectSafeZn(s, PATH);
});

// An absolute PATH entry can point inside the project too (a bin/ the project ships, or the project folder itself).
test('the project plugin never starts a zn or node from an absolute PATH entry inside the project', {
  ...skip,
  todo: 'known gap: absolute PATH entries inside the project folder are still kept',
}, async (t) => {
  const s = await setup(t);
  for (const PATH of [path.join(s.work, 'bin') + ':' + s.safe, s.work + ':' + s.safe, s.work + '/:' + s.safe]) await expectSafeZn(s, PATH);
});
