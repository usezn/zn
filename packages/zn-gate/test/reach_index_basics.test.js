'use strict';

// lib/reach/index.js basics: an empty project, a project with one agent
// config file, and the stable top-level keys of the JSON result.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { reach } = require('../lib/reach');
const { tempDir } = require('./helpers/tmp');

const TOP_KEYS = ['agents', 'counts', 'findings', 'root', 'tool', 'truncated', 'version'];
const AGENT_KEYS = ['fix', 'found', 'id', 'name', 'problem', 'state'];
const COUNT_KEYS = ['high', 'info', 'low', 'medium'];

function folders(t) {
  const home = tempDir(t, 'zn-reach-idx-home-');
  const root = tempDir(t, 'zn-reach-idx-proj-');
  // Only Node.js on PATH, so an agent installed on this computer is not found.
  const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath) };
  return { home, root, env };
}

test('an empty project on an empty home has no findings', async (t) => {
  const { home, root, env } = folders(t);
  const r = await reach({ root, home, env });
  assert.equal(r.root, root);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.counts, { high: 0, medium: 0, low: 0, info: 0 });
  assert.ok(r.agents.length > 0);
  assert.ok(r.agents.every((a) => a.found === false));
});

test('a project with one agent config file gets a finding about it', async (t) => {
  const { home, root, env } = folders(t);
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: 'npx', args: ['-y', 'demo-server'] } },
  }));
  const r = await reach({ root, home, env });
  assert.ok(r.findings.length > 0);
  assert.ok(r.findings.some((f) => f.section === 'mcp' && f.kind === 'audit'));
  const total = r.counts.high + r.counts.medium + r.counts.low + r.counts.info;
  assert.equal(total, r.findings.length);
});

test('the JSON result keeps the same keys', async (t) => {
  const empty = folders(t);
  const withFile = folders(t);
  fs.writeFileSync(path.join(withFile.root, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'npx' } } }));
  for (const { home, root, env } of [empty, withFile]) {
    const r = JSON.parse(JSON.stringify(await reach({ root, home, env })));
    assert.deepEqual(Object.keys(r).sort(), TOP_KEYS);
    assert.equal(r.tool, 'zn-gate reach');
    assert.equal(r.version, 1);
    assert.deepEqual(Object.keys(r.counts).sort(), COUNT_KEYS);
    for (const a of r.agents) assert.deepEqual(Object.keys(a).sort(), AGENT_KEYS);
    for (const f of r.findings) {
      assert.ok(['agents', 'reach', 'mcp', 'user', 'project'].includes(f.section));
      assert.ok(['high', 'medium', 'low', 'info'].includes(f.severity));
      assert.equal(typeof f.title, 'string');
    }
  }
});
