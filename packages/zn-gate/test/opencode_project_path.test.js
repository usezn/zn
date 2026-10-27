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

test('the project plugin never starts a zn or node from a relative or empty PATH entry', skip, async (t) => {
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
  for (const PATH of ['.:' + safe, 'bin:' + safe, ':' + safe, safe + ':']) {
    process.env.PATH = PATH;
    const hooks = await ZnGate({ directory: work });
    await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's' }, { args: { command: 'ls' } }), (err) => {
      assert.equal(err.message, safe, PATH);
      return true;
    });
    assert.equal(fs.existsSync(marker), false, PATH + ': a planted program ran');
  }
});
