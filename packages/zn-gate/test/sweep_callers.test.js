'use strict';

// The init guide and the Claude Code uninstall find and start programs only from absolute PATH entries: a relative
// entry (here `bin`, the project's own folder) points into the folder zn runs in, so a program placed there never runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ig = require('../lib/init-guide')._internal;
const cc = require('../lib/agents/claude-code');
const { tempDir } = require('./helpers/tmp');

const WIN = process.platform === 'win32';

// A project with a planted `claude` (and `npm`) in its bin/ that leaves a marker when it runs.
function project(t) {
  const root = tempDir(t, 'zn-sweep-');
  const proj = path.join(root, 'proj');
  const marker = path.join(root, 'ran');
  fs.mkdirSync(path.join(proj, 'bin'), { recursive: true });
  for (const name of ['claude', 'npm']) {
    const f = path.join(proj, 'bin', name);
    fs.writeFileSync(f, '#!/bin/sh\necho ran > "' + marker + '"\n', { mode: 0o755 });
  }
  const cwd = process.cwd();
  process.chdir(proj);
  t.after(() => process.chdir(cwd));
  return { root, proj, marker };
}

test('the init guide does not find a program through a relative PATH entry', { skip: WIN }, (t) => {
  project(t);
  assert.equal(ig.findProgram('claude', { PATH: 'bin' }), null);
  assert.equal(ig.findProgram('npm', { PATH: 'bin' + path.delimiter + '' }), null);
  assert.deepEqual(ig.globalInstall({ PATH: 'bin' }), {});
});

test('a program the init guide starts gets only the absolute PATH entries', { skip: WIN }, (t) => {
  project(t);
  const r = ig.spawnProgram('/bin/sh', ['-c', 'printf %s "$PATH"'], { PATH: 'bin:/usr/bin::.:/bin' }, { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '/usr/bin:/bin');
});

test('uninstall does not run a claude found through a relative PATH entry', { skip: WIN }, (t) => {
  const { root, marker } = project(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { secrets: { command: 'zn', args: ['secrets-mcp'] } } }));
  for (const env of [{ PATH: 'bin' }, undefined]) {
    // Without opts.env, the PATH of the process itself (only `bin`: a real claude must never run here).
    const saved = process.env.PATH;
    if (!env) process.env.PATH = 'bin';
    let report;
    try {
      report = cc.uninstall({ home, env });
    } finally {
      process.env.PATH = saved;
    }
    assert.equal(fs.existsSync(marker), false, 'the project claude ran');
    if (env) assert.ok(report.warnings.some((w) => /not on your PATH/.test(w)), JSON.stringify(report.warnings));
  }
});
