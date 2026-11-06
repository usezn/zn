'use strict';

// lib/reach text and JSON output for an empty project, a one-file project
// and a nested project.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { reach, report } = require('../lib/reach');
const { tempDir } = require('./helpers/tmp');

function folders(t) {
  const home = tempDir(t, 'zn-reach-out-home-');
  const root = tempDir(t, 'zn-reach-out-proj-');
  const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath) };
  return { home, root, env };
}

function textOf(r) {
  let s = '';
  const code = report(r, (x) => { s += x; });
  return { s, code };
}

const MCP = JSON.stringify({ mcpServers: { demo: { command: 'npx', args: ['-y', 'example-mcp-server'] } } });

test('empty project: text says nothing needs fixing and JSON has no findings', async (t) => {
  const { home, root, env } = folders(t);
  const r = await reach({ root, home, env });
  const { s, code } = textOf(r);
  assert.equal(code, 0);
  assert.match(s, /^\nzn-gate reach: /);
  assert.match(s, /AGENTS\n/);
  assert.match(s, /not found on this machine/);
  assert.match(s, /No supported coding agent was found on this machine, and nothing here needs fixing\./);
  const j = JSON.parse(JSON.stringify(r));
  assert.deepEqual(j.findings, []);
  assert.deepEqual(j.counts, { high: 0, medium: 0, low: 0, info: 0 });
  assert.equal(j.root, root);
});

test('one-file project: text lists the MCP section and JSON counts match', async (t) => {
  const { home, root, env } = folders(t);
  fs.writeFileSync(path.join(root, '.mcp.json'), MCP);
  const r = await reach({ root, home, env });
  const { s, code } = textOf(r);
  assert.equal(code, 0);
  assert.match(s, /MCP SERVERS \(extra tools your agent can call\)/);
  assert.match(s, /\d+ high, \d+ medium, \d+ low\.\n\n$/);
  const j = JSON.parse(JSON.stringify(r));
  assert.ok(j.findings.some((f) => f.section === 'mcp'));
  assert.equal(j.counts.high + j.counts.medium + j.counts.low + j.counts.info, j.findings.length);
  assert.ok(j.findings.every((f) => !f.file || !path.isAbsolute(f.file) || f.file.startsWith(root)));
});

test('nested project: reach run from the nested folder reports on that folder', async (t) => {
  const { home, root, env } = folders(t);
  const nested = path.join(root, 'apps', 'web');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, '.mcp.json'), MCP);
  const inner = await reach({ root: nested, home, env });
  const outer = await reach({ root, home, env });
  assert.equal(inner.root, nested);
  assert.equal(outer.root, root);
  assert.ok(inner.findings.some((f) => f.section === 'mcp'));
  const text = textOf(inner).s;
  assert.match(text, /MCP SERVERS/);
  const j = JSON.parse(JSON.stringify(inner));
  assert.equal(j.counts.high + j.counts.medium + j.counts.low + j.counts.info, j.findings.length);
  // The same text and JSON work for the outer folder, whatever it finds.
  assert.equal(textOf(outer).code, 0);
  assert.equal(JSON.parse(JSON.stringify(outer)).root, root);
});
