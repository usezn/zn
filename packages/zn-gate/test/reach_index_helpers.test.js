'use strict';

// The small helpers of lib/reach/index.js (the home-folder display form, the
// singular/plural wording and the agent list) are not exported, so these tests
// check them through the result of reach(). Fake values and temporary folders only.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { reach } = require('../lib/reach');
const { tempDir } = require('./helpers/tmp');

function machine(t) {
  const home = tempDir(t, 'zn-reach-helpers-home-');
  const root = tempDir(t, 'zn-reach-helpers-proj-');
  // Only Node.js on PATH, so an agent installed on this computer is not found by the test.
  const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath) };
  return { home, root, env };
}

const run = (m) => reach({ root: m.root, home: m.home, env: m.env });
const kind = (r, k) => r.findings.find((f) => f.kind === k);

test('a credential file under home is shown with a tilde and forward slashes', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.home, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(m.home, '.aws', 'credentials'), '[default]\naws_secret_access_key = zn-test-fake-not-real\n');
  const f = kind(await run(m), 'credential-files');
  assert.deepEqual(f.files.map((c) => c.path), ['~/.aws/credentials']);
  assert.ok(!f.title.includes(m.home));
  assert.match(f.title, /^1 credential file in your home folder \(~\/\.aws\/credentials\)$/);
});

test('a file outside home keeps its plain name and gets no tilde', async (t) => {
  const m = machine(t);
  fs.writeFileSync(path.join(m.root, '.env'), 'EXAMPLE_TOKEN=zn-test-fake-value-0000-not-real\n');
  const f = kind(await run(m), 'dotenv');
  assert.equal(f.file, '.env');
  assert.ok(!f.title.includes('~'));
  assert.ok(!f.title.includes(m.root));
});

test('zero items add no finding, one is singular, two is plural', async (t) => {
  const m = machine(t);
  assert.equal(kind(await run(m), 'dotenv'), undefined);
  assert.equal(kind(await run(m), 'credential-files'), undefined);
  assert.equal(kind(await run(m), 'environment'), undefined);

  fs.writeFileSync(path.join(m.root, '.env'), 'EXAMPLE_TOKEN=zn-test-fake-value-0000-not-real\n');
  assert.match(kind(await run(m), 'dotenv').title, /has 1 secret \(/);

  fs.writeFileSync(path.join(m.root, '.env'), 'EXAMPLE_TOKEN=zn-test-fake-value-0000-not-real\nOTHER_PASSWORD=zn-test-fake-value-0001-not-real\n');
  assert.match(kind(await run(m), 'dotenv').title, /has 2 secrets \(/);

  m.env.EXAMPLE_A_TOKEN = 'zn-test-fake-value-0002-not-real';
  assert.match(kind(await run(m), 'environment').title, /^1 environment variable with a secret \(/);
  m.env.EXAMPLE_B_TOKEN = 'zn-test-fake-value-0003-not-real';
  assert.match(kind(await run(m), 'environment').title, /^2 environment variables with a secret \(/);

  fs.mkdirSync(path.join(m.home, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(m.home, '.aws', 'credentials'), '[default]\naws_secret_access_key = zn-test-fake-not-real\n');
  fs.writeFileSync(path.join(m.home, '.netrc'), 'machine example.com login fake password zn-test-fake-not-real\n');
  assert.match(kind(await run(m), 'credential-files').title, /^2 credential files in your home folder \(/);
});

test('the agent list has one entry per adapter and none is found on an empty home', async (t) => {
  const r = await run(machine(t));
  assert.ok(r.agents.length > 1);
  for (const a of r.agents) {
    assert.deepEqual(Object.keys(a).sort(), ['fix', 'found', 'id', 'name', 'problem', 'state']);
    assert.equal(a.found, false);
    assert.equal(typeof a.problem, 'string');
    assert.equal(typeof a.fix, 'string');
  }
  assert.equal(new Set(r.agents.map((a) => a.id)).size, r.agents.length);
});

test('an agent whose folder exists in home is listed as found and not set up', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.home, '.cursor'), { recursive: true });
  const r = await run(m);
  const found = r.agents.filter((a) => a.found);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'cursor');
  assert.equal(found[0].state, 'not-set-up');
  assert.ok(r.findings.some((f) => f.section === 'agents' && f.severity === 'high'));
});
