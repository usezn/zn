'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// A project install is shared through the repository, so the MCP server it
// suggests names zn on the PATH, never the Node.js or zn-gate paths of the
// machine that ran the install. A user install keeps the absolute paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const NODE = '/opt/node-of-this-machine/bin/node';

function hint(id, scope, t) {
  const dir = tempDir(t, 'zn-mcphint-');
  const opts = { scope, projectDir: dir, home: dir, env: { HOME: dir, PATH: '' }, nodePath: NODE };
  const report = getAdapter(id).install(opts);
  const line = report.warnings.find((w) => w.startsWith('optional: to let'));
  assert.ok(line, id + ' suggests the secrets MCP server');
  return JSON.parse(line.slice(line.indexOf('"secrets": ') + '"secrets": '.length).replace(/ \(everyone who uses the project needs zn on their PATH\)$/, ''));
}

test('Cursor: a project install suggests zn on the PATH in the project mcp.json', (t) => {
  assert.deepEqual(hint('cursor', 'project', t), { command: 'zn', args: ['secrets-mcp', '--agent', 'cursor'] });
});

test('OpenCode: a project install suggests zn on the PATH in the project opencode.json', (t) => {
  assert.deepEqual(hint('opencode', 'project', t), { type: 'local', command: ['zn', 'secrets-mcp', '--agent', 'opencode'] });
});

test('user installs keep the absolute Node.js path', (t) => {
  assert.equal(hint('cursor', 'user', t).command, NODE);
  assert.equal(hint('opencode', 'user', t).command[0], NODE);
});
